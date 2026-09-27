import React, { useEffect, useRef, useState } from 'react';

// Profile menu › Downloads: albums requested through Slopify (artist page
// Request buttons, generated playlists' missing songs) and where each one is.
// "Everyone" shows the whole Music Requests queue. Refreshes every 5 s while
// open; stuck = downloading with no finished song for the server's limit.
const SECTIONS = [
  ['downloading', 'Downloading'],
  ['stuck', 'Stuck'],
  ['queued', 'Waiting in line'],
  ['failed', 'Failed'],
  ['done', 'Done'],
];
const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); return `${d} day${d === 1 ? '' : 's'} ago`;
};
const mins = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };

function Row({ d, onRetry, retrying }) {
  const pct = d.total ? Math.min(100, Math.round((d.done / d.total) * 100)) : 0;
  const songs = d.total === 1 ? 'song' : 'songs';
  return (
    <div className={`dl-row ${d.state}`}>
      {d.image ? <img className="dl-art" src={d.image} alt="" loading="lazy" /> : <div className="dl-art ph" />}
      <div className="dl-text">
        <b title={d.title}>{d.title}</b>
        <span>{[d.artist, d.type, d.year].filter(Boolean).join(' • ')}</span>
        {d.note && <small>{d.note}</small>}
      </div>
      <div className="dl-status">
        {(d.state === 'downloading' || d.state === 'stuck' || d.state === 'done') && (
          <div className="dl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.state === 'done' ? 100 : pct}>
            <span style={{ width: `${d.state === 'done' ? 100 : Math.max(pct, d.state === 'downloading' ? 3 : 0)}%` }} />
          </div>
        )}
        <div className="dl-line">
          {d.state === 'downloading' && <span>{d.done} of {d.total} {songs}{d.started ? ` • started ${ago(d.started)}` : ''}</span>}
          {d.state === 'stuck' && <span className="dl-warn">No progress for {mins(Date.now() - (d.progressAt || d.started || Date.now()))} • {d.done} of {d.total} {songs}</span>}
          {d.state === 'queued' && <span>{d.queuePos ? `#${d.queuePos} in line` : 'In line'}{d.requested ? ` • requested ${ago(d.requested)}` : ''}</span>}
          {d.state === 'failed' && <span className="dl-warn">{d.reason || 'Failed'}{d.finished ? ` • ${ago(d.finished)}` : ''}</span>}
          {d.state === 'done' && <span>{d.done} {d.done === 1 ? 'song' : 'songs'} added{d.finished ? ` • ${ago(d.finished)}` : ''}</span>}
          {(d.state === 'failed' || d.state === 'stuck') && (
            <button className="dl-retry" disabled={retrying} onClick={() => onRetry(d)}>{retrying ? 'Retrying…' : 'Retry'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Downloads({ jf, notify }) {
  const [scope, setScope] = useState('mine');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(null);
  const alive = useRef(true);
  const load = async (sc = scope) => {
    try { const r = await jf.downloads(sc); if (alive.current) { setData(r); setError(null); } }
    catch (e) { if (alive.current) setError(String(e.message || e).replace(/^\d+: /, '')); }
  };
  useEffect(() => {
    alive.current = true; setData(null); load(scope);
    const t = setInterval(() => { if (!document.hidden) load(scope); }, 5000);
    return () => { alive.current = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, jf]);
  const retry = async (d) => {
    setRetrying(d.id);
    try { await jf.retryDownload(d.id); notify?.(`${d.title} is back in line`); await load(); }
    catch (e) { notify?.(`Could not retry: ${String(e.message || e).replace(/^\d+: /, '')}`); }
    finally { setRetrying(null); }
  };

  const items = data?.items || [];
  const by = (st) => items.filter((d) => d.state === st);
  const summary = SECTIONS.map(([k, label]) => [k, label, by(k).length]).filter(([, , n]) => n);
  return (
    <div className="content">
      <div className="pad downloads">
        <h1 className="greeting">Downloads</h1>
        <div className="dl-head">
          <div className="dl-chips">
            {[['mine', 'Yours'], ['all', 'Everyone']].map(([k, label]) => (
              <button key={k} className={`pill ${scope === k ? 'on' : ''}`} onClick={() => setScope(k)}>{label}</button>
            ))}
          </div>
          {summary.length > 0 && <div className="dl-summary">{summary.map(([k, label, n]) => <span key={k} className={k}>{n} {label.toLowerCase()}</span>)}</div>}
        </div>
        {error && <p className="banner">{error}</p>}
        {!data && !error && <p className="dl-empty">Loading…</p>}
        {data && !items.length && (
          <div className="dl-empty">
            <b>{scope === 'mine' ? 'Nothing requested yet' : 'The queue is empty'}</b>
            <p>{scope === 'mine' ? 'Request an album from an artist page, or make a generated playlist: songs it suggests that you do not have yet show up here while they download.' : 'Nobody is downloading anything right now.'}</p>
          </div>
        )}
        {SECTIONS.map(([k, label]) => {
          const list = by(k); if (!list.length) return null;
          const shown = k === 'done' || k === 'failed' ? list.slice(0, 30) : list;
          return (
            <section key={k} className="dl-section">
              <h2>{label} <span>{list.length}</span></h2>
              {k === 'stuck' && <p className="dl-hint">No new song for {mins(data.stuckAfterMs)} or more. Usually the Soulseek user went offline; Retry puts it back at the front of the line.</p>}
              {shown.map((d) => <Row key={d.id} d={d} onRetry={retry} retrying={retrying === d.id} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}
