// Account bugs that came back before: each test here failed on the code
// before its fix.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-authreg-'));
let app: Awaited<ReturnType<typeof buildServer>>; let admin = '';
const invite = async () => (await app.inject({ method: 'POST', url: '/api/invites', headers: { authorization: `Bearer ${admin}` } })).json().code as string;
const register = (code: string, username: string) => app.inject({ method: 'POST', url: '/api/auth/register', payload: { invite: code, username, password: 'a good password' } });

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: DATA });
  admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${admin}` } });
});
afterAll(async () => { await app.close(); });

describe('registering with an invite', () => {
  it('one invite never makes two accounts, however close together they register', async () => {
    const code = await invite();
    const [a, b] = await Promise.all([register(code, 'racer_a'), register(code, 'racer_b')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const made = (app as any).db.prepare("SELECT COUNT(*) n FROM users WHERE name IN ('racer_a', 'racer_b')").get().n;
    expect(made).toBe(1);
  });
  it('a name taken while the password was hashing is a 409, never a 500, and the invite is not used up', async () => {
    const [c1, c2] = [await invite(), await invite()];
    const [a, b] = await Promise.all([register(c1, 'samename'), register(c2, 'SameName')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? c1 : c2;
    expect((await register(loser, 'othername')).statusCode).toBe(200);
  });
});
