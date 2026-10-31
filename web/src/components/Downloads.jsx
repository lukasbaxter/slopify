import React, { useEffect, useRef, useState } from 'react';
import { t, N_ } from '../i18n.js';

// Profile menu › Downloads: albums requested through Slopify (artist page
// Request buttons, generated playlists' missing songs) and where each one is.
// "Everyone" shows everything wanted or moving in Lidarr. Refreshes every 5 s while
// open; stuck = downloading with no finished song for the server's limit.
// adding = downloaded, the library scan has not shown it yet (seconds).
const SECTIONS = [
  // [state, section heading, the count in the summary line]
  ['downloading', N_('Downloading'), N_('{n} downloading')],
  ['adding', N_('Adding to library'), N_('{n} adding to library')],
  ['stuck', N_('Stuck'), N_('{n} stuck')],
  ['queued', N_('Waiting in line'), N_('{n} waiting in line')],
  ['failed', N_('Failed'), N_('{n} failed')],
  ['done', N_('Done'), N_('{n} done')],
];
const ago = (at) => {
  if (!at) return '';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return t('just now');
  const m = Math.round(s / 60); if (m < 60) return t('{n} min ago', { n: m });
  const h = Math.round(m / 60); if (h < 24) return t('{n} h ago', { n: h });
  const d = Math.round(h / 24); return d === 1 ? t('1 day ago') : t('{n} days ago', { n: d });
};
const mins = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? t('{n} min', { n: m }) : t('{n} h', { n: Math.round(m / 60) }); };
// "in 3 min" / "in 40 s" until a time.
const inTime = (at) => { const s = Math.round((at - Date.now()) / 1000); if (s <= 5) return t('any moment now'); if (s < 90) return t('in {n} s', { n: s }); return t('in {time}', { time: mins(s * 1000) }); };

// The Soulseek downloader's rhythm, for the header: never leave anyone
// wondering whether anything is happening.
function watcherLine(w) {
  if (!w) return null;
  const when = w.checking ? t('checking the wanted list now') : [w.lastCheck && t('last checked {when}', { when: ago(w.lastCheck) }), w.next && t('next check {when}', { when: inTime(w.next) })].filter(Boolean).join(' • ');
  const load = w.wanted == null ? ''
    : w.perCheck && w.wanted > w.perCheck ? t('{n} albums wanted, {per} searched per check', { n: w.wanted, per: w.perCheck })
    : w.wanted === 1 ? t('1 album wanted') : t('{n} albums wanted', { n: w.wanted });
  return t('Soulseek downloader: {status}', { status: [when, load].filter(Boolean).join(' • ') });
}

// What the downloader did about a waiting (or stuck) album and what happens next.
function waitingText(d, w) {
  const next = !w ? '' : w.checking ? t('checking now') : w.next ? t('next try {when}', { when: inTime(w.next) }) : '';
  const s = d.search;
  if (s && s.outcome === 'searching') return t('Searching Soulseek for it now…');
  if (s) {
    const when = ago(s.at);
    const what = {
      noresults: t('Searched Soulseek {when}: nobody is sharing it', { when }),
      nomatch: s.results === 1 ? t('Searched Soulseek {when}: 1 result, none a complete match for this release', { when }) : t('Searched Soulseek {when}: {n} results, none a complete match for this release', { when, n: s.results }),
      refused: t('Found on Soulseek {when}, but nobody sharing it would send it (offline or their queue is full)', { when }),
      matched: t('Found on Soulseek {when}, the download is starting', { when }),
    }[s.outcome] || t('Searched Soulseek {when}', { when });
    return s.outcome === 'matched' ? what : [what, next].filter(Boolean).join(' • ');
  }
  if (!w) return `${t('Waiting for the downloader to pick it up')}${d.requested ? ` • ${t('requested {when}', { when: ago(d.requested) })}` : ''}`;
  const when = w.checking ? t('running now') : w.next ? inTime(w.next) : t('soon');
  return w.perCheck && w.wanted > w.perCheck
    ? t('Not searched yet • first search at the next check, {when} ({n} albums wait, {per} are searched per check, so it can take a few)', { when, n: w.wanted, per: w.perCheck })
    : t('Not searched yet • first search at the next check, {when}', { when });
}

function Row({ d, w, onRetry, retrying, onPlay, onOpen }) {
  const pct = d.total ? Math.min(100, Math.round((d.done / d.total) * 100)) : 0;
  const of = d.total === 1 ? t('{done} of 1 song', { done: d.done }) : t('{done} of {total} songs', { done: d.done, total: d.total });
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
          {d.state === 'downloading' && d.via === 'torrent' && <span>{t('Torrent')} • {d.detail}</span>}
          {d.state === 'downloading' && d.via !== 'torrent' && <span>{of}{d.started ? ` • ${t('started {when}', { when: ago(d.started) })}` : ''}</span>}
          {d.state === 'stuck' && <span className="dl-warn">{d.search ? waitingText(d, w) : d.reason || t('No progress for {time}', { time: mins(Date.now() - (d.progressAt || d.started || Date.now())) })} • {of}</span>}
          {d.state === 'queued' && <span>{waitingText(d, w)}</span>}
          {d.state === 'failed' && <span className="dl-warn">{d.reason || t('Failed')}{d.finished ? ` • ${ago(d.finished)}` : ''}</span>}
          {d.state === 'adding' && <span>{t('Downloaded • adding to your library…')}</span>}
          {d.state === 'done' && (d.libraryAlbumId
            ? <span>{d.done === 1 ? t('1 song added') : t('{n} songs added', { n: d.done })}{d.finished ? ` • ${ago(d.finished)}` : ''}</span>
            : <span className="dl-warn">{t('Downloaded, but not found in your library')}{d.finished ? ` • ${ago(d.finished)}` : ''}</span>)}
          {d.state === 'done' && d.libraryAlbumId && (
            <button className="dl-retry" onClick={() => onPlay(d)}>{t('Play')}</button>
          )}
          {(d.state === 'failed' || d.state === 'stuck') && (
            <button className="dl-retry" disabled={retrying} onClick={() => onRetry(d)}>{retrying ? t('Retrying…') : t('Retry')}</button>
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
    let busy = false; // a slow answer must not stack the next poll behind it
    const load = async () => {
      if (busy) return;
      busy = true;
      try { const r = await jf.downloads(scope); if (alive) { setData(r); setError(null); } }
      catch (e) { if (alive) setError(String(e.message || e).replace(/^\d+: /, '')); }
      finally { busy = false; }
    };
    reloadRef.current = load;
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, jf]);
  const retry = async (d) => {
    setRetrying(d.id);
    try { await jf.retryDownload(d.id); notify?.(t('{title} is back in line', { title: d.title })); await reloadRef.current(); }
    catch (e) { notify?.(t('Could not retry: {error}', { error: String(e.message || e).replace(/^\d+: /, '') })); }
    finally { setRetrying(null); }
  };

  const items = data?.items || [];
  const by = (st) => items.filter((d) => d.state === st);
  const summary = SECTIONS.map(([k, , count]) => [k, count, by(k).length]).filter(([, , n]) => n);
  return (
    <div className="content">
      <div className="pad downloads">
        <h1 className="greeting">{t('Downloads')}</h1>
        <div className="dl-head">
          <div className="dl-chips">
            {[['mine', t('Yours')], ['all', t('Everyone')]].map(([k, label]) => (
              <button key={k} className={`pill ${scope === k ? 'on' : ''}`} onClick={() => setScope(k)}>{label}</button>
            ))}
          </div>
          {summary.length > 0 && <div className="dl-summary">{summary.map(([k, count, n]) => <span key={k} className={k}>{t(count, { n })}</span>)}</div>}
        </div>
        {data?.watcher && <p className="dl-watcher">{watcherLine(data.watcher)}</p>}
        {error && <p className="banner">{error}</p>}
        {!data && !error && <p className="dl-empty">{t('Loading…')}</p>}
        {data && !items.length && (
          <div className="dl-empty">
            <b>{scope === 'mine' ? t('Nothing requested yet') : t('The queue is empty')}</b>
            <p>{scope === 'mine' ? t('Request an album from an artist page, or make a generated playlist: songs it suggests that you do not have yet show up here while they download.') : t('Nobody is downloading anything right now.')}</p>
          </div>
        )}
        {SECTIONS.map(([k, label]) => {
          const list = by(k); if (!list.length) return null;
          const shown = k === 'done' || k === 'failed' ? list.slice(0, 30) : list;
          return (
            <section key={k} className="dl-section">
              <h2>{t(label)} <span>{list.length}</span></h2>
              {k === 'stuck' && <p className="dl-hint">{t('No new song for {time} or more. Soulseek keeps looking; if nothing turns up it moves to Failed with the reason. Retry also tries torrents.', { time: mins(data.stuckAfterMs) })}</p>}
              {shown.map((d) => <Row key={d.id} d={d} w={data?.watcher} onRetry={retry} retrying={retrying === d.id} onPlay={onPlay} onOpen={onOpen} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}
