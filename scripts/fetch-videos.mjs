#!/usr/bin/env node
// Reads allowlist.json, asks the YouTube Data API for each channel's uploads
// and each listed video, and writes site/videos.json for the web app.
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YOUTUBE_API_KEY;
const root = new URL('../', import.meta.url);

if (!KEY) {
  console.error('Set YOUTUBE_API_KEY first.');
  process.exit(1);
}

const allowlist = JSON.parse(await readFile(new URL('allowlist.json', root), 'utf8'));
const settings = { maxVideosPerChannel: 100, includeShorts: false, ...allowlist.settings };

// Things worth fixing in allowlist.json that shouldn't stop the rest of the site from updating.
// They're printed here and listed in the site footer.
const problems = [];

async function api(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  url.search = new URLSearchParams({ ...params, key: KEY });
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${endpoint}: ${body.error?.message ?? `HTTP ${res.status}`}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Runs fn over items, at most `limit` at a time.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

// A channel entry is either a string (an @handle, a UC… id, or a channel URL)
// or an object with id and/or handle plus optional category, ages, and note.
function parseChannel(entry) {
  if (typeof entry === 'object') return { ...entry, id: entry.id?.trim(), handle: entry.handle?.trim() };
  const s = entry.trim();
  const id = s.match(/(?:^|\/)(UC[\w-]{22})(?=$|[/?#])/);
  if (id) return { id: id[1] };
  const handle = s.match(/@([^/?#\s]+)/);
  if (handle) return { handle: '@' + decodeURIComponent(handle[1]) };
  throw new Error(`Can't read channel "${entry}". Use an @handle, a UC… channel id, or a channel URL.`);
}

// Accepts a bare 11-character id or any common video URL shape.
function parseVideoId(entry) {
  const s = entry.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  if (m) return m[1];
  throw new Error(`Can't read video "${entry}". Use a video id or URL.`);
}

function seconds(iso) {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const [d, h, min, s] = m.slice(1).map(n => Number(n ?? 0));
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

// Looks channels up by id in batches of 50, falling back to the handle for any
// entry without an id or whose id didn't match a channel.
async function resolveChannels(entries) {
  const found = new Map();
  for (const batch of chunks(entries.filter(e => e.id).map(e => e.id), 50)) {
    const { items = [] } = await api('channels', { part: 'snippet,contentDetails', id: batch.join(','), maxResults: 50 });
    for (const ch of items) found.set(ch.id, ch);
  }
  return mapLimit(entries, 8, async e => {
    if (e.id && found.has(e.id)) return found.get(e.id);
    if (e.handle) {
      const { items = [] } = await api('channels', { part: 'snippet,contentDetails', forHandle: e.handle });
      if (items[0]) return items[0];
    }
    problems.push(`Channel not found: ${e.name ?? e.handle ?? e.id}`);
    return null;
  });
}

async function playlistVideoIds(playlistId, max) {
  const ids = [];
  let pageToken;
  do {
    const page = await api('playlistItems', {
      part: 'contentDetails', playlistId, maxResults: 50, ...(pageToken && { pageToken }),
    });
    ids.push(...page.items.map(i => i.contentDetails.videoId));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

async function uploads(ch) {
  if (!settings.includeShorts) {
    // "UULF…" playlists hold a channel's regular uploads without Shorts or streams.
    // It isn't documented, so fall back to all uploads if it ever stops working.
    try {
      return await playlistVideoIds('UULF' + ch.id.slice(2), settings.maxVideosPerChannel);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  try {
    return await playlistVideoIds(ch.contentDetails.relatedPlaylists.uploads, settings.maxVideosPerChannel);
  } catch (err) {
    // Channels with no public uploads have no uploads playlist.
    if (err.status === 404) return [];
    throw err;
  }
}

function playable(v) {
  return v.status.privacyStatus !== 'private'
    && v.status.uploadStatus === 'processed'
    && v.status.embeddable
    && v.snippet.liveBroadcastContent === 'none'
    && v.contentDetails.contentRating?.ytRating !== 'ytAgeRestricted';
}

function parseAll(list, parse) {
  return (list ?? []).flatMap(entry => {
    try {
      return [parse(entry)];
    } catch (err) {
      problems.push(err.message);
      return [];
    }
  });
}

// "channels" include their recent uploads; "curateByVideo" channels only show
// the videos listed under "videos", but still get a category and a channel page.
const fullEntries = parseAll(allowlist.channels, parseChannel);
const curatedEntries = parseAll(allowlist.curateByVideo, parseChannel);
const videoEntries = parseAll(allowlist.videos, e => (typeof e === 'object'
  ? { id: parseVideoId(e.id ?? e.url), category: e.category }
  : { id: parseVideoId(e) }));
const blocked = new Set(parseAll(allowlist.blockedVideos, parseVideoId));

const entries = [...fullEntries, ...curatedEntries];
const resolved = await resolveChannels(entries);

const channels = new Map();
// video id -> { from: channel whose uploads listed it } or { category } from allowlist "videos".
// Uploads can include videos owned by another channel (an artist's VEVO channel, say),
// so videos are grouped under the channel they were listed by, not their owner.
const wanted = new Map();
const uploadLists = await mapLimit(resolved.slice(0, fullEntries.length), 8, ch => (ch ? uploads(ch) : []));

resolved.forEach((ch, i) => {
  if (!ch || channels.has(ch.id)) return;
  const e = entries[i];
  channels.set(ch.id, {
    id: ch.id,
    title: ch.snippet.title,
    avatar: ch.snippet.thumbnails?.medium?.url ?? ch.snippet.thumbnails?.default?.url ?? '',
    category: e.category ?? 'Other',
    ...(e.ages && { ages: e.ages }),
  });
  if (i < fullEntries.length) {
    for (const id of uploadLists[i]) wanted.set(id, { from: ch.id });
    console.log(`${ch.snippet.title}: ${uploadLists[i].length} uploads`);
  }
});
for (const v of videoEntries) wanted.set(v.id, { ...wanted.get(v.id), category: v.category });
for (const id of blocked) wanted.delete(id);

const pages = await mapLimit(chunks([...wanted.keys()], 50), 8, ids =>
  api('videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: 50 }));
const details = pages.flatMap(p => p.items);

const videos = details.filter(playable).map(v => {
  const listed = wanted.get(v.id);
  const channel = channels.get(listed.from ?? v.snippet.channelId);
  return {
    id: v.id,
    title: v.snippet.title,
    channelId: v.snippet.channelId,
    channelTitle: channel?.title ?? v.snippet.channelTitle,
    // Videos listed on their own, from channels not in the allowlist, are grouped together.
    source: channel ? channel.id : 'extra',
    category: listed.category ?? channel?.category ?? 'Other',
    publishedAt: v.snippet.publishedAt,
    duration: seconds(v.contentDetails.duration),
  };
}).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

const skipped = wanted.size - videos.length;
if (skipped) console.log(`Skipped ${skipped} videos that are private, live, age-restricted, or not embeddable.`);

await writeFile(
  new URL('site/videos.json', root),
  JSON.stringify({ generatedAt: new Date().toISOString(), problems, channels: [...channels.values()], videos }),
);
console.log(`Wrote ${videos.length} videos from ${channels.size} channels.`);
if (problems.length) console.warn(`\nCheck allowlist.json:\n${problems.map(p => `  - ${p}`).join('\n')}`);
