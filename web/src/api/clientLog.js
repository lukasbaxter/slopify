// The app's own log, kept on this device: what the player did, requests that
// failed or crawled, errors, pages opened. Settings › Logs shows it and sends
// it with a problem report. The last 500 lines, in localStorage so a log of
// what went wrong is still there after the app is closed and opened again.
const KEY = 'slopify.log';
const MAX = 500;
let lines = null;
let timer = null;

const load = () => {
  if (lines) return lines;
  try { lines = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { lines = []; }
  if (!Array.isArray(lines)) lines = [];
  return lines;
};
const flush = () => { clearTimeout(timer); timer = null; try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* full or blocked */ } };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function clientLog(m) {
  if (typeof window === 'undefined') return;
  const l = load();
  l.push(`${stamp()}${document.hidden ? ' bg' : ''} ${String(m).slice(0, 600)}`);
  if (l.length > MAX) l.splice(0, l.length - MAX);
  if (!timer) timer = setTimeout(flush, 2000);
}
export const clientLogLines = () => [...load()];
export const clearClientLog = () => { lines = []; flush(); };

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { if (timer) flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && timer) flush(); });
}
