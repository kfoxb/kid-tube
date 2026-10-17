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
const settings = { maxVideosPerChannel: 200, includeShorts: false, ...allowlist.settings };
const blocked = new Set((allowlist.blockedVideos ?? []).map(parseVideoId));

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

// Accepts "@handle", "UC…" ids, or any youtube.com channel URL.
function parseChannel(entry) {
  const s = entry.trim();
  const id = s.match(/(?:^|\/)(UC[\w-]{22})(?=$|[/?#])/);
  if (id) return { id: id[1] };
  const handle = s.match(/@([^/?#\s]+)/);
  if (handle) return { forHandle: '@' + decodeURIComponent(handle[1]) };
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

async function videoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const page = await api('videos', {
      part: 'snippet,contentDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: 50,
    });
    out.push(...page.items);
  }
  return out;
}

function playable(v) {
  return v.status.privacyStatus !== 'private'
    && v.status.uploadStatus === 'processed'
    && v.status.embeddable
    && v.snippet.liveBroadcastContent === 'none'
    && v.contentDetails.contentRating?.ytRating !== 'ytAgeRestricted';
}

const errors = [];
const channels = [];
const wanted = new Set();

for (const entry of allowlist.channels ?? []) {
  try {
    const { items = [] } = await api('channels', { part: 'snippet,contentDetails', ...parseChannel(entry) });
    const ch = items[0];
    if (!ch) throw new Error('channel not found');
    if (channels.some(c => c.id === ch.id)) continue;

    let ids;
    if (!settings.includeShorts) {
      // "UULF…" playlists hold a channel's regular uploads without Shorts or streams.
      // It isn't documented, so fall back to all uploads if it ever stops working.
      try {
        ids = await playlistVideoIds('UULF' + ch.id.slice(2), settings.maxVideosPerChannel);
      } catch (err) {
        if (err.status !== 404) throw err;
        console.warn(`  ${ch.snippet.title}: no Shorts-free list, using all uploads`);
      }
    }
    ids ??= await playlistVideoIds(ch.contentDetails.relatedPlaylists.uploads, settings.maxVideosPerChannel);

    channels.push({ id: ch.id, title: ch.snippet.title, avatar: ch.snippet.thumbnails?.default?.url ?? '' });
    ids.forEach(id => wanted.add(id));
    console.log(`${ch.snippet.title}: ${ids.length} uploads`);
  } catch (err) {
    errors.push(`Channel "${entry}": ${err.message}`);
  }
}

for (const entry of allowlist.videos ?? []) {
  try {
    wanted.add(parseVideoId(entry));
  } catch (err) {
    errors.push(err.message);
  }
}

if (errors.length) {
  console.error('\nFix these in allowlist.json:\n' + errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}

for (const id of blocked) wanted.delete(id);

const details = await videoDetails([...wanted]);
const channelIds = new Set(channels.map(c => c.id));
const videos = details.filter(playable).map(v => ({
  id: v.id,
  title: v.snippet.title,
  channelId: v.snippet.channelId,
  channelTitle: v.snippet.channelTitle,
  // Videos listed on their own, from channels not in the allowlist, are grouped together.
  source: channelIds.has(v.snippet.channelId) ? v.snippet.channelId : 'extra',
  publishedAt: v.snippet.publishedAt,
  duration: seconds(v.contentDetails.duration),
})).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

const skipped = wanted.size - videos.length;
if (skipped) console.log(`Skipped ${skipped} videos that are private, live, age-restricted, or not embeddable.`);

await writeFile(
  new URL('site/videos.json', root),
  JSON.stringify({ generatedAt: new Date().toISOString(), channels, videos }),
);
console.log(`Wrote ${videos.length} videos from ${channels.length} channels.`);
