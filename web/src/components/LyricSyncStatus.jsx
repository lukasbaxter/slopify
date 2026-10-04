// While songs are being synced: a small status pill above the player saying
// which song and what stage ("Waiting · 2 ahead", "Lining the lyrics up with
// the vocals"), so asking is never followed by silence.
import { useLyricJobs, jobLabel } from '../api/lyricsync.js';

export default function LyricSyncStatus() {
  const jobs = useLyricJobs();
  if (!jobs.length) return null;
  const j = jobs.find((x) => x.state === 'running') || jobs[0];
  return (
    <div className="lyricsync-pill" role="status" aria-live="polite">
      <span className="lyricsync-spin" aria-hidden="true" />
      <span className="lyricsync-text"><b>Syncing lyrics</b> · {j.title} — {jobLabel(j)}{jobs.length > 1 ? ` · ${jobs.length - 1} more` : ''}</span>
    </div>
  );
}
