// Server administration, shown in Settings to admins: the library (scan,
// lyrics and artwork fetching, what is still missing), the speakers the
// server can see, and the accounts (roles, removal, invites for new ones).
// Same building blocks as the rest of Settings.
import { useEffect, useRef, useState } from 'react';
import { t, N_, language } from '../i18n.js';

const fmtN = (n) => (n ?? 0).toLocaleString(language());
const ago = (at) => { if (!at) return t('never'); const s = Math.round((Date.now() - at) / 1000); if (s < 60) return t('just now'); if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) }); if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) }); return t('{n} d ago', { n: Math.round(s / 86400) }); };

export function useAdminStatus(jf, every = 5000) {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!jf) return undefined;
    let alive = true;
    const tick = () => jf.adminStatus().then((s) => { if (alive) { setStatus(s); setErr(null); } }).catch((e) => { if (alive) setErr(e.message); });
    tick();
    const timer = setInterval(() => { if (!document.hidden) tick(); }, every);
    return () => { alive = false; clearInterval(timer); };
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
  lyricsync: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M8 9h8" /><path d="M8 13h5" /></svg>,
};
const DAYS = [N_('Sunday'), N_('Monday'), N_('Tuesday'), N_('Wednesday'), N_('Thursday'), N_('Friday'), N_('Saturday')];
const HOURS = [[0.25, N_('15 min')], [0.5, N_('30 min')], [1, N_('hour')], [2, N_('2 h')], [3, N_('3 h')], [6, N_('6 h')], [12, N_('12 h')], [24, N_('24 h')]];

// The schedule, editable in place: every N hours, daily or weekly at a
// time, on file change (tasks that watch a folder), or off.
// One of a task's own knobs. Selects and switches save as they change; a
// number saves when you leave the field or press Enter.
function TaskSetting({ s, onSave }) {
  const [draft, setDraft] = useState(null);
  const id = `task-set-${s.key}`;
  if (s.type === 'toggle') {
    return (
      <label className="task-set task-set-toggle" htmlFor={id}>
        <span><b>{s.label}</b>{s.help && <small>{s.help}</small>}</span>
        <input id={id} type="checkbox" className="task-switch" checked={!!s.value} onChange={(e) => onSave(s.key, e.target.checked)} />
      </label>
    );
  }
  return (
    <label className="task-set" htmlFor={id}>
      <span><b>{s.label}</b>{s.help && <small>{s.help}</small>}</span>
      {s.type === 'select' ? (
        <select id={id} value={s.value} onChange={(e) => onSave(s.key, e.target.value)}>
          {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <span className="task-set-num">
          <input id={id} type="number" min={s.min} max={s.max} value={draft ?? s.value}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (draft != null && draft !== '' && Number(draft) !== s.value) onSave(s.key, Number(draft)); setDraft(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          {s.unit && <em>{s.unit}</em>}
        </span>
      )}
    </label>
  );
}

// The ⋯ menu on a task row: what the task does and its own settings. Sync
// lyrics also shows what it has done so far, with a way to put it all back.
function TaskMenu({ jf, task, onSettings, notify }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) { setConfirmUndo(false); return undefined; }
    const down = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    if (task.id === 'lyricsync') jf._fetch('/api/admin/lyricsync').then(setStats).catch(() => {});
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (state) => fmtN((stats?.states || []).find((x) => x.state === state)?.n || 0);
  const undo = () => jf._fetch('/api/admin/lyricsync/undo', { method: 'POST' })
    .then((r) => { notify?.(t("Put back {n} songs' lyrics", { n: fmtN(r.restored) })); setConfirmUndo(false); return jf._fetch('/api/admin/lyricsync').then(setStats); })
    .catch((e) => notify?.(t('Could not undo: {error}', { error: e.message })));
  return (
    <span className="task-menu" ref={ref}>
      <button type="button" className="task-dots" aria-label={t('{name} settings', { name: task.name })} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
      </button>
      {open && (
        <div className="task-pop" role="dialog" aria-label={t('{name} settings', { name: task.name })}>
          <p className="task-pop-desc">{task.description}</p>
          {(task.settings || []).map((s) => <TaskSetting key={s.key} s={s} onSave={(k, v) => onSettings(task, { [k]: v })} />)}
          {!task.settings?.length && <p className="task-pop-desc">{t('Nothing to adjust for this one.')}</p>}
          {task.id === 'lyricsync' && stats && (
            <div className="task-pop-stats">
              <span>{t('{timed} timed · {verified} verified · {corrected} corrected · {unsure} unsure · {failed} failed · {pending} to check', { timed: n('synced'), verified: n('verified'), corrected: n('corrected'), unsure: n('unsure'), failed: n('failed'), pending: fmtN(stats.pending) })}</span>
              {!confirmUndo
                ? <button type="button" className="btn-secondary" onClick={() => setConfirmUndo(true)}>{t('Undo all changes…')}</button>
                : (
                  <span className="task-pop-confirm">
                    {t('Put every timed and corrected song back the way it was?')}
                    <button type="button" className="btn-secondary" onClick={undo}>{t('Put back')}</button>
                    <button type="button" className="btn-secondary" onClick={() => setConfirmUndo(false)}>{t('Keep')}</button>
                  </span>
                )}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

function TaskSchedule({ task, onChange }) {
  const save = (schedule) => onChange(schedule);
  const s = task.schedule;
  // The time input is committed when editing finishes (blur / Enter), not on
  // every segment keystroke -- typing 04:30 must not PUT three times.
  const [atDraft, setAtDraft] = useState(null);
  const commitAt = () => { if (atDraft && atDraft !== s.at) save({ ...s, at: atDraft }); setAtDraft(null); };
  return (
    <span className="task-sched">
      <select value={s.mode} aria-label={t('{name} schedule', { name: task.name })} onChange={(e) => {
        const m = e.target.value;
        save(m === 'interval' ? { mode: 'interval', hours: 6 } : m === 'daily' ? { mode: 'daily', at: '04:00' } : m === 'weekly' ? { mode: 'weekly', day: 0, at: '04:00' } : { mode: m });
      }}>
        <option value="interval">{t('Every…')}</option>
        <option value="daily">{t('Daily at…')}</option>
        <option value="weekly">{t('Weekly…')}</option>
        {task.canWatch && <option value="watch">{t('On file change')}</option>}
        <option value="off">{t('Off')}</option>
      </select>
      {s.mode === 'interval' && (
        <select value={s.hours} aria-label={t('interval')} onChange={(e) => save({ mode: 'interval', hours: Number(e.target.value) })}>
          {HOURS.map(([h, label]) => <option key={h} value={h}>{t(label)}</option>)}
          {!HOURS.some(([h]) => h === s.hours) && <option value={s.hours}>{t('{n} h', { n: s.hours })}</option>}
        </select>
      )}
      {s.mode === 'weekly' && (
        <select value={s.day} aria-label={t('day')} onChange={(e) => save({ ...s, day: Number(e.target.value) })}>
          {DAYS.map((d, i) => <option key={d} value={i}>{t(d)}</option>)}
        </select>
      )}
      {(s.mode === 'daily' || s.mode === 'weekly') && (
        <input type="time" value={atDraft ?? s.at} aria-label={t('time')}
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
    const timer = setInterval(() => { if (!document.hidden) tick(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [jf]); // eslint-disable-line react-hooks/exhaustive-deps
  // Schedule changes show at once and the PUT's answer (the task as the
  // server now has it) reconciles; an error rolls back to the server's list.
  const onSchedule = (task, schedule) => {
    taskSeq.current += 1;
    setTasks((ts) => (ts || []).map((x) => (x.id === task.id ? { ...x, schedule } : x)));
    return jf._fetch(`/api/admin/tasks/${task.id}/schedule`, { method: 'PUT', body: JSON.stringify({ schedule }) })
      .then((out) => { taskSeq.current += 1; setTasks((ts) => (ts || []).map((x) => (x.id === out.id ? out : x))); })
      .catch((e) => { notify?.(t('Could not change the schedule: {error}', { error: e.message })); taskSeq.current += 1; loadTasks(); });
  };
  // Settings save the same way: shown at once, reconciled by the answer.
  const onSettings = (task, values) => {
    taskSeq.current += 1;
    setTasks((ts) => (ts || []).map((x) => (x.id === task.id ? { ...x, settings: x.settings.map((s) => (s.key in values ? { ...s, value: values[s.key] } : s)) } : x)));
    return jf._fetch(`/api/admin/tasks/${task.id}/settings`, { method: 'PUT', body: JSON.stringify({ values }) })
      .then((out) => { taskSeq.current += 1; setTasks((ts) => (ts || []).map((x) => (x.id === out.id ? out : x))); })
      .catch((e) => { notify?.(t('Could not save that setting: {error}', { error: e.message })); taskSeq.current += 1; loadTasks(); });
  };
  const loadUsers = () => jf.users().then((r) => setUsers(r.users || [])).catch(() => setUsers([]));
  useEffect(() => { loadUsers(); }, [jf]); // eslint-disable-line react-hooks/exhaustive-deps

  // The ref blocks the double-click that lands before the re-render disables
  // the button (two "Run now" POSTs = a 409 and a confusing toast).
  // `failed` is the whole "Could not ..." sentence, shown with the error.
  const busyRef = useRef(false);
  const run = async (failed, fn, done) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(failed);
    try { await fn(); if (done) notify?.(done); } catch (e) { notify?.(`${failed}: ${e.message}`); }
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
        <h2>{t('Library')}</h2>
        {err && <div className="settings-hint">{t('Could not reach the server: {error}', { error: err })}</div>}
        {status && (
          <div className="admin-stats">
            <Row label={t('Tracks')} value={fmtN(lib.tracks)} />
            <Row label={t('Albums')} value={fmtN(lib.albums)} />
            <Row label={t('Artists')} value={fmtN(lib.artists)} />
            <Row label={t('Lyrics')} value={t('{synced} synced · {plain} plain · {instrumental} instrumental · {missing} missing', { synced: fmtN(synced), plain: fmtN(plain), instrumental: fmtN(instrumental), missing: fmtN(status.missingLyrics) })} />
            <Row label={t('Artist pictures')} value={t('{n} of {total}', { n: fmtN(lib.artistsWithImage), total: fmtN(lib.artists) })} />
            <Row label={t('Last scan')} value={status.scanning ? t('running ({files} files, {added} new)', { files: fmtN(status.scanning.files), added: fmtN(status.scanning.added) }) : scan ? `${ago(scan.finished || scan.started)} · ${t('{files} files, {added} added, {changed} changed, {removed} removed', { files: fmtN(scan.files), added: fmtN(scan.added), changed: fmtN(scan.changed), removed: fmtN(scan.removed) })}${scan.error ? ` · ${scan.error}` : ''}` : t('never')} />
            <Row label={t('Fetching')} value={status.enriching ? t('running') : t('idle · {n} lyrics to try', { n: fmtN(status.enrich?.lyrics?.pending) })} />
          </div>
        )}
        <div className="settings-actions">
          <button type="button" className="primary" disabled={!!busy || !!status?.scanning} onClick={() => run(t('Could not scan'), () => jf.adminScan(), t('Scan started'))}>{status?.scanning ? t('Scanning…') : t('Scan library now')}</button>
          <button type="button" className="btn-secondary" disabled={!!busy || !!status?.enriching} onClick={() => run(t('Could not fetch'), () => jf.adminEnrich(), t('Fetching lyrics and artwork'))}>{status?.enriching ? t('Fetching…') : t('Fetch lyrics & artwork now')}</button>
        </div>
        <div className="settings-hint">{t('Recurring work runs from the Tasks list below; these buttons are the same two chores, started by hand.')}</div>
      </section>

      {tasks && (
        <section className="settings-section admin">
          <h2>{t('Tasks')}</h2>
          <ul className="admin-list task-list">
            {tasks.map((task) => (
              <li key={task.id} className={`task-row ${task.running ? 'running' : ''}`} title={task.description}>
                <span className="task-ico" aria-hidden="true">{TASK_ICONS[task.id] || TASK_ICONS.scan}</span>
                <b className="task-name">{task.name}</b>
                <span className="task-meta" title={task.last?.summary || undefined}>
                  {task.running ? `${task.running.step}${task.running.progress != null ? ` · ${Math.round(task.running.progress * 100)}%` : ''}`
                    : task.last ? `${task.last.ok ? '' : `${t('failed')} · `}${ago(task.last.started)}${task.last.summary ? ` · ${task.last.summary}` : ''}${task.last.error ? ` · ${task.last.error}` : ''}`
                    : t('never run')}
                </span>
                <TaskSchedule task={task} onChange={(schedule) => onSchedule(task, schedule)} />
                <button type="button" className="btn-secondary task-run" disabled={!!busy || !!task.running} onClick={() => run(t('Could not run {name}', { name: task.name }), () => jf._fetch(`/api/admin/tasks/${task.id}/run`, { method: 'POST' }).then(loadTasks), t('{name} started', { name: task.name }))}>{task.running ? t('Running…') : t('Run now')}</button>
                <TaskMenu jf={jf} task={task} notify={notify} onSettings={onSettings} />
                {task.running && <span className="task-bar" style={{ '--p': task.running.progress != null ? Math.max(0.02, task.running.progress) : 0 }} data-indeterminate={task.running.progress == null ? '' : undefined} aria-hidden="true" />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {status?.speakers && (
        <section className="settings-section admin">
          <h2>{t('Speakers')}</h2>
          {status.speakers.length ? (
            <ul className="admin-list">
              {status.speakers.map((d) => <li key={d.id}><b>{d.name}</b><span>{d.kind === 'cast' ? 'Chromecast' : d.kind === 'bluos' ? 'BluOS' : d.model || d.kind} · {d.host}{d.playing ? ` · ${t('playing')}` : ''}</span></li>)}
            </ul>
          ) : <div className="settings-hint">{t("No Chromecast or BluOS players found on the server's network yet. They are looked for continuously.")}</div>}
        </section>
      )}

      {status?.explore && (
        <section className="settings-section admin">
          <h2>{t('Weekly playlists')}</h2>
          <div className="settings-hint" style={{ marginBottom: 10 }}>
            {status.explore.slskd
              ? t('Every Monday each account with a ListenBrainz token (Settings › Scrobbling) gets Weekly Exploration (new music, fetched from Soulseek) and Weekly Jams; Daily Jams every morning.')
              : t('Every Monday each account with a ListenBrainz token (Settings › Scrobbling) gets Weekly Exploration (new music, fetched from Soulseek — slskd is not configured on this server) and Weekly Jams; Daily Jams every morning.')}
            {status.explore.users.length ? '' : ` ${t('Nobody has a token yet.')}`}
          </div>
          {status.explore.users.length > 0 && (
            <ul className="admin-list">
              {status.explore.users.map((u) => (
                <li key={u.name}><b>{u.name}</b><span>{[['weekly-exploration', t('weekly exploration')], ['weekly-jams', t('weekly jams')], ['daily-jams', t('daily jams')]].map(([k, label]) => u[k] ? `${label}: ${u[k].matched}/${u[k].total} (${u[k].date})` : `${label}: ${t('none yet')}`).join(' · ')}</span></li>
              ))}
            </ul>
          )}
          <div className="settings-actions">
            <button type="button" className="primary" disabled={!!busy || status.explore.running} onClick={() => run(t('Could not build playlists'), () => jf._fetch('/api/admin/explore', { method: 'POST', body: JSON.stringify({ kinds: ['weekly-exploration', 'weekly-jams'] }) }), t("Building this week's playlists"))}>{status.explore.running ? t('Building…') : t("Make this week's playlists now")}</button>
            <button type="button" className="btn-secondary" disabled={!!busy || status.explore.running} onClick={() => run(t('Could not build playlist'), () => jf._fetch('/api/admin/explore', { method: 'POST', body: JSON.stringify({ kinds: ['daily-jams'] }) }), t('Building Daily Jams'))}>{t('Daily Jams now')}</button>
          </div>
        </section>
      )}

      <section className="settings-section admin">
        <h2>{t('Accounts')}</h2>
        {users && (
          <ul className="admin-list">
            {users.map((u) => (
              <li key={u.id}>
                <b>{u.id === me?.Id ? t('{name} (you)', { name: u.name }) : u.name}</b>
                <span>{u.role === 'admin' ? t('Admin') : t('User')} · {t('last seen {when}', { when: ago(u.last_seen) })}</span>
                {u.id !== me?.Id && (
                  <span className="admin-list-actions">
                    <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => run(t('Could not change role'), () => jf.setRole(u.id, u.role === 'admin' ? 'user' : 'admin').then(loadUsers), u.role === 'admin' ? t('{name} is a user now', { name: u.name }) : t('{name} is an admin now', { name: u.name }))}>{u.role === 'admin' ? t('Make user') : t('Make admin')}</button>
                    <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => { if (window.confirm(t("Remove {name}'s account? Their likes, playlists and history go with it.", { name: u.name }))) run(t('Could not remove'), () => jf.deleteUser(u.id).then(loadUsers), t('{name} removed', { name: u.name })); }}>{t('Remove')}</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="settings-actions">
          <button type="button" className="primary" disabled={!!busy} onClick={() => run(t('Could not make invite'), async () => { const r = await jf.createInvite(); setInvite({ ...r, url: `${jf.baseUrl}/?invite=${encodeURIComponent(r.code)}` }); })}>{t('New invite link')}</button>
          {invite && (
            <>
              <input className="settings-input" readOnly value={invite.url} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn-secondary" onClick={() => { navigator.clipboard?.writeText(invite.url).then(() => notify?.(t('Invite link copied'))).catch(() => {}); }}>{t('Copy')}</button>
            </>
          )}
        </div>
        <div className="settings-hint">{t('An invite link lets someone make their own account; it works once and expires in 7 days.')}{phone ? '' : ` ${t('Admins can scan the library, fetch lyrics and manage accounts.')}`}</div>
      </section>
    </>
  );
}
