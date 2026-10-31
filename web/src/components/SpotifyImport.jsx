import React, { useRef, useState } from 'react';
import { t } from '../i18n.js';

// Settings › Import from Spotify: upload the export zip(s), the server
// matches plays, Liked Songs, saved albums and playlists to the library.
// Safe to run again with a newer export: nothing is added twice.
const n = (x) => Number(x || 0).toLocaleString();
// A translated sentence with <b>, <code> and <a> parts turned back into elements.
const TAGS = {
  b: (s, k) => <b key={k}>{s}</b>,
  code: (s, k) => <code key={k}>{s}</code>,
  a: (s, k) => <a key={k} href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">{s}</a>,
};
const rich = (s) => {
  const out = []; let last = 0;
  for (const m of s.matchAll(/<(b|code|a)>(.*?)<\/\1>/g)) { if (m.index > last) out.push(s.slice(last, m.index)); out.push(TAGS[m[1]](m[2], out.length)); last = m.index + m[0].length; }
  if (last < s.length) out.push(s.slice(last));
  return out;
};

export default function SpotifyImport({ jf }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(null); // step text
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const run = async (files) => {
    if (!files.length) return;
    setError(null); setResult(null);
    try {
      const ids = [];
      for (const [i, f] of files.entries()) {
        const label = files.length > 1 ? t('Uploading {name} ({i} of {n})', { name: f.name, i: i + 1, n: files.length }) : t('Uploading {name}', { name: f.name });
        setBusy(label);
        const r = await jf.uploadSpotifyFile(f, (p) => setBusy(`${label}: ${Math.round(p * 100)}%`));
        ids.push(r.fileId);
      }
      const job = await jf.importSpotify(ids);
      const r = await jf.waitJob(job, (j) => setBusy(j.progress != null && j.progress < 1 ? `${j.step}` : j.step));
      setResult(r);
      window.dispatchEvent(new CustomEvent('slopify:librarychanged'));
    } catch (e) {
      setError(String(e.message || e).replace(/^\d+: /, ''));
    } finally { setBusy(null); if (input.current) input.current.value = ''; }
  };

  return (
    <div className="spimport">
      <div className="settings-hint" style={{ marginBottom: 12 }}>
        {t('Brings your Spotify listening history, Liked Songs, saved albums and playlists in, matched to songs in this library.')}{' '}
        {rich(t('Request the data at <a>spotify.com › Account › Privacy</a>: tick <b>Account data</b> (liked songs, playlists, the last year of plays) and, for every play since you joined, <b>Extended streaming history</b>.'))}{' '}
        {rich(t('Spotify emails a <code>my_spotify_data.zip</code> for each. Upload one or both, as zips or the JSON files inside.'))}{' '}
        {t('Running it again with a newer export only adds what is new. Liked and playlist songs the library does not have are requested for download and filled in as they arrive.')}
      </div>
      <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" multiple hidden onChange={(e) => run([...e.target.files])} />
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!!busy} onClick={() => input.current?.click()}>{busy ? t('Importing…') : t('Choose files')}</button>
        {busy && <span className="settings-hint" style={{ margin: 0 }}>{busy}</span>}
      </div>
      {error && <p className="genpl-error" style={{ marginTop: 12 }}>{error}</p>}
      {result && (
        <div className="spimport-result">
          <ul>
            <li>{rich(t('<b>{added}</b> plays added ({matched} of {total} matched)', { added: n(result.plays.added), matched: n(result.plays.matched), total: n(result.plays.total) }))}</li>
            <li>{rich(t('<b>{added}</b> liked songs added ({matched} of {total} matched)', { added: n(result.likes.added), matched: n(result.likes.matched), total: n(result.likes.total) }))}</li>
            {result.albums.total > 0 && <li>{rich(t('<b>{added}</b> saved albums added ({matched} of {total} matched)', { added: n(result.albums.added), matched: n(result.albums.matched), total: n(result.albums.total) }))}</li>}
            <li>{rich(result.playlists.skipped.length
              ? t('<b>{created}</b> playlists created ({matched} of {songs} songs matched), {skipped} skipped because a playlist with that name exists', { created: n(result.playlists.created), matched: n(result.playlists.songsMatched), songs: n(result.playlists.songs), skipped: result.playlists.skipped.length })
              : t('<b>{created}</b> playlists created ({matched} of {songs} songs matched)', { created: n(result.playlists.created), matched: n(result.playlists.songsMatched), songs: n(result.playlists.songs) }))}</li>
            <li>{t('{matched} of {total} different songs are in this library', { matched: n(result.songs.matched), total: n(result.songs.total) })}</li>
            {(result.queued?.songs > 0 || result.queued?.albums > 0) && (result.downloads
              ? <li>{rich(result.queued.albums > 0
                ? t('<b>{songs}</b> missing liked and playlist songs and <b>{albums}</b> saved albums are being requested. Each one goes into Liked Songs, its playlist or saved albums as it downloads (see Downloads).', { songs: n(result.queued.songs), albums: n(result.queued.albums) })
                : t('<b>{songs}</b> missing liked and playlist songs are being requested. Each one goes into Liked Songs, its playlist or saved albums as it downloads (see Downloads).', { songs: n(result.queued.songs) }))}</li>
              : <li>{result.queued.albums > 0
                ? t('{songs} liked and playlist songs and {albums} saved albums are not in the library. They are filled in if they are added later.', { songs: n(result.queued.songs), albums: n(result.queued.albums) })
                : t('{songs} liked and playlist songs are not in the library. They are filled in if they are added later.', { songs: n(result.queued.songs) })}</li>)}
          </ul>
          {result.missing.length > 0 && (
            <details>
              <summary>{t('Most played songs not in the library ({n})', { n: `${result.missing.length}${result.missing.length >= 100 ? '+' : ''}` })}</summary>
              <ol>{result.missing.map((m, i) => <li key={i}>{m.artist} – {m.title}{m.plays ? <small> · {t('{n} plays', { n: n(m.plays) })}</small> : null}</li>)}</ol>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
