import { useEffect, useState } from 'react';
import { auth, del, get, post } from '../api/client';
import { app, navigate } from '../state/app';
import { player, setQuality } from '../state/player';
import { ChangePassword } from './Login';

const QUALITIES = [['original', 'Lossless (original file)'], ['aac-320', 'Very high (320 kbps AAC)'], ['aac-160', 'Normal (160 kbps)'], ['aac-96', 'Low (96 kbps)']];
export function Settings() {
  const user = app.use((s) => s.user)!;
  const quality = player.use((s) => s.quality);
  const [devices, setDevices] = useState<any[]>([]);
  const load = () => get<{ devices: any[] }>('/auth/devices').then((r) => setDevices(r.devices)).catch(() => {});
  useEffect(() => { load(); }, []);
  const logout = async () => { await post('/auth/logout').catch(() => {}); auth.token = ''; app.set({ user: null }); };
  return (
    <div className="page">
      <h1>Settings</h1>
      <section><h2>Streaming quality</h2><p className="muted">On this device. Applies from the next song.</p>
        {QUALITIES.map(([id, label]) => <label key={id} className="radio"><input type="radio" name="q" checked={quality === id} onChange={() => setQuality(id)} />{label}</label>)}
      </section>
      <section><h2>Devices signed in as {user.name}</h2>
        <ul className="plain">{devices.map((d) => <li key={d.id}><span>{d.device} · {d.kind}{d.current ? ' · this one' : ''}</span>{!d.current && <button className="secondary small" onClick={() => del(`/auth/devices/${d.id}`).then(load)}>Sign out</button>}</li>)}</ul>
      </section>
      <section><ChangePassword forced={false} /></section>
      {user.role === 'admin' && <section><button className="secondary" onClick={() => navigate({ view: 'admin' })}>Admin</button></section>}
      <section><button className="secondary" onClick={logout}>Log out</button></section>
    </div>
  );
}

export function Admin() {
  const [status, setStatus] = useState<any>(null); const [users, setUsers] = useState<any[]>([]); const [invite, setInvite] = useState('');
  const me = app.use((s) => s.user)!;
  const load = () => { get('/admin/status').then(setStatus).catch(() => {}); get<{ users: any[] }>('/users').then((r) => setUsers(r.users)).catch(() => {}); };
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, []);
  return (
    <div className="page">
      <h1>Admin</h1>
      <section><h2>Library</h2>
        {status && <p className="muted">{status.scanning ? `Scanning… ${status.scanning.files} files` : status.scans[0] ? `Last scan: ${status.scans[0].files} files, +${status.scans[0].added} / ~${status.scans[0].changed} / -${status.scans[0].removed}` : 'Never scanned'} · {status.missingLyrics} songs without lyrics</p>}
        <button className="primary" onClick={() => post('/admin/scan').then(load)} disabled={!!status?.scanning}>Scan now</button>
      </section>
      <section><h2>Users</h2>
        <ul className="plain">{users.map((u) => <li key={u.id}><span>{u.name} · {u.role}</span>{u.id !== me.id && <span className="actions"><button className="secondary small" onClick={() => post(`/users/${u.id}/role`, { role: u.role === 'admin' ? 'user' : 'admin' }).then(load)}>{u.role === 'admin' ? 'Make user' : 'Make admin'}</button><button className="secondary small" onClick={() => confirm(`Delete ${u.name}?`) && del(`/users/${u.id}`).then(load)}>Delete</button></span>}</li>)}</ul>
        <button className="secondary" onClick={() => post<{ code: string }>('/invites').then((r) => setInvite(`${location.origin}/#/join?code=${r.code}`))}>Create invite link</button>
        {invite && <p className="muted"><code>{invite}</code> (7 days, single use)</p>}
      </section>
    </div>
  );
}
