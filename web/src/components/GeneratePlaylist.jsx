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

export default function GeneratePlaylist({ jf, onClose, onDone }) {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState(null); // { ok, reason }
  const [busy, setBusy] = useState(null); // { step, progress }
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
      const r = await jf.waitJob(job, (j) => { if (open.current) setBusy({ step: j.step, progress: j.progress }); });
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
            <p className="genpl-note">Describe what you want. The model on your server picks 25 songs from your library: 20 you have not played yet, 5 you know. Good fits you do not have yet are requested and added when they download.</p>
            <textarea autoFocus rows={3} maxLength={1000} value={prompt} disabled={!!busy} placeholder="e.g. rainy day indie, a bit melancholy"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape' && !busy) onClose(); }} />
            {!busy && !prompt && (
              <div className="genpl-ideas">
                {IDEAS.map((t) => <button type="button" key={t} className="pill" onClick={() => setPrompt(t)}>{t}</button>)}
              </div>
            )}
            {busy && (
              <div className="genpl-busy" aria-live="polite">
                <span className="genpl-spin" aria-hidden="true" />
                <span>{busy.step}{busy.progress != null && busy.progress < 1 ? ` (${Math.round(busy.progress * 100)}%)` : ''}</span>
              </div>
            )}
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
