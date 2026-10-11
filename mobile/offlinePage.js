// The offline player: a page of its own that the shell writes next to the
// downloaded songs (offline.js) and opens from a file:// URL when there is
// no connection (or on request). Plays the files with a plain <audio>, no
// Web Audio (iOS silences a Web Audio graph once the phone locks), with
// lock-screen controls through Media Session. Its data arrives as
// window.__offline before the page runs: { collections: [{ id, name, kind,
// cover, trackIds }], tracks: { id: { title, artist, album, durationMs,
// cover, file } } }, every path relative to this page. Talks to the shell
// with postMessage: online (go back), remove (a collection), play (a play to
// report later). No template literals in here: the page is one String.raw.
export default String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<title>Slopify offline</title>
<style>
:root { --bg: #000; --fg: #fff; --dim: #b3b3b3; --green: #1ed760; --row: #121212; }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 15px -apple-system, system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
body { padding: calc(env(safe-area-inset-top) + 8px) 0 calc(env(safe-area-inset-bottom) + 96px); }
header { display: flex; align-items: center; gap: 12px; padding: 8px 16px 12px; }
header h1 { font-size: 24px; margin: 0; flex: 1; }
.pill { border: 1px solid #555; background: none; color: var(--fg); border-radius: 500px; padding: 7px 14px; font: inherit; font-size: 13px; font-weight: 600; }
.note { margin: 0 16px 12px; padding: 10px 12px; border-radius: 8px; background: #1a1a1a; color: var(--dim); font-size: 13px; }
.list { padding: 0 8px; }
.item { display: flex; align-items: center; gap: 12px; padding: 8px; border-radius: 6px; }
.item:active { background: #1a1a1a; }
.item img, .item .ph { width: 56px; height: 56px; border-radius: 4px; object-fit: cover; background: #282828; flex: none; }
.item .t { min-width: 0; flex: 1; }
.item .n { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.item .s { color: var(--dim); font-size: 13px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.back { background: none; border: 0; color: var(--fg); font-size: 28px; padding: 0 8px 0 0; line-height: 1; }
.hero { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 4px 16px 16px; }
.hero img, .hero .ph { width: 200px; height: 200px; border-radius: 6px; object-fit: cover; background: #282828; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
.hero h2 { margin: 0; font-size: 22px; text-align: center; }
.hero .s { color: var(--dim); font-size: 13px; }
.actions { display: flex; gap: 12px; align-items: center; }
.play { background: var(--green); color: #000; border: 0; border-radius: 500px; padding: 12px 28px; font: inherit; font-weight: 700; }
.row { display: flex; align-items: center; gap: 12px; padding: 8px 16px; }
.row:active { background: #1a1a1a; }
.row .t { min-width: 0; flex: 1; }
.row .n { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.on .n { color: var(--green); }
.row .s { color: var(--dim); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.row .d { color: var(--dim); font-size: 13px; font-variant-numeric: tabular-nums; }
.empty { color: var(--dim); text-align: center; padding: 48px 24px; line-height: 1.5; }
#bar { position: fixed; left: 8px; right: 8px; bottom: calc(env(safe-area-inset-bottom) + 8px); background: #2a2a2a; border-radius: 8px; padding: 8px 8px 6px; display: none; }
#bar.show { display: block; }
#bar .top { display: flex; align-items: center; gap: 10px; }
#bar img { width: 44px; height: 44px; border-radius: 4px; object-fit: cover; background: #444; }
#bar .t { min-width: 0; flex: 1; }
#bar .n { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; font-size: 14px; }
#bar .s { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dim); font-size: 12px; }
#bar button { background: none; border: 0; color: var(--fg); width: 40px; height: 40px; display: grid; place-items: center; padding: 0; }
#bar button.on svg { fill: var(--green); }
#bar svg { width: 22px; height: 22px; fill: currentColor; }
#bar .seek { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums; margin-top: 4px; }
#bar input { flex: 1; accent-color: var(--fg); height: 18px; }
</style></head>
<body>
<div id="app"></div>
<div id="bar">
  <div class="top">
    <img id="bcover" alt="">
    <div class="t"><div class="n" id="btitle"></div><div class="s" id="bartist"></div></div>
    <button id="bshuf" aria-label="Shuffle"><svg viewBox="0 0 16 16"><path d="M13.15.12a.75.75 0 0 1 1.06 0l1.6 1.6a.75.75 0 0 1 0 1.06l-1.6 1.6a.75.75 0 1 1-1.06-1.06l.32-.32h-.76c-.95 0-1.84.48-2.37 1.27L8.6 7.5l1.74 2.6c.53.8 1.42 1.27 2.37 1.27h.76l-.32-.32a.75.75 0 1 1 1.06-1.06l1.6 1.6a.75.75 0 0 1 0 1.06l-1.6 1.6a.75.75 0 1 1-1.06-1.06l.32-.32h-.76a4.35 4.35 0 0 1-3.62-1.94L7.7 8.85l-1.45 2.17A4.35 4.35 0 0 1 2.63 12.96H.75a.75.75 0 0 1 0-1.5h1.88c.95 0 1.84-.48 2.37-1.27L6.8 7.5 5 4.81a2.85 2.85 0 0 0-2.37-1.27H.75a.75.75 0 0 1 0-1.5h1.88c1.45 0 2.8.73 3.62 1.94L7.7 6.15l1.45-2.17a4.35 4.35 0 0 1 3.62-1.94h.76l-.32-.32a.75.75 0 0 1 0-1.06z"/></svg></button>
    <button id="bprev" aria-label="Previous"><svg viewBox="0 0 16 16"><path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.75a.7.7 0 0 1 1.05.6v12.6a.7.7 0 0 1-1.05.6L4 9.15v5.15a.7.7 0 0 1-1.4 0V1.7a.7.7 0 0 1 .7-.7z"/></svg></button>
    <button id="bplay" aria-label="Play"><svg viewBox="0 0 16 16"><path id="bplayg" d="M3 1.71v12.58a.7.7 0 0 0 1.05.6l10.9-6.29a.7.7 0 0 0 0-1.2L4.05 1.1A.7.7 0 0 0 3 1.71z"/></svg></button>
    <button id="bnext" aria-label="Next"><svg viewBox="0 0 16 16"><path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.1A.7.7 0 0 0 1 1.7v12.6a.7.7 0 0 0 1.05.6L12 9.15v5.15a.7.7 0 0 0 1.4 0V1.7a.7.7 0 0 0-.7-.7z"/></svg></button>
  </div>
  <div class="seek"><span id="bcur">0:00</span><input id="bseek" type="range" min="0" max="1000" value="0"><span id="bdur">0:00</span></div>
</div>
<audio id="el" preload="auto" playsinline></audio>
<script>
(function () {
  var data = window.__offline || { collections: [], tracks: {} };
  var T = data.tracks || {};
  var cols = (data.collections || []).filter(function (c) { return c.trackIds.some(function (id) { return T[id]; }); });
  var allIds = Object.keys(T).sort(function (a, b) { return (T[a].artist + T[a].title).localeCompare(T[b].artist + T[b].title); });
  if (allIds.length > 1) cols.push({ id: '__all', name: 'All downloaded songs', kind: 'all', cover: null, trackIds: allIds });
  var app = document.getElementById('app'), el = document.getElementById('el');
  document.getElementById('bcover').onerror = function () { this.style.visibility = 'hidden'; };
  var post = function (m) { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) { /* not in the app */ } };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmt = function (s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  var img = function (src) { return src ? '<img src="' + esc(src) + '" alt="" onerror="this.outerHTML=\'<div class=ph></div>\'">' : '<div class="ph"></div>'; };
  var have = function (c) { return c.trackIds.filter(function (id) { return T[id]; }); };

  // Player state: the queue in play order, its source order, where we are.
  var queue = [], order = [], pos = -1, shuffle = false, counted = false, view = null;

  function home() {
    view = null;
    var h = '<header><h1>Downloads</h1><button class="pill" id="online">Go online</button></header>';
    if (data.note) h += '<div class="note">' + esc(data.note) + '</div>';
    if (!cols.length) h += '<div class="empty">Nothing downloaded yet.<br>When you are online, open a playlist or album, tap ... and choose Download to this phone.</div>';
    h += '<div class="list">' + cols.map(function (c, i) {
      var n = have(c).length;
      return '<div class="item" data-i="' + i + '">' + img(c.kind === 'all' ? null : c.cover) + '<div class="t"><div class="n">' + esc(c.name) + '</div><div class="s">' + n + (n === 1 ? ' song' : ' songs') + (n < c.trackIds.length ? ' of ' + c.trackIds.length : '') + '</div></div></div>';
    }).join('') + '</div>';
    app.innerHTML = h;
    document.getElementById('online').onclick = function () { post({ type: 'online' }); };
    Array.prototype.forEach.call(app.querySelectorAll('.item'), function (n) { n.onclick = function () { open(cols[+n.dataset.i]); }; });
    window.scrollTo(0, 0);
  }

  function open(c) {
    view = c;
    var ids = have(c);
    var h = '<header><button class="back" id="back" aria-label="Back">&lsaquo;</button><h1></h1>' + (c.kind === 'all' ? '' : '<button class="pill" id="rm">Remove</button>') + '</header>';
    h += '<div class="hero">' + img(c.kind === 'all' ? null : c.cover) + '<h2>' + esc(c.name) + '</h2><div class="s">' + ids.length + ' songs</div>';
    h += '<div class="actions"><button class="play" id="p">Play</button><button class="pill" id="sh">Shuffle</button></div></div>';
    h += ids.map(function (id, i) { var t = T[id]; return '<div class="row" data-id="' + esc(id) + '" data-i="' + i + '"><div class="t"><div class="n">' + esc(t.title) + '</div><div class="s">' + esc(t.artist) + '</div></div><div class="d">' + fmt(t.durationMs / 1000) + '</div></div>'; }).join('');
    app.innerHTML = h;
    document.getElementById('back').onclick = home;
    var rm = document.getElementById('rm');
    if (rm) rm.onclick = function () { if (confirm('Remove "' + c.name + '" from this phone?')) post({ type: 'offline-remove', id: c.id }); };
    document.getElementById('p').onclick = function () { start(ids, 0, false); };
    document.getElementById('sh').onclick = function () { start(ids, Math.floor(Math.random() * ids.length), true); };
    Array.prototype.forEach.call(app.querySelectorAll('.row'), function (n) { n.onclick = function () { start(ids, +n.dataset.i, shuffle); }; });
    mark();
    window.scrollTo(0, 0);
  }

  function mark() {
    var id = queue[pos];
    Array.prototype.forEach.call(app.querySelectorAll('.row'), function (n) { n.classList.toggle('on', n.dataset.id === id); });
  }

  function shuffled(ids, first) {
    var rest = ids.filter(function (_, i) { return i !== first; });
    for (var i = rest.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var x = rest[i]; rest[i] = rest[j]; rest[j] = x; }
    return [ids[first]].concat(rest);
  }

  function start(ids, i, shuf) {
    order = ids.slice(); shuffle = !!shuf;
    queue = shuffle ? shuffled(order, i) : order.slice();
    pos = shuffle ? 0 : i;
    load(true);
  }

  function load(play) {
    var id = queue[pos], t = T[id];
    if (!t) return;
    counted = false;
    el.src = t.file;
    if (play) el.play().catch(function () {});
    document.getElementById('bar').classList.add('show');
    var bc = document.getElementById('bcover');
    if (t.cover) { bc.src = t.cover; bc.style.visibility = ''; } else bc.style.visibility = 'hidden';
    document.getElementById('btitle').textContent = t.title;
    document.getElementById('bartist').textContent = t.artist;
    document.getElementById('bshuf').classList.toggle('on', shuffle);
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || '', artwork: t.cover ? [{ src: new URL(t.cover, location.href).href, sizes: '320x320', type: 'image/jpeg' }] : [] });
      } catch (e) { /* older WebKit */ }
    }
    mark();
  }

  function next(auto) {
    if (pos < queue.length - 1) { pos++; load(true); }
    else if (auto) { pos = 0; load(false); el.pause(); }
  }
  function prev() {
    if (el.currentTime > 3 || pos === 0) { el.currentTime = 0; return; }
    pos--; load(true);
  }
  function toggle() { if (el.paused) el.play().catch(function () {}); else el.pause(); }
  function setShuffle() {
    if (!queue.length) return;
    var id = queue[pos];
    shuffle = !shuffle;
    if (shuffle) { queue = shuffled(order, order.indexOf(id)); pos = 0; }
    else { queue = order.slice(); pos = order.indexOf(id); }
    document.getElementById('bshuf').classList.toggle('on', shuffle);
  }

  var PLAY = 'M3 1.71v12.58a.7.7 0 0 0 1.05.6l10.9-6.29a.7.7 0 0 0 0-1.2L4.05 1.1A.7.7 0 0 0 3 1.71z';
  var PAUSE = 'M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z';
  var glyph = function () { document.getElementById('bplayg').setAttribute('d', el.paused ? PLAY : PAUSE); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = el.paused ? 'paused' : 'playing'; };
  el.addEventListener('play', glyph); el.addEventListener('pause', glyph);
  el.addEventListener('ended', function () { next(true); });
  el.addEventListener('error', function () { if (queue.length > 1) next(true); });
  var seeking = false, seek = document.getElementById('bseek');
  el.addEventListener('timeupdate', function () {
    var d = el.duration || 0;
    if (!seeking && d) seek.value = Math.round(el.currentTime / d * 1000);
    document.getElementById('bcur').textContent = fmt(el.currentTime);
    document.getElementById('bdur').textContent = fmt(d);
    // A play, like the online player counts one: 30 s in (or half a short song).
    if (!counted && d && el.currentTime >= Math.min(30, d / 2)) { counted = true; post({ type: 'offline-play', id: queue[pos], at: Date.now() }); }
    if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(el.currentTime, d), playbackRate: 1 }); } catch (e) { /* ignore */ } }
  });
  seek.addEventListener('input', function () { seeking = true; document.getElementById('bcur').textContent = fmt(seek.value / 1000 * (el.duration || 0)); });
  seek.addEventListener('change', function () { if (el.duration) el.currentTime = seek.value / 1000 * el.duration; seeking = false; });
  document.getElementById('bplay').onclick = toggle;
  document.getElementById('bnext').onclick = function () { next(false); };
  document.getElementById('bprev').onclick = prev;
  document.getElementById('bshuf').onclick = setShuffle;
  if ('mediaSession' in navigator) {
    var ms = navigator.mediaSession, on = function (a, f) { try { ms.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
    on('play', function () { el.play().catch(function () {}); });
    on('pause', function () { el.pause(); });
    on('nexttrack', function () { next(false); });
    on('previoustrack', prev);
    on('seekto', function (d) { if (d && d.seekTime != null) el.currentTime = d.seekTime; });
  }
  home();
})();
</script>
</body></html>`;
