import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-reports-'));
let app: Awaited<ReturnType<typeof buildServer>>;
let token = '';

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: DATA });
  token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin reports password' }, headers: { authorization: `Bearer ${token}` } });
}, 60000);
afterAll(async () => { await app.close(); });

describe('problem reports', () => {
  it('keeps what was written, the logs and who sent it', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/reports', headers: { authorization: `Bearer ${token}`, 'user-agent': 'TestPhone' }, payload: { message: 'Lyrics stuck', logs: ['10:00:01 a', '10:00:02 b'], info: { page: 'home' } } });
    expect(r.statusCode).toBe(200);
    const row = (app as any).db.prepare('SELECT * FROM reports WHERE id = ?').get(r.json().id);
    expect(row).toMatchObject({ user_name: 'admin', device: 'TestPhone', message: 'Lyrics stuck', logs: '10:00:01 a\n10:00:02 b' });
    expect(JSON.parse(row.info)).toEqual({ page: 'home' });
    expect(row.created).toBeGreaterThan(Date.now() - 60000);
  });

  it('needs a message and a signed-in user', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/reports', headers: { authorization: `Bearer ${token}` }, payload: { message: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/reports', payload: { message: 'hi' } })).statusCode).toBe(401);
  });
});
