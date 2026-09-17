import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-auth-'));
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => { app = await buildServer({ dataDir: DATA }); });
afterAll(async () => { await app.close(); });

const login = (username: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, device: 'test' } });

describe('auth', () => {
  let admin = '';
  it('seeds admin/admin and forces a password change', async () => {
    const r = await login('admin', 'admin');
    expect(r.statusCode).toBe(200);
    admin = r.json().token; expect(admin).toBeTruthy();
    expect(r.json().user.mustChangePassword).toBe(true);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${admin}` } });
    expect(me.json().role).toBe('admin');
  });
  it('rejects wrong passwords and missing tokens', async () => {
    expect((await login('admin', 'nope')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });
  it('changes the password (no current needed while forced) and keeps this session', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/password', headers: { authorization: `Bearer ${admin}` }, payload: { password: 'correct horse battery' } });
    expect(r.statusCode).toBe(200);
    expect((await login('admin', 'admin')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${admin}` } })).json().mustChangePassword).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers: { authorization: `Bearer ${admin}` }, payload: { password: 'short' } })).statusCode).toBe(400);
  });
  let user = '', userIdv = '';
  it('invites a user by link; users are not admins', async () => {
    const inv = await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${admin}` } });
    expect(inv.statusCode).toBe(200);
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { invite: inv.json().code, username: 'henry', password: 'henrys password' } });
    expect(reg.statusCode).toBe(200); user = reg.json().token; userIdv = reg.json().user.id;
    expect((await app.inject({ method: 'POST', url: '/api/auth/register', payload: { invite: inv.json().code, username: 'again', password: 'henrys password' } })).statusCode).toBe(400); // single use
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: { authorization: `Bearer ${user}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${user}` } })).statusCode).toBe(403);
  });
  it('admins promote and demote, never themselves', async () => {
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${admin}` } })).json();
    expect((await app.inject({ method: 'POST', url: `/api/users/${userIdv}/role`, headers: { authorization: `Bearer ${admin}` }, payload: { role: 'admin' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: { authorization: `Bearer ${user}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/users/${me.id}/role`, headers: { authorization: `Bearer ${admin}` }, payload: { role: 'user' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/users/${userIdv}/role`, headers: { authorization: `Bearer ${admin}` }, payload: { role: 'user' } })).statusCode).toBe(200);
  });
  it('lists and revokes devices; a token also works as a query param (media URLs)', async () => {
    await login('henry', 'henrys password');
    const d = (await app.inject({ method: 'GET', url: `/api/auth/devices?token=${user}` })).json();
    expect(d.devices.length).toBe(2);
    const other = d.devices.find((x: any) => !x.current);
    expect((await app.inject({ method: 'DELETE', url: `/api/auth/devices/${other.id}`, headers: { authorization: `Bearer ${user}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/devices', headers: { authorization: `Bearer ${user}` } })).json().devices.length).toBe(1);
  });
  it('logs out', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${user}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${user}` } })).statusCode).toBe(401);
  });
});
