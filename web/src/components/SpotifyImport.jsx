import React, { useRef, useState } from 'react';

// Settings › Import from Spotify: upload the export zip(s), the server
// matches plays, Liked Songs, saved albums and playlists to the library.
// Safe to run again with a newer export: nothing is added twice.
const n = (x) => Number(x || 0).toLocaleString();

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
        const label = files.length > 1 ? `Uploading ${f.name} (${i + 1} of ${files.length})` : `Uploading ${f.name}`;
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
        Brings your Spotify listening history, Liked Songs, saved albums and playlists in, matched to songs in this library.
        Request the data at <a href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">spotify.com › Account › Privacy</a>:
        tick <b>Account data</b> (liked songs, playlists, the last year of plays) and, for every play since you joined, <b>Extended streaming history</b>.
        Spotify emails a <code>my_spotify_data.zip</code> for each. Upload one or both, as zips or the JSON files inside.
        Running it again with a newer export only adds what is new.
      </div>
      <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" multiple hidden onChange={(e) => run([...e.target.files])} />
      <div className="settings-actions">
        <button type="button" className="primary" disabled={!!busy} onClick={() => input.current?.click()}>{busy ? 'Importing…' : 'Choose files'}</button>
        {busy && <span className="settings-hint" style={{ margin: 0 }}>{busy}</span>}
      </div>
      {error && <p className="genpl-error" style={{ marginTop: 12 }}>{error}</p>}
      {result && (
        <div className="spimport-result">
          <ul>
            <li><b>{n(result.plays.added)}</b> plays added ({n(result.plays.matched)} of {n(result.plays.total)} matched)</li>
            <li><b>{n(result.likes.added)}</b> liked songs added ({n(result.likes.matched)} of {n(result.likes.total)} matched)</li>
            {result.albums.total > 0 && <li><b>{n(result.albums.added)}</b> saved albums added ({n(result.albums.matched)} of {n(result.albums.total)} matched)</li>}
            <li><b>{n(result.playlists.created)}</b> playlists created ({n(result.playlists.songsMatched)} of {n(result.playlists.songs)} songs matched){result.playlists.skipped.length ? `, ${result.playlists.skipped.length} skipped because a playlist with that name exists` : ''}</li>
            <li>{n(result.songs.matched)} of {n(result.songs.total)} different songs are in this library</li>
          </ul>
          {result.missing.length > 0 && (
            <details>
              <summary>Most played songs not in the library ({result.missing.length}{result.missing.length >= 100 ? '+' : ''})</summary>
              <ol>{result.missing.map((m, i) => <li key={i}>{m.artist} – {m.title}{m.plays ? <small> · {n(m.plays)} plays</small> : null}</li>)}</ol>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
