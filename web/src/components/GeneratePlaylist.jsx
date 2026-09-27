import React, { useEffect, useRef, useState } from 'react';

// "Generated playlist (AI)": describe it, the server's local model picks 25
// songs from the library using what you play, like and keep in playlists.
// The work runs as a server job; closing this leaves it running and the
// playlist still appears in Your Library when it is done.
const IDEAS = [
  'Late night drive, R&B and slow rap',
  'Upbeat songs for the gym',
  'Like my most played lately, but songs I have not heard much',
  'Chill Sunday morning, acoustic and soft',
  '2010s pop throwbacks',
];

// Time left from the server's estimate, counted down locally between polls
// (with our own clock: the phone's and the server's need not agree).
function timeLeft(busy) {
  const i = busy.info; if (!i || i.leftMs == null) return null;
  const ms = i.leftMs - (Date.now() - busy.got);
  if (ms < 5000) return 'Almost done';
  const s = Math.ceil(ms / 5000) * 5;
  return s < 60 ? `About ${s} s left` : `About ${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''} left`;
}

function Progress({ busy }) {
  const i = busy.info;
  const pct = Math.round((busy.progress || 0) * 100);
  return (
    <div className="genpl-progress" aria-live="polite">
      {i?.title && <div className="genpl-title">{i.title}</div>}
      {i?.vibe && <p className="genpl-vibe">{i.vibe}</p>}
      <div className="genpl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${Math.max(3, pct)}%` }} /></div>
      <div className="genpl-left">{i ? timeLeft(busy) : busy.step}</div>
      {i?.stages && (
        <ol className="genpl-stages">
          {i.stages.map((st) => (
            <li key={st.key} className={st.state}>
              <span className="genpl-ico" aria-hidden="true">
                {st.state === 'done' ? <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13.985 2.383 5.127 12.754 1.388 8.375l-1.14 1.048 4.879 5.617L15.184 3.36l-1.199-.977z" /></svg>
                  : st.state === 'active' ? <span className="genpl-spin" /> : <span className="genpl-dot" />}
              </span>
              <span>{st.label}{st.key === 'find' && st.state === 'done' && i.found ? <small> · {i.found} songs, {i.foundNew} you have not played</small> : st.state === 'active' && st.detail ? <small> · {st.detail}</small> : null}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function GeneratePlaylist({ jf, onClose, onDone }) {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState(null); // { ok, reason }
  const [busy, setBusy] = useState(null); // { step, progress, info, got } (got = when this update arrived, for the countdown)
  const [, tick] = useState(0);
  useEffect(() => { if (!busy) return undefined; const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, [!!busy]);
  const [error, setError] = useState(null);
  // Still open? After "Hide" the job keeps being followed, and the finished
  // playlist is announced instead of opened.
  const open = useRef(true);
  useEffect(() => { jf.aiStatus().then(setStatus).catch(() => setStatus({ ok: false, reason: 'Could not reach the server.' })); }, [jf]);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);

  const submit = async (e) => {
    e?.preventDefault?.();
    const p = prompt.trim(); if (!p || busy) return;
    setError(null); setBusy({ step: 'Starting', progress: null });
    try {
      const job = await jf.generatePlaylist(p);
      const r = await jf.waitJob(job, (j) => { if (open.current) setBusy({ step: j.step, progress: j.progress, info: j.info, got: Date.now() }); });
      onDone?.(r, { hidden: !open.current });
    } catch (err) {
      const msg = String(err.message || err).replace(/^\d+: /, '');
      if (!open.current) { onDone?.(null, { hidden: true, error: msg }); return; }
      setError(msg); setBusy(null);
    }
  };

  const off = status && !status.ok;
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="modal genpl" onSubmit={submit}>
        <h3>Generated playlist</h3>
        {off ? <p className="genpl-note">{status.reason || 'Generated playlists are not available on this server.'}</p> : (
          <>
            {!busy && <p className="genpl-note">Describe what you want. The model on your server picks 25 songs from your library: 20 you have not played yet, 5 you know. Good fits you do not have yet are requested and added when they download.</p>}
            <textarea autoFocus rows={3} maxLength={1000} value={prompt} disabled={!!busy} placeholder="e.g. rainy day indie, a bit melancholy"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape' && !busy) onClose(); }} />
            {!busy && !prompt && (
              <div className="genpl-ideas">
                {IDEAS.map((t) => <button type="button" key={t} className="pill" onClick={() => setPrompt(t)}>{t}</button>)}
              </div>
            )}
            {busy && <Progress busy={busy} />}
            {error && <p className="genpl-error">{error}</p>}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>{busy ? 'Hide' : 'Cancel'}</button>
          {!off && <button type="submit" className="primary" disabled={!prompt.trim() || !!busy || !status}>Generate</button>}
        </div>
      </form>
    </div>
  );
}
