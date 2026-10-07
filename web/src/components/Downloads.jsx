import React, { useEffect, useRef, useState } from 'react';

// Profile menu › Downloads: albums requested through Slopify (artist page
// Request buttons, generated playlists' missing songs) and where each one is.
// "Everyone" shows everything wanted or moving in Lidarr. Refreshes every 5 s while
// open; stuck = downloading with no finished song for the server's limit.
// adding = downloaded, the library scan has not shown it yet (seconds).
const SECTIONS = [
  ['downloading', 'Downloading'],
  ['adding', 'Adding to library'],
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
// "in 3 min" / "in 40 s" until a time.
const inTime = (t) => { const s = Math.round((t - Date.now()) / 1000); if (s <= 5) return 'any moment now'; if (s < 90) return `in ${s} s`; return `in ${mins(s * 1000)}`; };

// The Soulseek downloader's rhythm, for the header: never leave anyone
// wondering whether anything is happening.
function watcherLine(w) {
  if (!w) return null;
  const when = w.checking ? 'checking the wanted list now' : [w.lastCheck && `last checked ${ago(w.lastCheck)}`, w.next && `next check ${inTime(w.next)}`].filter(Boolean).join(' • ');
  const load = w.wanted != null ? `${w.wanted} album${w.wanted === 1 ? '' : 's'} wanted${w.perCheck && w.wanted > w.perCheck ? `, ${w.perCheck} searched per check` : ''}` : '';
  return `Soulseek downloader: ${[when, load].filter(Boolean).join(' • ')}`;
}

// What the downloader did about a waiting (or stuck) album and what happens next.
function waitingText(d, w) {
  const next = !w ? '' : w.checking ? 'checking now' : w.next ? `next try ${inTime(w.next)}` : '';
  const s = d.search;
  if (s && s.outcome === 'searching') return 'Searching Soulseek for it now…';
  if (s) {
    const what = {
      noresults: `Searched Soulseek ${ago(s.at)}: nobody is sharing it`,
      nomatch: `Searched Soulseek ${ago(s.at)}: ${s.results} result${s.results === 1 ? '' : 's'}, none a complete match for this release`,
      refused: `Found on Soulseek ${ago(s.at)}, but nobody sharing it would send it (offline or their queue is full)`,
      matched: `Found on Soulseek ${ago(s.at)}, the download is starting`,
    }[s.outcome] || `Searched Soulseek ${ago(s.at)}`;
    return s.outcome === 'matched' ? what : [what, next].filter(Boolean).join(' • ');
  }
  if (!w) return `Waiting for the downloader to pick it up${d.requested ? ` • requested ${ago(d.requested)}` : ''}`;
  const many = w.perCheck && w.wanted > w.perCheck ? ` (${w.wanted} albums wait, ${w.perCheck} are searched per check, so it can take a few)` : '';
  return `Not searched yet • first search at the next check, ${w.checking ? 'running now' : w.next ? inTime(w.next) : 'soon'}${many}`;
}

function Row({ d, w, onRetry, retrying, onPlay, onOpen }) {
  const pct = d.total ? Math.min(100, Math.round((d.done / d.total) * 100)) : 0;
  const songs = d.total === 1 ? 'song' : 'songs';
  return (
    <div className={`dl-row ${d.state}`}>
      {d.image ? <img className="dl-art" src={d.image} alt="" loading="lazy" /> : <div className="dl-art ph" />}
      <div className={`dl-text ${d.libraryAlbumId ? 'link' : ''}`} role={d.libraryAlbumId ? 'button' : undefined} onClick={d.libraryAlbumId ? () => onOpen(d) : undefined}>
        <b title={d.title}>{d.title}</b>
        <span>{[d.artist, d.type, d.year].filter(Boolean).join(' • ')}</span>
        {d.note && <small>{d.note}</small>}
      </div>
      <div className="dl-status">
        {(d.state === 'downloading' || d.state === 'stuck' || d.state === 'adding' || d.state === 'done') && (
          <div className="dl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.state === 'done' || d.state === 'adding' ? 100 : pct}>
            <span style={{ width: `${d.state === 'done' || d.state === 'adding' ? 100 : Math.max(pct, d.state === 'downloading' ? 3 : 0)}%` }} />
          </div>
        )}
        <div className="dl-line">
          {d.state === 'downloading' && d.via === 'torrent' && <span>Torrent • {d.detail}</span>}
          {d.state === 'downloading' && d.via !== 'torrent' && <span>{d.done} of {d.total} {songs}{d.started ? ` • started ${ago(d.started)}` : ''}</span>}
          {d.state === 'stuck' && <span className="dl-warn">{d.search ? waitingText(d, w) : d.reason || `No progress for ${mins(Date.now() - (d.progressAt || d.started || Date.now()))}`} • {d.done} of {d.total} {songs}</span>}
          {d.state === 'queued' && <span>{waitingText(d, w)}</span>}
          {d.state === 'failed' && <span className="dl-warn">{d.reason || 'Failed'}{d.finished ? ` • ${ago(d.finished)}` : ''}</span>}
          {d.state === 'adding' && <span>Downloaded • adding to your library…</span>}
          {d.state === 'done' && (d.libraryAlbumId
            ? <span>{d.done} {d.done === 1 ? 'song' : 'songs'} added{d.finished ? ` • ${ago(d.finished)}` : ''}</span>
            : <span className="dl-warn">Downloaded, but not found in your library{d.finished ? ` • ${ago(d.finished)}` : ''}</span>)}
          {d.state === 'done' && d.libraryAlbumId && (
            <button className="dl-retry" onClick={() => onPlay(d)}>Play</button>
          )}
          {(d.state === 'failed' || d.state === 'stuck') && (
            <button className="dl-retry" disabled={retrying} onClick={() => onRetry(d)}>{retrying ? 'Retrying…' : 'Retry'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Downloads({ jf, notify, onPlay, onOpen }) {
  const [scope, setScope] = useState('mine');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(null);
  // One alive flag per effect run: a slow answer for the chip you left must
  // not render under the chip you are on.
  const reloadRef = useRef(() => Promise.resolve());
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    const load = async () => {
      try { const r = await jf.downloads(scope); if (alive) { setData(r); setError(null); } }
      catch (e) { if (alive) setError(String(e.message || e).replace(/^\d+: /, '')); }
    };
    reloadRef.current = load;
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, jf]);
  const retry = async (d) => {
    setRetrying(d.id);
    try { await jf.retryDownload(d.id); notify?.(`${d.title} is back in line`); await reloadRef.current(); }
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
        {data?.watcher && <p className="dl-watcher">{watcherLine(data.watcher)}</p>}
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
              {k === 'stuck' && <p className="dl-hint">No new song for {mins(data.stuckAfterMs)} or more. Soulseek keeps looking; if nothing turns up it moves to Failed with the reason. Retry also tries torrents.</p>}
              {shown.map((d) => <Row key={d.id} d={d} w={data?.watcher} onRetry={retry} retrying={retrying === d.id} onPlay={onPlay} onOpen={onOpen} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}
