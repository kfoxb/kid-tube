// Kid Tube: plays only the videos in videos.json, which is built from allowlist.json.
'use strict';

const HISTORY_KEY = 'kidtube.history';
const HISTORY_MAX = 200;
const SAVED_KEY = 'kidtube.watchlist';
const PAGE_SIZE = 60;
const ROW_SIZE = 12;
const SAVE_EVERY_MS = 5000;

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const search = $('#search');
const chips = $('#chips');

let data = { channels: [], videos: [] };
let byId = new Map();
let shown = PAGE_SIZE;
let player = null;
let ticker = null;
let watchToken = 0;

const icons = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  replay: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
  back10: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16" font-size="7" text-anchor="middle" font-weight="700">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16" font-size="7" text-anchor="middle" font-weight="700">10</text></svg>',
  volume: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm18.4 6L19 12.6 21.4 10 20 8.6l-2.4 2.4-2.4-2.4L13.8 10l2.4 2.6-2.4 2.4 1.4 1.4 2.4-2.4 2.4 2.4z"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2zm0 15-5-2.2L7 18V5h10z"/></svg>',
  saved: '<svg viewBox="0 0 24 24"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>',
  exitFull: '<svg viewBox="0 0 24 24"><path d="M8 5h2v5H5V8h3zm6 0h2v3h3v2h-5zM5 14h5v5H8v-3H5zm9 0h5v2h-3v3h-2z"/></svg>',
};

// ---------- helpers ----------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// A still from the video itself rather than the uploader's (often click-bait) thumbnail.
// YouTube keeps frames from roughly 1/4 (…1.jpg) and 3/4 (…3.jpg) of the way through.
// The 1/2 frame (…2.jpg) is skipped because it's sometimes replaced by the custom thumbnail.
function frameImg(id, size, className = '') {
  const url = n => `https://i.ytimg.com/vi/${id}/${size}${n}.jpg`;
  return `<img class="${className}" src="${url(3)}" data-fallback="${url(1)}" alt="" loading="lazy">`;
}

// Missing frames come back as a 120x90 grey placeholder, sometimes with a 200 status.
function onFrameFailed(img) {
  if (img.dataset.fallback) {
    img.src = img.dataset.fallback;
    delete img.dataset.fallback;
  } else {
    img.classList.add('no-frame');
  }
}

document.addEventListener('error', e => {
  if (e.target.matches?.('img[src*="i.ytimg.com"]')) onFrameFailed(e.target);
}, true);

document.addEventListener('load', e => {
  const img = e.target;
  if (img.matches?.('img[src*="i.ytimg.com"]') && img.naturalWidth <= 120) onFrameFailed(img);
}, true);

function fmtTime(total) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function sourceTitle(source) {
  if (source === 'extra') return 'More videos';
  return data.channels.find(c => c.id === source)?.title ?? '';
}

// ---------- watch history (kept on this device only) ----------

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {}
}

function recordProgress(id, position, duration) {
  remember(id);
  const list = loadHistory().filter(h => h.id !== id);
  list.unshift({ id, position: Math.floor(position), duration: Math.floor(duration), at: Date.now() });
  saveHistory(list);
}

const historyMap = () => new Map(loadHistory().map(h => [h.id, h]));

// ---------- channel playlist files ----------

// Each channel's playlists, and the older videos only they contain, live in
// channels/<id>.json and load when the channel is opened (videos.json would be
// several megabytes otherwise). Saved or watched videos from those files are
// remembered on this device so Home can show them without loading the file.
const KNOWN_KEY = 'kidtube.known';
const channelFiles = new Map(); // channel id -> Promise of the file
const loadedFiles = new Map(); // channel id -> the file, once loaded
let known = {};

function loadChannelFile(id) {
  if (!channelFiles.has(id)) {
    const empty = { playlists: [], videos: [] };
    channelFiles.set(id, fetch(`channels/${encodeURIComponent(id)}.json`, { cache: 'no-cache' })
      .then(res => (res.ok ? res.json() : empty))
      .catch(() => empty)
      .then(file => {
        for (const v of file.videos) if (!byId.has(v.id)) byId.set(v.id, { ...v, fromPlaylist: true });
        loadedFiles.set(id, file);
        return file;
      }));
  }
  return channelFiles.get(id);
}

function remember(id) {
  const v = byId.get(id);
  if (!v?.fromPlaylist || known[id]) return;
  known[id] = v;
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(known));
  } catch {}
}

// Remembered videos only count while their channel is still on the list.
function getVideo(id) {
  if (byId.has(id)) return byId.get(id);
  const v = known[id];
  return v && data.channels.some(c => c.id === v.source) ? v : undefined;
}

// ---------- watchlist (also kept on this device only) ----------

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY)) ?? [];
  } catch {
    return [];
  }
}

function toggleSaved(id) {
  remember(id);
  const list = loadSaved();
  const next = list.includes(id) ? list.filter(x => x !== id) : [id, ...list];
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  } catch {}
}

function saveButton(id, saved, onWatchPage = false) {
  const label = saved ? 'Remove from watchlist' : 'Add to watchlist';
  const text = onWatchPage ? `<span>${saved ? 'Saved' : 'Save'}</span>` : '';
  return `<button class="save-btn${onWatchPage ? ' save-watch' : ''}${saved ? ' saved' : ''}"
    data-action="save" data-id="${id}" aria-label="${label}" title="${label}">${saved ? icons.saved : icons.save}${text}</button>`;
}

function updateSaveButtons(id) {
  const saved = loadSaved().includes(id);
  for (const btn of document.querySelectorAll(`.save-btn[data-id="${id}"]`)) {
    btn.outerHTML = saveButton(id, saved, btn.classList.contains('save-watch'));
  }
}
const inProgress = h => h.position > 10 && h.position < h.duration - 20;

// ---------- list views ----------

function card(v, hist, saved) {
  const h = hist.get(v.id);
  const pct = h?.duration ? Math.min(100, (h.position / h.duration) * 100) : 0;
  // Playlist-only videos carry their channel so the watch page can load its file.
  return `<a class="card" href="#/watch/${v.id}${v.fromPlaylist ? `/${encodeURIComponent(v.source)}` : ''}">
    <div class="thumb">
      ${frameImg(v.id, 'mq')}
      <span class="duration">${fmtTime(v.duration)}</span>
      ${pct ? `<span class="watched" style="width:${pct}%"></span>` : ''}
      ${saveButton(v.id, saved.has(v.id))}
    </div>
    <div class="card-title">${esc(v.title)}</div>
    <div class="card-channel">${esc(v.channelTitle)}</div>
  </a>`;
}

// Random order stays put until "Shuffle" is pressed, so rows don't jump around
// every time the kids come back from a video.
let randomRank = new Map();
function rank(v) {
  if (!randomRank.has(v.id)) randomRank.set(v.id, Math.random());
  return randomRank.get(v.id);
}

function grid(videos, hist) {
  const saved = new Set(loadSaved());
  return `<div class="grid">${videos.map(v => card(v, hist, saved)).join('')}</div>`;
}

function row(heading, videos, hist, action = '') {
  if (!videos.length) return '';
  const saved = new Set(loadSaved());
  return `<section>
    <div class="list-head"><h2>${esc(heading)}</h2>${action}</div>
    <div class="row">${videos.map(v => card(v, hist, saved)).join('')}</div>
  </section>`;
}

// Lists stay in the order given; videos.json is already newest first.
function showList(heading, videos, { top = '', emptyText = 'No videos here yet.' } = {}) {
  const hist = historyMap();
  const q = search.value.trim().toLowerCase();
  const list = q
    ? videos.filter(v => `${v.title} ${v.channelTitle}`.toLowerCase().includes(q))
    : videos;

  let body;
  if (!list.length) {
    body = `<p class="empty">${q ? 'Nothing matches that search.' : emptyText}</p>`;
  } else {
    body = grid(list.slice(0, shown), hist);
    if (list.length > shown) body += '<button class="more" data-action="more">Show more</button>';
  }
  const title = q ? `Results for “${search.value.trim()}”` : heading;
  view.innerHTML = `${q ? '' : top}
    <h2>${esc(title)}</h2>
    ${body}`;
}

function showHome() {
  const hist = historyMap();
  const history = loadHistory();
  const shuffled = [...data.videos].sort((a, b) => rank(a) - rank(b));
  const watchlist = loadSaved().map(getVideo).filter(Boolean);

  const resume = history.filter(inProgress).map(h => getVideo(h.id)).filter(Boolean).slice(0, ROW_SIZE);

  // Random videos they haven't watched yet, topped up with watched ones if they've seen nearly everything.
  const unseen = shuffled.filter(v => !hist.has(v.id));
  const picks = [...unseen, ...shuffled.filter(v => hist.has(v.id))].slice(0, ROW_SIZE);

  const top = row('Watchlist', watchlist, hist)
    + row('Keep watching', resume, hist)
    + row('Random picks', picks, hist, '<button class="pill" data-action="shuffle">Shuffle</button>');
  showList('All videos', data.videos, { top });
}

const catHref = cat => `#/cat/${encodeURIComponent(cat)}`;
const channelHref = key => `#/c/${encodeURIComponent(key)}`;

// Categories in the order they first appear in allowlist.json, leaving out empty ones.
function categories() {
  const used = new Set(data.videos.map(v => v.category));
  return [...new Set([...data.channels.map(c => c.category), 'Other'])].filter(c => used.has(c));
}

// Channels (plus the "More videos" group of standalone videos) that have at least one video.
function channelList() {
  const counts = new Map();
  for (const v of data.videos) counts.set(v.source, (counts.get(v.source) ?? 0) + 1);
  return [
    ...data.channels.map(c => ({ key: c.id, title: c.title, avatar: c.avatar, category: c.category, ages: c.ages })),
    { key: 'extra', title: 'More videos', avatar: '', category: 'Other' },
  ]
    .map(s => ({ ...s, count: counts.get(s.key) ?? 0 }))
    .filter(s => s.count)
    .sort((a, b) => a.title.localeCompare(b.title));
}

const avatar = s => (s.avatar
  ? `<img src="${esc(s.avatar)}" alt="" loading="lazy">`
  : `<span class="avatar-blank">${esc(s.title[0])}</span>`);

// A channel's page: all its videos (newest first) or one of its playlists (in the channel's order).
function showChannel(source, playlistId) {
  const channel = channelList().find(s => s.key === source);
  if (data.channels.find(c => c.id === source)?.hasPlaylists && !loadedFiles.has(source)) {
    // Show the newest videos now; redraw with the playlists once they arrive.
    const hash = location.hash;
    loadChannelFile(source).then(() => {
      if (location.hash === hash) route();
    });
  }
  const file = loadedFiles.get(source);
  const playlists = file?.playlists ?? [];
  const playlist = playlists.find(p => p.id === playlistId);

  const tabs = playlists.length ? `<div class="playlist-tabs">
      <a class="pill${playlist ? '' : ' active'}" href="${channelHref(source)}">All videos</a>
      ${playlists.map(p => `<a class="pill${p === playlist ? ' active' : ''}"
        href="${channelHref(source)}/${encodeURIComponent(p.id)}">${esc(p.title)}</a>`).join('')}
    </div>` : '';
  const top = `${channel ? `<a class="crumb" href="${catHref(channel.category)}">‹ ${esc(channel.category)}</a>` : ''}
    <h1 class="page-title">${esc(sourceTitle(source) || 'Videos')}</h1>${tabs}`;

  // "All videos" is the newest uploads followed by the older ones from playlists.
  const videos = playlist
    ? playlist.videos.map(id => byId.get(id)).filter(Boolean)
    : [...data.videos.filter(v => v.source === source), ...(file?.videos ?? []).map(v => byId.get(v.id))];
  showList(playlist ? playlist.title : 'All videos', videos, { top });
}

function showCategory(cat) {
  const strip = channelList().filter(s => s.category === cat).map(s =>
    `<a class="mini-channel" href="${channelHref(s.key)}">${avatar(s)}<span>${esc(s.title)}</span></a>`).join('');
  const top = `<h1 class="page-title">${esc(cat)}</h1><div class="channel-strip">${strip}</div>`;
  showList('Newest videos', data.videos.filter(v => v.category === cat), { top });
}

function showChannels() {
  const q = search.value.trim().toLowerCase();
  const all = channelList().filter(s => s.title.toLowerCase().includes(q));
  const groups = categories()
    .map(cat => ({ cat, list: all.filter(s => s.category === cat) }))
    .filter(g => g.list.length);
  const tile = s => `<a class="channel-card" href="${channelHref(s.key)}">
      ${avatar(s)}
      <span class="channel-name">${esc(s.title)}</span>
      <span class="channel-count">${s.count} video${s.count === 1 ? '' : 's'}${s.ages ? ` · ages ${esc(s.ages)}` : ''}</span>
    </a>`;
  view.innerHTML = `<h1 class="page-title">Channels</h1>${groups.length
    ? groups.map(g => `<section>
        <a class="group-head" href="${catHref(g.cat)}"><h2>${esc(g.cat)}</h2><span>All ${esc(g.cat)} videos ›</span></a>
        <div class="channel-grid">${g.list.map(tile).join('')}</div>
      </section>`).join('')
    : '<p class="empty">No channels match that search.</p>'}`;
}

function showHistory() {
  const videos = loadHistory().map(h => getVideo(h.id)).filter(Boolean);
  const top = videos.length ? '<button class="more clear" data-action="clear-history">Clear history</button>' : '';
  showList('Watched', videos, { top, emptyText: 'Nothing watched yet.' });
}

function renderChips() {
  chips.innerHTML = [
    '<a class="chip" href="#/">Home</a>',
    '<a class="chip" href="#/channels">Channels</a>',
    '<a class="chip" href="#/history">Watched</a>',
    '<span class="chip-divider"></span>',
    ...categories().map(cat => `<a class="chip" href="${catHref(cat)}">${esc(cat)}</a>`),
  ].join('');
}

function markActiveChip() {
  const page = location.hash.split('/')[1] ?? '';
  const active = page === 'cat'
    ? location.hash
    : { '': '#/', c: '#/channels', channels: '#/channels', history: '#/history' }[page];
  for (const a of chips.querySelectorAll('a')) a.classList.toggle('active', a.getAttribute('href') === active);
}

// ---------- player ----------

const ytReady = new Promise(resolve => {
  window.onYouTubeIframeAPIReady = resolve;
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  document.head.append(script);
});

async function showWatch(id, channelId) {
  if (!getVideo(id) && channelId) {
    const token = watchToken;
    view.innerHTML = '<p class="empty">Loading…</p>';
    await loadChannelFile(channelId);
    if (token !== watchToken) return; // navigated away meanwhile
  }
  const v = getVideo(id);
  if (!v) {
    view.innerHTML = '<p class="empty">That video isn’t on the list. <a href="#/">Go home</a></p>';
    return;
  }

  const hist = historyMap();
  const more = data.videos.filter(x => x.source === v.source && x.id !== id).slice(0, 24);
  view.innerHTML = `
    <div class="watch">
      <div class="player-wrap" id="player-wrap">
        <div class="stage">
          <div class="frame"><div id="player"></div></div>
          <div class="shield" id="shield"></div>
          <div class="cover" id="cover">
            ${frameImg(id, 'hq', 'cover-img')}
            <button class="big-play" id="big-play" aria-label="Play">${icons.play}</button>
          </div>
          <div class="message hidden" id="message"></div>
        </div>
        <div class="controls">
          <button id="btn-back" aria-label="Back 10 seconds">${icons.back10}</button>
          <button id="btn-play" class="primary" aria-label="Play or pause">${icons.play}</button>
          <button id="btn-fwd" aria-label="Forward 10 seconds">${icons.fwd10}</button>
          <input type="range" id="seek" min="0" max="0" step="1" value="0" aria-label="Seek">
          <span class="time" id="time">0:00 / ${fmtTime(v.duration)}</span>
          <button id="btn-mute" aria-label="Mute">${icons.volume}</button>
          <button id="btn-full" aria-label="Full screen">${icons.full}</button>
        </div>
      </div>
      <h1 class="watch-title">${esc(v.title)}</h1>
      <div class="watch-meta">
        <a class="watch-channel" href="#/c/${encodeURIComponent(v.source)}">${esc(sourceTitle(v.source) || v.channelTitle)}</a>
        ${saveButton(id, loadSaved().includes(id), true)}
      </div>
      ${more.length ? `<h2>More to watch</h2>${grid(more, hist)}` : ''}
    </div>`;

  const saved = hist.get(id);
  const start = saved && inProgress(saved) ? saved.position : 0;

  const token = ++watchToken;
  await ytReady;
  if (token !== watchToken) return; // navigated away while the API loaded

  player = new YT.Player('player', {
    host: 'https://www.youtube-nocookie.com',
    videoId: id,
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      fs: 0,
      rel: 0,
      iv_load_policy: 3,
      modestbranding: 1,
      playsinline: 1,
      start,
      origin: location.origin,
    },
    events: {
      onStateChange: e => onPlayerState(id, e.data),
      onError: e => onPlayerError(e.data),
    },
  });

  wireControls(id);
}

function isPlaying() {
  const s = player?.getPlayerState?.();
  return s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING;
}

function togglePlay() {
  if (!player?.getPlayerState) return;
  if (isPlaying()) {
    player.pauseVideo();
  } else {
    if (player.getPlayerState() === YT.PlayerState.ENDED) player.seekTo(0, true);
    player.playVideo();
    // iOS ignores play requests that don't come from a tap inside the player itself.
    // If nothing has started shortly after, let the next tap through to YouTube's play button.
    setTimeout(() => {
      const wrap = $('#player-wrap');
      if (wrap && !wrap.dataset.started && !isPlaying()) wrap.classList.add('tap-through');
    }, 1500);
  }
}

function skip(by) {
  if (!player?.getCurrentTime) return;
  player.seekTo(Math.max(0, player.getCurrentTime() + by), true);
}

function toggleMute() {
  if (!player?.isMuted) return;
  player.isMuted() ? player.unMute() : player.mute();
  // isMuted() lags a moment behind mute()/unMute().
  setTimeout(() => {
    const btn = $('#btn-mute');
    if (btn && player) btn.innerHTML = player.isMuted() ? icons.muted : icons.volume;
  }, 100);
}

// iPhones can only full-screen <video> elements, so the button is hidden there
// and turning the phone sideways fills the screen instead (see styles.css).
const canFullscreen = document.fullscreenEnabled || document.webkitFullscreenEnabled;
if (!canFullscreen) document.documentElement.classList.add('no-fullscreen');

function toggleFullscreen() {
  if (!canFullscreen) return;
  const wrap = $('#player-wrap');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  } else if (wrap) {
    (wrap.requestFullscreen ?? wrap.webkitRequestFullscreen).call(wrap);
  }
}

function saveProgress(id) {
  if (!player?.getCurrentTime) return;
  const pos = player.getCurrentTime();
  const dur = player.getDuration();
  if (pos > 3 && dur) recordProgress(id, pos, dur);
}

function wireControls(id) {
  const seek = $('#seek');
  const time = $('#time');
  let dragging = false;
  let lastSave = Date.now();

  $('#shield').addEventListener('click', togglePlay);
  $('#big-play').addEventListener('click', togglePlay);
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-back').addEventListener('click', () => skip(-10));
  $('#btn-fwd').addEventListener('click', () => skip(10));
  $('#btn-mute').addEventListener('click', toggleMute);
  $('#btn-full').addEventListener('click', toggleFullscreen);

  seek.addEventListener('input', () => {
    dragging = true;
    time.textContent = `${fmtTime(seek.value)} / ${fmtTime(seek.max)}`;
  });
  seek.addEventListener('change', () => {
    dragging = false;
    player?.seekTo(Number(seek.value), true);
  });

  ticker = setInterval(() => {
    if (!player?.getDuration) return;
    const dur = player.getDuration();
    const pos = player.getCurrentTime();
    if (!dur) return;
    if (!dragging) {
      seek.max = Math.floor(dur);
      seek.value = Math.floor(pos);
      time.textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`;
    }
    seek.style.setProperty('--pct', `${(seek.value / seek.max) * 100}%`);
    if (isPlaying() && Date.now() - lastSave > SAVE_EVERY_MS) {
      saveProgress(id);
      lastSave = Date.now();
    }
  }, 250);
}

function onPlayerState(id, state) {
  const playing = state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING;
  const ended = state === YT.PlayerState.ENDED;
  const wrap = $('#player-wrap');
  if (playing && wrap) {
    wrap.dataset.started = '1';
    wrap.classList.remove('tap-through');
  }
  // The cover hides YouTube's own pause and end screens, which suggest other videos.
  $('#cover')?.classList.toggle('hidden', playing);
  const bigPlay = $('#big-play');
  if (bigPlay) bigPlay.innerHTML = ended ? icons.replay : icons.play;
  const btn = $('#btn-play');
  if (btn) btn.innerHTML = playing ? icons.pause : ended ? icons.replay : icons.play;

  if (state === YT.PlayerState.PAUSED) saveProgress(id);
  if (ended) {
    const dur = player.getDuration();
    recordProgress(id, dur, dur);
  }
}

function onPlayerError(code) {
  const text = {
    100: 'This video isn’t available anymore.',
    101: 'This video can’t be played here.',
    150: 'This video can’t be played here.',
  }[code] ?? 'Something went wrong playing this video.';
  const msg = $('#message');
  if (!msg) return;
  msg.innerHTML = `<p>${text}</p><a class="more" href="#/">Pick another video</a>`;
  msg.classList.remove('hidden');
  $('#cover')?.classList.add('hidden');
}

function teardownPlayer() {
  watchToken++;
  clearInterval(ticker);
  ticker = null;
  if (player) {
    const id = player.getVideoData?.().video_id;
    if (id) saveProgress(id);
    player.destroy();
    player = null;
  }
  if (document.fullscreenElement) document.exitFullscreen();
}

// ---------- routing ----------

function route() {
  teardownPlayer();
  const [, page, arg, sub] = location.hash.split('/');
  markActiveChip();
  if (page === 'watch' && arg) showWatch(arg, sub && decodeURIComponent(sub));
  else if (page === 'c' && arg) showChannel(decodeURIComponent(arg), sub && decodeURIComponent(sub));
  else if (page === 'cat' && arg) showCategory(decodeURIComponent(arg));
  else if (page === 'channels') showChannels();
  else if (page === 'history') showHistory();
  else showHome();
  if (page === 'watch') {
    // Sideways phones show only the player, so start scrolled to it.
    const landscapePhone = matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
    if (landscapePhone) $('#player-wrap')?.scrollIntoView();
    else window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', () => {
  shown = PAGE_SIZE;
  route();
});

search.addEventListener('input', () => {
  shown = PAGE_SIZE;
  if (location.hash.startsWith('#/watch/')) location.hash = '#/';
  else route();
});

view.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'more') {
    shown += PAGE_SIZE;
    route();
  } else if (action === 'shuffle') {
    randomRank = new Map();
    route();
  } else if (action === 'save') {
    e.preventDefault(); // the button sits inside a card link
    const id = e.target.closest('[data-id]').dataset.id;
    toggleSaved(id);
    // Re-rendering the home page moves the video into or out of the Watchlist row;
    // elsewhere just flip the buttons so a playing video isn't interrupted.
    if ((location.hash.split('/')[1] ?? '') === '') route();
    else updateSaveButtons(id);
  } else if (action === 'clear-history' && confirm('Clear watch history on this computer?')) {
    saveHistory([]);
    route();
  }
});

document.addEventListener('fullscreenchange', () => {
  const btn = $('#btn-full');
  if (btn) btn.innerHTML = document.fullscreenElement ? icons.exitFull : icons.full;
});

document.addEventListener('keydown', e => {
  if (!player || e.target.matches('input[type=search], input[type=text]')) return;
  const actions = {
    ' ': togglePlay, k: togglePlay,
    ArrowLeft: () => skip(-10), ArrowRight: () => skip(10),
    f: toggleFullscreen, m: toggleMute,
  };
  const fn = actions[e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

// Nothing inside the player should open a context menu or start a drag.
document.addEventListener('contextmenu', e => {
  if (e.target.closest('.stage')) e.preventDefault();
});

function showUpdated() {
  const updated = new Date(data.generatedAt);
  if (isNaN(updated)) return;
  const hours = (Date.now() - updated) / 36e5;
  const ago = hours < 1 ? 'less than an hour ago'
    : hours < 48 ? `${Math.floor(hours)} hour${hours < 2 ? '' : 's'} ago`
    : `${Math.floor(hours / 24)} days ago`;
  const footer = $('#updated');
  const problems = data.problems ?? [];
  footer.innerHTML = `<span title="${esc(updated.toLocaleString())}">Video list updated ${ago}</span>${problems.length
    ? `<details><summary>${problems.length} allowlist problem${problems.length === 1 ? '' : 's'}</summary>
        <ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></details>`
    : ''}`;
  // The list normally refreshes every 6 hours, so a day without one means the workflow stopped.
  footer.classList.toggle('stale', hours > 24);
}

async function init() {
  try {
    const res = await fetch('videos.json', { cache: 'no-cache' });
    data = await res.json();
  } catch {
    view.innerHTML = '<p class="empty">Couldn’t load the video list.</p>';
    return;
  }
  byId = new Map(data.videos.map(v => [v.id, v]));
  try {
    known = JSON.parse(localStorage.getItem(KNOWN_KEY)) ?? {};
  } catch {}
  renderChips();
  showUpdated();
  route();
}

init();
