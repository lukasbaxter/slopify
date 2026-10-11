// The offline player (offline.html): what the installed app shows when there
// is no connection (the service worker serves it when the site will not
// load), over the songs kept by store.js. Plays them from blob: URLs made from
// the cache (no Range requests through the worker), with a plain <audio>
// (no Web Audio: iOS silences a Web Audio graph once the phone locks) and
// lock-screen controls through Media Session. The sleep timer runs here, on
// the phone: the account's timer is the server's, which cannot reach a phone
// with no connection.
import { readLib, blobUrl, removeCollection, addPlay } from './store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const app = $('app'), el = $('el');

let T = {}, cols = [];
// Player state: the queue in play order, its source order, where we are.
let queue = [], order = [], pos = -1, shuffle = false, counted = false;
// The song's blob URL and the next one's, made ahead so a song ending with
// the phone locked starts the next without waiting on the cache.
let cur = null, ahead = null;
// Sleep: { at } (a time) or { endOfTrack: true }, or null.
let sleep = null;

const urls = new Map(); // cover key -> blob URL (kept for the page's life)
async function cover(key) {
  if (!key) return null;
  if (!urls.has(key)) urls.set(key, await blobUrl(key));
  return urls.get(key);
}
const img = (src) => (src ? `<img src="${esc(src)}" alt="">` : '<div class="ph"></div>');
const have = (c) => c.trackIds.filter((id) => T[id]);

async function load() {
  const lib = await readLib();
  T = {};
  for (const [id, t] of Object.entries(lib.tracks)) if (t.file) T[id] = t;
  cols = lib.collections.filter((c) => c.trackIds.some((id) => T[id]));
  const all = Object.keys(T).sort((a, b) => `${T[a].artist}${T[a].title}`.localeCompare(`${T[b].artist}${T[b].title}`));
  if (all.length > 1) cols.push({ id: '__all', name: 'All downloaded songs', kind: 'all', cover: null, trackIds: all });
}

const SLEEPS = [['off', 'Sleep timer'], ['15', '15 min'], ['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['90', '1.5 hours'], ['end', 'End of song']];
function sleepPicker() {
  const label = !sleep ? 'Sleep timer' : sleep.endOfTrack ? 'Sleep: end of song' : `Sleep: ${fmt((sleep.at - Date.now()) / 1000)}`;
  return `<label class="pill sleep"><span id="sleeplbl">${esc(label)}</span><select id="sleepsel">${SLEEPS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>`;
}
function wireSleep() {
  const s = $('sleepsel');
  if (!s) return;
  s.value = 'off';
  s.onchange = () => {
    const v = s.value;
    sleep = v === 'off' ? null : v === 'end' ? { endOfTrack: true } : { at: Date.now() + Number(v) * 60000 };
    s.value = 'off';
    tickSleep();
  };
}
function tickSleep() {
  if (sleep?.at && Date.now() >= sleep.at) { sleep = null; el.pause(); }
  const l = $('sleeplbl');
  if (l) l.textContent = !sleep ? 'Sleep timer' : sleep.endOfTrack ? 'Sleep: end of song' : `Sleep: ${fmt((sleep.at - Date.now()) / 1000)}`;
}
// Checked on every playback tick (these keep coming with the phone locked,
// while timers may not) and once a second while the page is in view.
setInterval(tickSleep, 1000);

async function home() {
  let h = `<header><h1>Downloads</h1>${sleepPicker()}<button class="pill" id="online">Go online</button></header>`;
  if (!navigator.onLine) h += '<div class="note">No connection. Playing what is on this device.</div>';
  if (!cols.length) h += '<div class="empty">Nothing downloaded yet.<br>When you are online, open a playlist or album, tap ... and choose Download for offline.</div>';
  const covers = await Promise.all(cols.map((c) => cover(c.kind === 'all' ? null : c.cover || (c.trackIds.map((id) => T[id]?.cover).find(Boolean)))));
  h += `<div class="list">${cols.map((c, i) => {
    const n = have(c).length;
    return `<div class="item" data-i="${i}">${img(covers[i])}<div class="t"><div class="n">${esc(c.name)}</div><div class="s">${n}${n === 1 ? ' song' : ' songs'}${n < c.trackIds.length ? ` of ${c.trackIds.length}` : ''}</div></div></div>`;
  }).join('')}</div>`;
  app.innerHTML = h;
  $('online').onclick = () => { location.href = './'; };
  wireSleep();
  app.querySelectorAll('.item').forEach((n) => { n.onclick = () => open(cols[+n.dataset.i]); });
  window.scrollTo(0, 0);
}

async function open(c) {
  const ids = have(c);
  const art = await cover(c.kind === 'all' ? null : c.cover || T[ids[0]]?.cover);
  let h = `<header><button class="back" id="back" aria-label="Back">&lsaquo;</button><h1></h1>${sleepPicker()}${c.kind === 'all' ? '' : '<button class="pill" id="rm">Remove</button>'}</header>`;
  h += `<div class="hero">${img(art)}<h2>${esc(c.name)}</h2><div class="s">${ids.length} songs</div>`;
  h += '<div class="actions"><button class="play" id="p">Play</button><button class="pill" id="sh">Shuffle</button></div></div>';
  h += ids.map((id, i) => { const t = T[id]; return `<div class="row" data-id="${esc(id)}" data-i="${i}"><div class="t"><div class="n">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div><div class="d">${fmt(t.durationMs / 1000)}</div></div>`; }).join('');
  app.innerHTML = h;
  $('back').onclick = home;
  wireSleep();
  const rm = $('rm');
  if (rm) rm.onclick = async () => { if (confirm(`Remove "${c.name}" from this device?`)) { await removeCollection(c.id); await load(); home(); } };
  $('p').onclick = () => start(ids, 0, false);
  $('sh').onclick = () => start(ids, Math.floor(Math.random() * ids.length), true);
  app.querySelectorAll('.row').forEach((n) => { n.onclick = () => start(ids, +n.dataset.i, shuffle); });
  mark();
  window.scrollTo(0, 0);
}

function mark() {
  const id = queue[pos];
  app.querySelectorAll('.row').forEach((n) => n.classList.toggle('on', n.dataset.id === id));
}

function shuffled(ids, first) {
  const rest = ids.filter((_, i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return [ids[first], ...rest];
}

function start(ids, i, shuf) {
  order = ids.slice(); shuffle = !!shuf;
  queue = shuffle ? shuffled(order, i) : order.slice();
  pos = shuffle ? 0 : i;
  dropAhead();
  play(true);
}

function dropAhead() { if (ahead) { URL.revokeObjectURL(ahead.url); ahead = null; } }
async function prepareNext() {
  const id = queue[pos + 1];
  if (!id || ahead?.id === id) return;
  dropAhead();
  const url = await blobUrl(T[id]?.file);
  if (url && queue[pos + 1] === id) ahead = { id, url }; else if (url) URL.revokeObjectURL(url);
}

async function play(autoplay) {
  const id = queue[pos], t = T[id];
  if (!t) return;
  counted = false;
  let url;
  if (ahead?.id === id) { url = ahead.url; ahead = null; } else url = await blobUrl(t.file);
  if (!url || queue[pos] !== id) return;
  const old = cur; cur = url;
  el.src = url;
  if (old) URL.revokeObjectURL(old);
  if (autoplay) el.play().catch(() => {});
  $('bar').classList.add('show');
  const art = await cover(t.cover);
  const bc = $('bcover');
  if (art) { bc.src = art; bc.style.visibility = ''; } else bc.style.visibility = 'hidden';
  $('btitle').textContent = t.title;
  $('bartist').textContent = t.artist;
  $('bshuf').classList.toggle('on', shuffle);
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || '', artwork: art ? [{ src: art, sizes: '320x320', type: 'image/jpeg' }] : [] });
    } catch { /* older WebKit */ }
  }
  mark();
  prepareNext();
}

function next(auto) {
  if (auto && sleep?.endOfTrack) { sleep = null; tickSleep(); el.pause(); return; }
  if (pos < queue.length - 1) { pos++; play(true); }
  else if (auto) { pos = 0; dropAhead(); play(false); }
}
function prev() {
  if (el.currentTime > 3 || pos === 0) { el.currentTime = 0; return; }
  pos--; dropAhead(); play(true);
}
const toggle = () => { if (el.paused) el.play().catch(() => {}); else el.pause(); };
function setShuffle() {
  if (!queue.length) return;
  const id = queue[pos];
  shuffle = !shuffle;
  if (shuffle) { queue = shuffled(order, order.indexOf(id)); pos = 0; } else { queue = order.slice(); pos = order.indexOf(id); }
  $('bshuf').classList.toggle('on', shuffle);
  prepareNext();
}

const PLAY = 'M3 1.71v12.58a.7.7 0 0 0 1.05.6l10.9-6.29a.7.7 0 0 0 0-1.2L4.05 1.1A.7.7 0 0 0 3 1.71z';
const PAUSE = 'M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z';
const glyph = () => { $('bplayg').setAttribute('d', el.paused ? PLAY : PAUSE); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = el.paused ? 'paused' : 'playing'; };
el.addEventListener('play', glyph); el.addEventListener('pause', glyph);
el.addEventListener('ended', () => next(true));
el.addEventListener('error', () => { if (queue.length > 1 && el.src) next(true); });
let seeking = false;
const seek = $('bseek');
el.addEventListener('timeupdate', () => {
  const d = el.duration || 0;
  if (!seeking && d) seek.value = Math.round((el.currentTime / d) * 1000);
  $('bcur').textContent = fmt(el.currentTime);
  $('bdur').textContent = fmt(d);
  // A play, counted like the online player: 30 s in (or half a short song).
  if (!counted && d && el.currentTime >= Math.min(30, d / 2)) { counted = true; addPlay(queue[pos], Date.now()).catch(() => {}); }
  if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(el.currentTime, d), playbackRate: 1 }); } catch { /* ignore */ } }
  tickSleep();
});
seek.addEventListener('input', () => { seeking = true; $('bcur').textContent = fmt((seek.value / 1000) * (el.duration || 0)); });
seek.addEventListener('change', () => { if (el.duration) el.currentTime = (seek.value / 1000) * el.duration; seeking = false; });
$('bcover').onerror = function () { this.style.visibility = 'hidden'; };
$('bplay').onclick = toggle;
$('bnext').onclick = () => next(false);
$('bprev').onclick = prev;
$('bshuf').onclick = setShuffle;
if ('mediaSession' in navigator) {
  const on = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported */ } };
  on('play', () => el.play().catch(() => {}));
  on('pause', () => el.pause());
  on('nexttrack', () => next(false));
  on('previoustrack', prev);
  on('seekto', (d) => { if (d?.seekTime != null) el.currentTime = d.seekTime; });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
load().then(home);
