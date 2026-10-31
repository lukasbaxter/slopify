// Sync Lyrics from a song's menu, and what the app shows while it runs: the
// server queues the song and reports each job's stage; this module follows
// the jobs (every 2 s while any is unfinished), keeps them in one place any
// component can watch, toasts the outcome, and tells an open lyrics view to
// load the new lyrics. Jobs still running after a reload are picked back up.
import { useSyncExternalStore } from 'react';
import { t } from '../i18n.js';

const jobs = new Map(); // trackId -> { trackId, title, state, step, ahead, result }
const subs = new Set();
let version = 0;
let timer = null;
let jfRef = null;
const emit = () => { version++; subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const toast = (text, ms = 2200) => window.dispatchEvent(new CustomEvent('slopify:toast', { detail: { text, ms } }));
const active = (j) => j && (j.state === 'queued' || j.state === 'running');

function absorb(list) {
  for (const j of list || []) {
    const before = jobs.get(j.trackId);
    const title = j.title || before?.title || t('This song');
    if (active(j)) { jobs.set(j.trackId, { ...before, ...j, title }); continue; }
    if (before) {
      jobs.delete(j.trackId);
      toast(`${title}: ${j.result || (j.state === 'failed' ? t("Couldn't sync") : t('Done'))}`, 5000);
      window.dispatchEvent(new CustomEvent('slopify:lyricschanged', { detail: j.trackId }));
    }
  }
  emit();
}

function follow() {
  if (timer || !jfRef) return;
  timer = setInterval(async () => {
    const pending = [...jobs.keys()];
    if (!pending.length) { clearInterval(timer); timer = null; return; }
    try { absorb((await jfRef.lyricJobs(pending)).jobs); } catch { /* next tick */ }
  }, 2000);
}

// After sign-in: jobs this account started before a reload.
export async function resumeLyricJobs(jf) {
  jfRef = jf;
  try { absorb((await jf.lyricJobs([], { mine: true })).jobs); follow(); } catch { /* nothing to resume */ }
}

export async function syncLyrics(jf, track) {
  if (!jf || !track?.Id) return;
  jfRef = jf;
  try {
    const r = await jf.syncLyrics(track.Id);
    jobs.set(track.Id, { ...r, title: r.title || track.Name });
    emit();
    if (r.already) toast(t('Already syncing "{name}"', { name: track.Name }));
    follow();
  } catch (e) { toast(t("Couldn't sync lyrics: {error}", { error: e.message })); }
}

// What a job is doing, in words.
export const jobLabel = (j) => (!j ? '' : j.state === 'queued' ? (j.ahead ? t('Waiting · {n} ahead', { n: j.ahead }) : t('Starting')) : j.step || t('Starting'));

export function useLyricJobs() {
  useSyncExternalStore(subscribe, () => version);
  return [...jobs.values()];
}
export function useLyricJob(trackId) {
  useSyncExternalStore(subscribe, () => version);
  return trackId ? jobs.get(trackId) || null : null;
}
