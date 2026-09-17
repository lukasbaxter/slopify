// Playback as a state machine: idle -> loading -> playing <-> paused, plus
// the queue and the clock. One <audio> element; HLS through hls.js where the
// browser lacks native support. Every transition is a named action, so the
// UI never pokes the element.
import Hls from 'hls.js';
import { createStore } from './store';
import { post, streamUrl, type Track } from '../api/client';

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused';
export type Repeat = 'off' | 'all' | 'one';
type S = { state: PlayerState; queue: Track[]; index: number; positionMs: number; durationMs: number; volume: number; quality: string; repeat: Repeat; shuffle: boolean; error: string | null; contextId: string | null };

export const player = createStore<S>({ state: 'idle', queue: [], index: -1, positionMs: 0, durationMs: 0, volume: 1, quality: (() => { try { return localStorage.getItem('slopify.quality') || defaultQuality(); } catch { return defaultQuality(); } })(), repeat: 'off', shuffle: false, error: null, contextId: null });
function defaultQuality() { return typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches ? 'aac-320' : 'original'; }

const el = typeof Audio !== 'undefined' ? new Audio() : (null as unknown as HTMLAudioElement);
let hls: Hls | null = null;
let loadGen = 0;
export const current = () => { const s = player.get(); return s.queue[s.index] ?? null; };

if (el) {
  (window as any).__slopify = { audio: el, get hls() { return hls; } }; // diagnostics for tests and support
  el.preload = 'auto';
  el.addEventListener('timeupdate', () => { if (player.get().state !== 'loading') player.set({ positionMs: Math.round(el.currentTime * 1000) }); });
  el.addEventListener('durationchange', () => { if (Number.isFinite(el.duration) && el.duration > 0) player.set({ durationMs: Math.round(el.duration * 1000) }); });
  el.addEventListener('play', () => player.set({ state: 'playing', error: null }));
  el.addEventListener('pause', () => { if (player.get().state === 'playing') player.set({ state: 'paused' }); });
  el.addEventListener('ended', () => next(true));
  el.addEventListener('error', () => player.set({ state: 'paused', error: 'This track could not be played.' }));
}

function attach(url: string) {
  if (hls) { hls.destroy(); hls = null; }
  // hls.js wherever MSE exists (Chrome, Android, desktop Safari); only the
  // iPhone (no MSE) gets the native HLS path. Chromium claims native HLS on
  // Android and then barely advances.
  if (url.includes('/hls/') && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30, backBufferLength: 10 });
    hls.loadSource(url); hls.attachMedia(el);
  } else { el.src = url; }
}

async function load(track: Track, startMs = 0, autoplay = true) {
  const gen = ++loadGen;
  player.set({ state: 'loading', positionMs: startMs, durationMs: track.durationMs, error: null });
  attach(streamUrl(track.id, player.get().quality));
  if (startMs > 0) {
    await new Promise<void>((r) => { const done = () => { el.removeEventListener('loadedmetadata', done); r(); }; el.addEventListener('loadedmetadata', done); setTimeout(done, 3000); });
    if (gen !== loadGen) return;
    try { el.currentTime = startMs / 1000; } catch { /* not seekable yet */ }
  }
  if (!autoplay) { player.set({ state: 'paused' }); return; }
  try { await el.play(); if (gen === loadGen) post('/plays', { trackId: track.id, at: Date.now(), client: 'web' }).catch(() => {}); }
  catch (e: any) { if (gen === loadGen) player.set({ state: 'paused', error: e?.name === 'NotAllowedError' ? 'Tap play to start.' : 'Could not play.' }); }
}

export function playQueue(tracks: Track[], index = 0, contextId: string | null = null) {
  if (!tracks.length) return;
  const s = player.get();
  let queue = tracks, i = index;
  if (s.shuffle && tracks.length > 1) { const chosen = tracks[index]; queue = [chosen, ...shuffled(tracks.filter((_, k) => k !== index))]; i = 0; }
  player.set({ queue, index: i, contextId });
  void load(queue[i]);
}
export function toggle() {
  const s = player.get(); const t = current();
  if (!t) return;
  if (s.state === 'playing') el.pause();
  else if (s.state === 'paused' && (el.src || hls)) void el.play().catch(() => {});
  else void load(t, s.positionMs);
}
export function next(auto = false) {
  const s = player.get();
  if (s.repeat === 'one' && auto && current()) { void load(current()!); return; }
  let i = s.index + 1;
  if (i >= s.queue.length) { if (s.repeat === 'all' || !auto) i = 0; else { player.set({ state: 'paused', positionMs: 0 }); return; } }
  if (!s.queue.length) return;
  player.set({ index: i }); void load(s.queue[i]);
}
export function previous() {
  const s = player.get();
  if (s.positionMs > 3000 || s.index <= 0) { seek(0); return; }
  player.set({ index: s.index - 1 }); void load(s.queue[s.index - 1]);
}
export function seek(ms: number) { player.set({ positionMs: ms }); try { el.currentTime = ms / 1000; } catch { /* ignore */ } }
export function setVolume(v: number) { el.volume = Math.max(0, Math.min(1, v)); player.set({ volume: el.volume }); }
export function setQuality(q: string) { try { localStorage.setItem('slopify.quality', q); } catch { /* ignore */ } player.set({ quality: q }); const t = current(); if (t && player.get().state !== 'idle') void load(t, player.get().positionMs, player.get().state === 'playing'); }
export function setRepeat(r: Repeat) { player.set({ repeat: r }); }
export function setShuffle(on: boolean) { player.set({ shuffle: on }); }
export function skipTo(index: number) { const s = player.get(); if (index < 0 || index >= s.queue.length) return; player.set({ index }); void load(s.queue[index]); }
export function enqueue(tracks: Track[]) { player.set((s) => ({ queue: [...s.queue, ...tracks] })); }
function shuffled<T>(a: T[]) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

// Lock screen / media keys.
if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  try { ms.setActionHandler('play', toggle); ms.setActionHandler('pause', toggle); ms.setActionHandler('previoustrack', previous); ms.setActionHandler('nexttrack', () => next()); ms.setActionHandler('seekto', (d) => { if (typeof d.seekTime === 'number') seek(d.seekTime * 1000); }); } catch { /* unsupported actions */ }
  let lastId = '';
  player.subscribe(() => {
    const s = player.get(); const t = current();
    if (!t) return;
    if (t.id !== lastId) { lastId = t.id; try { ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.cover ? [{ src: `${location.origin}/api/art/${t.cover}/320.jpg`, sizes: '320x320', type: 'image/jpeg' }, { src: `${location.origin}/api/art/${t.cover}/640.jpg`, sizes: '640x640', type: 'image/jpeg' }] : [] }); } catch { /* ignore */ } }
    try { ms.playbackState = s.state === 'playing' ? 'playing' : 'paused'; if (s.durationMs > 0 && 'setPositionState' in ms) ms.setPositionState({ duration: s.durationMs / 1000, position: Math.min(s.positionMs, s.durationMs) / 1000, playbackRate: 1 }); } catch { /* ignore */ }
  });
}
