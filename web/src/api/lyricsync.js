// Sync Lyrics from a song's menu: ask the server, follow the job, say how it
// went, and tell any open lyrics view to load the song's lyrics again.
const pending = new Map(); // trackId -> title
let timer = null;
const toast = (m) => window.dispatchEvent(new CustomEvent('slopify:toast', { detail: m }));

function follow(jf) {
  if (timer) return;
  timer = setInterval(async () => {
    if (!pending.size) { clearInterval(timer); timer = null; return; }
    try {
      const { jobs } = await jf.lyricJobs([...pending.keys()]);
      for (const j of jobs || []) {
        if (j.state !== 'done' && j.state !== 'failed') continue;
        const title = pending.get(j.trackId);
        pending.delete(j.trackId);
        toast(`${title}: ${j.result}`);
        window.dispatchEvent(new CustomEvent('slopify:lyricschanged', { detail: j.trackId }));
      }
    } catch { /* try again next tick */ }
  }, 5000);
}

export async function syncLyrics(jf, track) {
  if (!jf || !track?.Id) return;
  try {
    const r = await jf.syncLyrics(track.Id);
    pending.set(track.Id, track.Name || 'This song');
    toast(r.already ? `Already syncing "${track.Name}"` : r.ahead ? `"${track.Name}" is in line for lyrics (${r.ahead} ahead)` : `Syncing lyrics for "${track.Name}"…`);
    follow(jf);
  } catch (e) { toast(`Couldn't sync lyrics: ${e.message}`); }
}
