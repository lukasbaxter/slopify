import { useState } from 'react';
import { auth, post, type User } from '../api/client';
import { app } from '../state/app';

export function Login() {
  const [name, setName] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await post<{ token: string; user: User }>('/auth/login', { username: name.trim(), password: pw, device: navigator.userAgent.slice(0, 60), kind: 'web' });
      auth.token = r.token; app.set({ user: r.user });
    } catch (e: any) { setErr(e.message || 'Login failed'); } finally { setBusy(false); }
  };
  return (
    <main className="login">
      <form onSubmit={submit} aria-labelledby="login-h">
        <h1 id="login-h">Slopify</h1>
        <label>Username<input autoFocus autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
        {err && <p role="alert" className="error">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Log in'}</button>
      </form>
    </main>
  );
}

export function ChangePassword({ forced }: { forced: boolean }) {
  const [cur, setCur] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [err, setErr] = useState(''); const [ok, setOk] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw !== pw2) return setErr('Passwords do not match');
    try { await post('/auth/password', { current: forced ? undefined : cur, password: pw }); setOk(true); app.set((s) => ({ user: s.user ? { ...s.user, mustChangePassword: false } : null })); }
    catch (e: any) { setErr(e.message); }
  };
  if (ok && !forced) return <p className="ok">Password changed.</p>;
  return (
    <form onSubmit={submit} className="pwform" aria-labelledby="pw-h">
      <h2 id="pw-h">{forced ? 'Choose a new password' : 'Change password'}</h2>
      {forced && <p>The default admin password must be replaced before you continue.</p>}
      {!forced && <label>Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>}
      <label>New password<input type="password" autoComplete="new-password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
      <label>Repeat it<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
      {err && <p role="alert" className="error">{err}</p>}
      <button className="primary">Save</button>
    </form>
  );
}
