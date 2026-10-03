// Server administration, shown in Settings to admins: the library (scan,
// lyrics and artwork fetching, what is still missing), the speakers the
// server can see, and the accounts (roles, removal, invites for new ones).
// Same building blocks as the rest of Settings.
import { useEffect, useRef, useState } from 'react';

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
    const t = setInterval(() => { if (!document.hidden) tick(); }, every);
    return () => { alive = false; clearInterval(t); };
  }, [jf, every]);
  return [status, err];
}

// One small stroke icon per chore, sitting in a circle; the circle turns
// the accent color while the task runs.
const TASK_ICONS = {
  scan: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>,
  enrich: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-4.5-4.5L5 22" /></svg>,
  heads: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg>,
  discovery: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2z" /></svg>,
  backlog: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></svg>,
  flac: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9v6" /><path d="M7 6v12" /><path d="M11 10v4" /><path d="M18 19V7" /><path d="m14.5 10.5 3.5-3.5 3.5 3.5" /></svg>,
};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOURS = [[0.25, '15 min'], [0.5, '30 min'], [1, 'hour'], [2, '2 h'], [3, '3 h'], [6, '6 h'], [12, '12 h'], [24, '24 h']];

// The schedule, editable in place: every N hours, daily or weekly at a
// time, on file change (tasks that watch a folder), or off.
function TaskSchedule({ t, onChange }) {
  const save = (schedule) => onChange(schedule);
  const s = t.schedule;
  // The time input is committed when editing finishes (blur / Enter), not on
  // every segment keystroke -- typing 04:30 must not PUT three times.
  const [atDraft, setAtDraft] = useState(null);
  const commitAt = () => { if (atDraft && atDraft !== s.at) save({ ...s, at: atDraft }); setAtDraft(null); };
  return (
    <span className="task-sched">
      <select value={s.mode} aria-label={`${t.name} schedule`} onChange={(e) => {
        const m = e.target.value;
        save(m === 'interval' ? { mode: 'interval', hours: 6 } : m === 'daily' ? { mode: 'daily', at: '04:00' } : m === 'weekly' ? { mode: 'weekly', day: 0, at: '04:00' } : { mode: m });
      }}>
        <option value="interval">Every…</option>
        <option value="daily">Daily at…</option>
        <option value="weekly">Weekly…</option>
        {t.canWatch && <option value="watch">On file change</option>}
        <option value="off">Off</option>
      </select>
      {s.mode === 'interval' && (
        <select value={s.hours} aria-label="interval" onChange={(e) => save({ mode: 'interval', hours: Number(e.target.value) })}>
          {HOURS.map(([h, label]) => <option key={h} value={h}>{label}</option>)}
          {!HOURS.some(([h]) => h === s.hours) && <option value={s.hours}>{s.hours} h</option>}
        </select>
      )}
      {s.mode === 'weekly' && (
        <select value={s.day} aria-label="day" onChange={(e) => save({ ...s, day: Number(e.target.value) })}>
          {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
      )}
      {(s.mode === 'daily' || s.mode === 'weekly') && (
        <input type="time" value={atDraft ?? s.at} aria-label="time"
          onChange={(e) => setAtDraft(e.target.value)} onBlur={commitAt}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      )}
    </span>
  );
}

export function AdminSettings({ jf, me, notify, phone = false }) {
  const [status, err] = useAdminStatus(jf);
  const [tasks, setTasks] = useState(null);
  const [users, setUsers] = useState(null);
  const [invite, setInvite] = useState(null);
  const [busy, setBusy] = useState('');
  // Every accepted change bumps the seq; a poll that left before the change
  // is stale and must not revert what was just saved.
  const taskSeq = useRef(0);
  const loadTasks = () => { const seq = taskSeq.current; return jf._fetch('/api/admin/tasks').then((r) => { if (seq === taskSeq.current) setTasks(r.tasks || []); }).catch(() => {}); };
  useEffect(() => {
    if (!jf) return undefined;
    let alive = true;
    const tick = () => { const seq = taskSeq.current; jf._fetch('/api/admin/tasks').then((r) => { if (alive && seq === taskSeq.current) setTasks(r.tasks || []); }).catch(() => {}); };
    tick();
    const t = setInterval(() => { if (!document.hidden) tick(); }, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [jf]); // eslint-disable-line react-hooks/exhaustive-deps
  // Schedule changes show at once and the PUT's answer (the task as the
  // server now has it) reconciles; an error rolls back to the server's list.
  const onSchedule = (task, schedule) => {
    taskSeq.current += 1;
    setTasks((ts) => (ts || []).map((x) => (x.id === task.id ? { ...x, schedule } : x)));
    return jf._fetch(`/api/admin/tasks/${task.id}/schedule`, { method: 'PUT', body: JSON.stringify({ schedule }) })
      .then((out) => { taskSeq.current += 1; setTasks((ts) => (ts || []).map((x) => (x.id === out.id ? out : x))); })
      .catch((e) => { notify?.(`Could not change the schedule: ${e.message}`); taskSeq.current += 1; loadTasks(); });
  };
  const loadUsers = () => jf.users().then((r) => setUsers(r.users || [])).catch(() => setUsers([]));
  useEffect(() => { loadUsers(); }, [jf]); // eslint-disable-line react-hooks/exhaustive-deps

  // The ref blocks the double-click that lands before the re-render disables
  // the button (two "Run now" POSTs = a 409 and a confusing toast).
  const busyRef = useRef(false);
  const run = async (what, fn, done) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(what);
    try { await fn(); if (done) notify?.(done); } catch (e) { notify?.(`Could not ${what}: ${e.message}`); }
    finally { busyRef.current = false; setBusy(''); }
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
        <div className="settings-hint">Recurring work runs from the Tasks list below; these buttons are the same two chores, started by hand.</div>
      </section>

      {tasks && (
        <section className="settings-section admin">
          <h2>Tasks</h2>
          <ul className="admin-list task-list">
            {tasks.map((t) => (
              <li key={t.id} className={`task-row ${t.running ? 'running' : ''}`} title={t.description}>
                <span className="task-ico" aria-hidden="true">{TASK_ICONS[t.id] || TASK_ICONS.scan}</span>
                <b className="task-name">{t.name}</b>
                <span className="task-meta">
                  {t.running ? `${t.running.step}${t.running.progress != null ? ` · ${Math.round(t.running.progress * 100)}%` : ''}`
                    : t.last ? `${t.last.ok ? '' : 'failed · '}${ago(t.last.started)}${t.last.summary ? ` · ${t.last.summary}` : ''}${t.last.error ? ` · ${t.last.error}` : ''}`
                    : 'never run'}
                </span>
                <TaskSchedule t={t} onChange={(schedule) => onSchedule(t, schedule)} />
                <button type="button" className="btn-secondary task-run" disabled={!!busy || !!t.running} onClick={() => run(`run ${t.name}`, () => jf._fetch(`/api/admin/tasks/${t.id}/run`, { method: 'POST' }).then(loadTasks), `${t.name} started`)}>{t.running ? 'Running…' : 'Run now'}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {status?.explore && (
        <section className="settings-section admin">
          <h2>Weekly playlists</h2>
          <div className="settings-hint" style={{ marginBottom: 10 }}>
            Every Monday each account with a ListenBrainz token (Settings › Scrobbling) gets Weekly Exploration (new music, fetched from Soulseek{status.explore.slskd ? '' : ' — slskd is not configured on this server'}) and Weekly Jams; Daily Jams every morning.
            {status.explore.users.length ? '' : ' Nobody has a token yet.'}
          </div>
          {status.explore.users.length > 0 && (
            <ul className="admin-list">
              {status.explore.users.map((u) => (
                <li key={u.name}><b>{u.name}</b><span>{['weekly-exploration', 'weekly-jams', 'daily-jams'].map((k) => u[k] ? `${k.replace('-', ' ')}: ${u[k].matched}/${u[k].total} (${u[k].date})` : `${k.replace('-', ' ')}: none yet`).join(' · ')}</span></li>
              ))}
            </ul>
          )}
          <div className="settings-actions">
            <button type="button" className="primary" disabled={!!busy || status.explore.running} onClick={() => run('build playlists', () => jf._fetch('/api/admin/explore', { method: 'POST', body: JSON.stringify({ kinds: ['weekly-exploration', 'weekly-jams'] }) }), 'Building this week\'s playlists')}>{status.explore.running ? 'Building…' : "Make this week's playlists now"}</button>
            <button type="button" className="btn-secondary" disabled={!!busy || status.explore.running} onClick={() => run('build playlist', () => jf._fetch('/api/admin/explore', { method: 'POST', body: JSON.stringify({ kinds: ['daily-jams'] }) }), 'Building Daily Jams')}>Daily Jams now</button>
          </div>
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
