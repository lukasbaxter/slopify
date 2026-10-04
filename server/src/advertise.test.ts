import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { records } from './advertise.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-adv-'));
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => { app = await buildServer({ dataDir: DATA, musicDir: DATA }); }, 60000);
afterAll(async () => { await app.close(); });

describe('finding the server on the network', () => {
  it('/api/server gives a signed-in app the same id every time, and nothing without a sign-in', async () => {
    expect((await app.inject({ url: '/api/server' })).statusCode).toBe(401);
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json().token;
    await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: { authorization: `Bearer ${tok}` } });
    const a = (await app.inject({ url: '/api/server', headers: { authorization: `Bearer ${tok}` } })).json();
    const b = (await app.inject({ url: '/api/server', headers: { authorization: `Bearer ${tok}` } })).json();
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect(b.id).toBe(a.id);
    // Every app links to the source (the AGPL asks it of a network service).
    expect(a).toMatchObject({ license: 'AGPL-3.0-or-later', source: 'https://github.com/lukasbaxter/slopify' });
    expect(a.version).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('the announcement points at the LAN address only, under a name of its own', () => {
    const r = records({ name: 'Slopify on box.lan', id: 'abcdef0123456789abcdef0123456789', port: 8090, address: '192.168.1.20' });
    expect(r.answers[0]).toMatchObject({ name: '_slopify._tcp.local', type: 'PTR', data: 'Slopify on box lan._slopify._tcp.local' });
    const a = r.additionals.filter((x) => x.type === 'A');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ name: 'slopify-abcdef01.local', data: '192.168.1.20' });
    expect(r.additionals.find((x) => x.type === 'SRV')!.data).toMatchObject({ port: 8090, target: 'slopify-abcdef01.local' });
    expect(r.additionals.find((x) => x.type === 'TXT')!.data).toEqual(['id=abcdef0123456789abcdef0123456789', 'name=Slopify on box.lan']);
    expect(records({ name: 'x', id: 'abcdef0123456789abcdef0123456789', port: 1, address: '10.0.0.1' }, 0).additionals.every((x) => x.ttl === 0)).toBe(true);
  });
});
