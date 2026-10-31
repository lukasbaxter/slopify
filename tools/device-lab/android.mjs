// Shared helpers for the Android parts of the lab: adb, the screen's UI tree
// (uiautomator), taps by text, screenshots, and the system's media state.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ADB = process.env.ADB || path.join(process.env.ANDROID_HOME || '', 'platform-tools/adb');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function adbFor(serial) {
  const run = (...args) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\r/g, '');
  const sh = (cmd) => { try { return run('shell', cmd); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
  const shot = (file) => { fs.writeFileSync(file, execFileSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 })); return file; };
  // Every node on screen with text, description, id and centre.
  const ui = () => {
    sh('uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1');
    const xml = sh('cat /data/local/tmp/ui.xml');
    const nodes = [];
    for (const m of xml.matchAll(/<node [^>]*>/g)) {
      const a = (k) => (m[0].match(new RegExp(` ${k}="([^"]*)"`)) || [])[1] || '';
      const b = a('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!b) continue;
      nodes.push({ text: a('text'), desc: a('content-desc'), id: a('resource-id'), pkg: a('package'), cls: a('class'), focused: a('focused') === 'true',
        x: (Number(b[1]) + Number(b[3])) >> 1, y: (Number(b[2]) + Number(b[4])) >> 1 });
    }
    return nodes;
  };
  const find = (re, nodes = ui()) => nodes.find((n) => re.test(n.text) || re.test(n.desc) || re.test(n.id));
  const tapText = async (re, { tries = 5, wait = 800 } = {}) => {
    for (let i = 0; i < tries; i++) {
      const n = find(re);
      if (n) { sh(`input tap ${n.x} ${n.y}`); await sleep(wait); return n; }
      await sleep(wait);
    }
    return null;
  };
  const key = (k) => sh(`input keyevent ${k}`);
  const screenOn = () => /mWakefulness=Awake|Display Power: state=ON/.test(sh('dumpsys power | grep -E "mWakefulness=|Display Power"'));
  return { run, sh, shot, ui, find, tapText, key, screenOn };
}

// The media sessions the system has, from `dumpsys media_session`: one entry
// per session with its package, active flag, playback state and metadata.
export function mediaSessions(sh) {
  const out = sh('dumpsys media_session');
  const sessions = [];
  for (const blk of out.split(/\n\s{4}(?=\S)/)) {
    const pkg = (blk.match(/package=(\S+)/) || [])[1];
    if (!pkg) continue;
    sessions.push({
      tag: blk.split('\n')[0].trim().slice(0, 80),
      package: pkg,
      active: /active=true/.test(blk),
      state: (blk.match(/state=PlaybackState \{state=(\w+)/) || [])[1] || null,
      position: Number((blk.match(/position=(\d+)/) || [])[1] || NaN),
      actions: (blk.match(/actions=(\d+)/) || [])[1] || null,
      metadata: (blk.match(/metadata: ?(?:size=\d+, )?description=([^\n]*)/) || [])[1] || null,
    });
  }
  const stack = (out.match(/Sessions Stack[^\n]*\n([\s\S]*?)\n\s*\n/) || [])[1] || '';
  return { sessions, mediaButtonSession: (out.match(/Media button session is ([^\n]*)/) || [])[1] || null, stackHead: stack.split('\n').slice(0, 3).map((s) => s.trim()) };
}

// PlaybackState codes (android.media.session.PlaybackState).
export const PB = { 0: 'NONE', 1: 'STOPPED', 2: 'PAUSED', 3: 'PLAYING', 6: 'BUFFERING', 7: 'ERROR', 8: 'CONNECTING', 9: 'SKIP_PREV', 10: 'SKIP_NEXT' };

// Media-style notifications posted by a package: title / text from the
// notification extras.
export function mediaNotifications(sh, pkg) {
  const out = sh('dumpsys notification --noredact');
  const res = [];
  for (const blk of out.split(/\n\s+NotificationRecord\(/).slice(1)) {
    if (!blk.includes(`pkg=${pkg}`)) continue;
    const ex = (k) => (blk.match(new RegExp(`${k}=String \\(([^)]*)\\)`)) || blk.match(new RegExp(`${k}=([^\\n]*)`)) || [])[1] || null;
    res.push({ media: /MediaStyle|mediaSession|android\.mediaSession/.test(blk), title: ex('android.title'), text: ex('android.text'), sub: ex('android.subText'), channel: (blk.match(/channel=(\S+)/) || [])[1] || null });
  }
  return res;
}

export function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

// A bare DevTools client for one page (an Android WebView, which Playwright
// cannot attach to: "Browser context management is not supported").
// http://127.0.0.1:PORT/json lists the pages; pick one by URL prefix.
export async function cdpPage(port, urlPrefix, { tries = 40 } = {}) {
  let target = null;
  for (let i = 0; i < tries && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && (!urlPrefix || t.url.startsWith(urlPrefix))); } catch { /* not up yet */ }
    if (!target) await sleep(500);
  }
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) rej(new Error(msg.error.message)); else res(msg.result); }
    else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, timeout = 15000) => new Promise((res, rej) => {
    const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(`${method}: no answer in ${timeout} ms`)); } }, timeout);
  });
  // evaluate(fn, arg): fn is stringified and called with arg (JSON).
  const evaluate = async (fn, arg, timeout) => {
    const r = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true, userGesture: false }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const errors = [];
  listeners.push((m) => { if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] || m.params.exceptionDetails.text); });
  await send('Runtime.enable');
  const waitFor = async (fn, arg, timeout = 30000) => {
    const end = Date.now() + timeout;
    for (;;) { try { if (await evaluate(fn, arg, 5000)) return true; } catch { /* navigating */ } if (Date.now() > end) return false; await sleep(400); }
  };
  // A real touch at the centre of the first element matching css (and text).
  const touch = async (css, text) => {
    const pt = await evaluate(({ css, text }) => {
      const el = [...document.querySelectorAll(css)].find((e) => !text || e.textContent.includes(text));
      if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, { css, text });
    if (!pt) throw new Error(`touch: nothing matches ${css} ${text || ''}`);
    await sleep(300);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] }); await sleep(60);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  // Type into a React-controlled input.
  const fill = (css, index, value) => evaluate(({ css, index, value }) => {
    const el = document.querySelectorAll(css)[index];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }, { css, index, value });
  return { target, send, evaluate, waitFor, touch, fill, errors, close: () => ws.close() };
}
