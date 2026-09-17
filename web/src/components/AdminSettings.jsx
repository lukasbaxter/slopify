// Server administration, shown in Settings to admins: the library (scan,
// lyrics and artwork fetching, what is still missing), the speakers the
// server can see, and the accounts (roles, removal, invites for new ones).
// Same building blocks as the rest of Settings.
import { useEffect, useState } from 'react';

const fmtN = (n) => (n ?? 0).toLocaleString('en-US');
const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`; };

export function useAdminStatus(jf, every = 5000) {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!jf) return undefined;
    let alive = true;
    const tick = () => jf.adminStatus().then((s) => { if (alive) { setStatus(s); setErr(null); } }).catch((e) => { if (alive) setErr(e.message); });
    tick();
    const t = setInterval(tick, every);
    return () => { alive = false; clearInterval(t); };
  }, [jf, every]);
  return [status, err];
}

export function AdminSettings({ jf, me, notify, phone = false }) {
  const [status, err] = useAdminStatus(jf);
  const [users, setUsers] = useState(null);
  const [invite, setInvite] = useState(null);
  const [busy, setBusy] = useState('');
  const loadUsers = () => jf.users().then((r) => setUsers(r.users || [])).catch(() => setUsers([]));
  useEffect(() => { loadUsers(); }, [jf]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what, fn, done) => {
    setBusy(what);
    try { await fn(); if (done) notify?.(done); } catch (e) { notify?.(`Could not ${what}: ${e.message}`); }
    finally { setBusy(''); }
  };
  const lib = status?.library || {};
  const scan = status?.scans?.[0];
  const lyrics = Object.fromEntries((status?.lyrics || []).map((r) => [r.kind, r.n]));
  const synced = lyrics.synced || 0, plain = lyrics.plain || 0, instrumental = lyrics.instrumental || 0;
  const Row = ({ label, value }) => <div className="admin-stat"><span>{label}</span><b>{value}</b></div>;

  return (
    <>
      <section className="settings-section admin">
        <h2>Library</h2>
        {err && <div className="settings-hint">Could not reach the server: {err}</div>}
        {status && (
          <div className="admin-stats">
            <Row label="Tracks" value={fmtN(lib.tracks)} />
            <Row label="Albums" value={fmtN(lib.albums)} />
            <Row label="Artists" value={fmtN(lib.artists)} />
            <Row label="Lyrics" value={`${fmtN(synced)} synced · ${fmtN(plain)} plain · ${fmtN(instrumental)} instrumental · ${fmtN(status.missingLyrics)} missing`} />
            <Row label="Artist pictures" value={`${fmtN(lib.artistsWithImage)} of ${fmtN(lib.artists)}`} />
            <Row label="Last scan" value={status.scanning ? `running (${fmtN(status.scanning.files)} files, ${fmtN(status.scanning.added)} new)` : scan ? `${ago(scan.finished || scan.started)} · ${fmtN(scan.files)} files, ${fmtN(scan.added)} added, ${fmtN(scan.changed)} changed, ${fmtN(scan.removed)} removed${scan.error ? ` · ${scan.error}` : ''}` : 'never'} />
            <Row label="Fetching" value={status.enriching ? 'running' : `idle · ${fmtN(status.enrich?.lyrics?.pending)} lyrics to try`} />
          </div>
        )}
        <div className="settings-actions">
          <button type="button" className="primary" disabled={!!busy || !!status?.scanning} onClick={() => run('scan', () => jf.adminScan(), 'Scan started')}>{status?.scanning ? 'Scanning…' : 'Scan library now'}</button>
          <button type="button" className="btn-secondary" disabled={!!busy || !!status?.enriching} onClick={() => run('fetch', () => jf.adminEnrich(), 'Fetching lyrics and artwork')}>{status?.enriching ? 'Fetching…' : 'Fetch lyrics & artwork now'}</button>
        </div>
        <div className="settings-hint">The music folder is scanned at start and every 6 hours; lyrics and artist pictures are fetched hourly for whatever is still missing.</div>
      </section>

      {status?.speakers && (
        <section className="settings-section admin">
          <h2>Speakers</h2>
          {status.speakers.length ? (
            <ul className="admin-list">
              {status.speakers.map((d) => <li key={d.id}><b>{d.name}</b><span>{d.kind === 'cast' ? 'Chromecast' : d.kind === 'bluos' ? 'BluOS' : d.kind} · {d.host}{d.playing ? ' · playing' : ''}</span></li>)}
            </ul>
          ) : <div className="settings-hint">No Chromecast or BluOS players found on the server's network yet. They are looked for continuously.</div>}
        </section>
      )}

      <section className="settings-section admin">
        <h2>Accounts</h2>
        {users && (
          <ul className="admin-list">
            {users.map((u) => (
              <li key={u.id}>
                <b>{u.name}{u.id === me?.Id ? ' (you)' : ''}</b>
                <span>{u.role === 'admin' ? 'Admin' : 'User'} · last seen {ago(u.last_seen)}</span>
                {u.id !== me?.Id && (
                  <span className="admin-list-actions">
                    <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => run('change role', () => jf.setRole(u.id, u.role === 'admin' ? 'user' : 'admin').then(loadUsers), u.role === 'admin' ? `${u.name} is a user now` : `${u.name} is an admin now`)}>{u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
                    <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => { if (window.confirm(`Remove ${u.name}'s account? Their likes, playlists and history go with it.`)) run('remove', () => jf.deleteUser(u.id).then(loadUsers), `${u.name} removed`); }}>Remove</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="settings-actions">
          <button type="button" className="primary" disabled={!!busy} onClick={() => run('make invite', async () => { const r = await jf.createInvite(); setInvite({ ...r, url: `${jf.baseUrl}/?invite=${encodeURIComponent(r.code)}` }); })}>New invite link</button>
          {invite && (
            <>
              <input className="settings-input" readOnly value={invite.url} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn-secondary" onClick={() => { navigator.clipboard?.writeText(invite.url).then(() => notify?.('Invite link copied')).catch(() => {}); }}>Copy</button>
            </>
          )}
        </div>
        <div className="settings-hint">An invite link lets someone make their own account; it works once and expires in 7 days.{phone ? '' : ' Admins can scan the library, fetch lyrics and manage accounts.'}</div>
      </section>
    </>
  );
}
