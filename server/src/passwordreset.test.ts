import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { tempPassword } from './auth.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-pwreset-'));
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => { app = await buildServer({ dataDir: DATA }); });
afterAll(async () => { await app.close(); });

const login = (username: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, device: 'test' } });
const as = (tok: string) => ({ authorization: `Bearer ${tok}` });
const reset = (tok: string, id: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/users/${id}/password`, headers: as(tok), payload });

describe('admin password reset', () => {
  let admin = '', adminId = '', bob = '', bobId = '', bobPhone = '';
  beforeAll(async () => {
    admin = (await login('admin', 'admin')).json().token;
    await app.inject({ method: 'POST', url: '/api/auth/password', headers: as(admin), payload: { password: 'admin password here' } });
    adminId = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(admin) })).json().id;
    const inv = (await app.inject({ method: 'POST', url: '/api/invites', headers: as(admin) })).json().code;
    const reg = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { invite: inv, username: 'bob', password: 'bobs old password' } })).json();
    bob = reg.token; bobId = reg.user.id;
    bobPhone = (await login('bob', 'bobs old password')).json().token;
  });

  it('temporary passwords are readable and long enough', () => {
    const p = tempPassword();
    expect(p).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(p).not.toMatch(/[01ilo]/);
    expect(new Set(Array.from({ length: 50 }, tempPassword)).size).toBe(50);
  });

  it('is admin only', async () => {
    const r = await reset(bob, adminId);
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/users/${bobId}/password`, payload: {} })).statusCode).toBe(401);
  });

  it('refuses your own account, unknown users and short passwords', async () => {
    const self = await reset(admin, adminId);
    expect(self.statusCode).toBe(400);
    expect((await reset(admin, 'no-such-user')).statusCode).toBe(404);
    expect((await reset(admin, bobId, { password: 'short' })).statusCode).toBe(400);
    expect((await login('bob', 'bobs old password')).statusCode).toBe(200); // nothing changed
  });

  it('resets: old password and old sign-ins are dead, the temporary one forces a change', async () => {
    const revoked: string[] = [];
    const orig = (app as any).sessionRevoke;
    (app as any).sessionRevoke = (t: string) => { revoked.push(t); orig(t); };
    const r = await reset(admin, bobId);
    (app as any).sessionRevoke = orig;
    expect(r.statusCode).toBe(200);
    const temp = r.json().password as string;
    expect(temp.length).toBeGreaterThanOrEqual(8);
    expect(revoked).toEqual(expect.arrayContaining([bob, bobPhone]));

    expect((await login('bob', 'bobs old password')).statusCode).toBe(401);
    for (const tok of [bob, bobPhone]) expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(tok) })).statusCode).toBe(401);
    // the admin's own session and role are untouched
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(admin) })).json();
    expect(me.role).toBe('admin'); expect(me.mustChangePassword).toBe(false);

    const t = await login('bob', temp);
    expect(t.statusCode).toBe(200);
    expect(t.json().user.mustChangePassword).toBe(true);
    expect(t.json().user.role).toBe('user');
    const tok = t.json().token;
    const blocked = await app.inject({ method: 'GET', url: '/api/albums', headers: as(tok) });
    expect(blocked.statusCode).toBe(403); expect(blocked.json().error).toBe('password change required');
    // no current password needed while the change is forced
    expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers: as(tok), payload: { password: 'bobs new password' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/albums', headers: as(tok) })).statusCode).toBe(200);
    expect((await login('bob', temp)).statusCode).toBe(401);
    expect((await login('bob', 'bobs new password')).statusCode).toBe(200);
  });

  it('takes a temporary password the admin chose', async () => {
    const r = await reset(admin, bobId, { password: 'given by admin' });
    expect(r.statusCode).toBe(200); expect(r.json().password).toBe('given by admin');
    const t = await login('bob', 'given by admin');
    expect(t.statusCode).toBe(200); expect(t.json().user.mustChangePassword).toBe(true);
  });

  it('works on another admin without changing roles', async () => {
    await app.inject({ method: 'POST', url: `/api/users/${bobId}/role`, headers: as(admin), payload: { role: 'admin' } });
    const r = await reset(admin, bobId);
    expect(r.statusCode).toBe(200);
    const t = (await login('bob', r.json().password)).json();
    expect(t.user.role).toBe('admin'); expect(t.user.mustChangePassword).toBe(true);
    // a forced change also blocks admin routes, this one included
    expect((await reset(t.token, adminId)).statusCode).toBe(403);
  });
});
