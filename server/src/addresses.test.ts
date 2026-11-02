import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
import { isPrivateIp, publicOriginOf } from './addresses.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-addr-'));
let app: Awaited<ReturnType<typeof buildServer>>;
let tok = '';
let userId = '';
const auth = () => ({ authorization: `Bearer ${tok}` });

beforeAll(async () => {
  app = await buildServer({ dataDir: DATA, musicDir: DATA });
  const r = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } })).json();
  tok = r.token; userId = r.userId || r.user?.id;
  await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'admin test password' }, headers: auth() });
  if (!userId) userId = (await app.inject({ url: '/api/auth/me', headers: auth() })).json().id;
}, 60000);
afterAll(async () => { await app.close(); });

describe('the phone app\'s home and internet addresses', () => {
  it('tells private networks from the internet', () => {
    for (const ip of ['192.168.1.5', '10.0.0.2', '172.20.1.1', '100.101.102.103', '127.0.0.1', '::1', '::ffff:192.168.1.5', 'fd12:3456::1', 'fe80::1']) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1', '::ffff:1.1.1.1']) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it('only remembers https names as internet addresses', () => {
    expect(publicOriginOf('https', 'music.example.com')).toBe('https://music.example.com');
    expect(publicOriginOf('https', 'music.example.com:443')).toBe('https://music.example.com');
    expect(publicOriginOf('https', 'music.example.com:8443')).toBe('https://music.example.com:8443');
    for (const [p, h] of [['http', 'music.example.com'], ['https', '192.168.1.5:8080'], ['https', 'nas.local'], ['https', 'nas'], ['https', 'localhost'], ['https', 'evil.com/x']]) expect(publicOriginOf(p, h), `${p} ${h}`).toBe(null);
  });
  it('a signed-in app gets its key and the LAN address; nobody else does', async () => {
    expect((await app.inject({ url: '/api/server/addresses' })).statusCode).toBe(401);
    const a = (await app.inject({ url: '/api/server/addresses', headers: auth() })).json();
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(a.public)).toBe(true);
  });
  it('proves it is this server to a phone on the LAN, with the key that phone holds', async () => {
    const { key } = (await app.inject({ url: '/api/server/addresses', headers: auth() })).json();
    const n = crypto.randomBytes(16).toString('hex');
    const r = await app.inject({ url: `/api/server/proof?u=${userId}&n=${n}`, remoteAddress: '192.168.1.40' });
    expect(r.statusCode).toBe(200);
    expect(r.json().proof).toBe(crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(n).digest('hex'));
    // Another account's key does not check out.
    const other = (await app.inject({ url: `/api/server/proof?u=someone-else&n=${n}`, remoteAddress: '192.168.1.40' })).json().proof;
    expect(other).not.toBe(r.json().proof);
  });
  it('never answers a proof for the internet (no relaying it for an impostor)', async () => {
    const n = 'a'.repeat(32);
    expect((await app.inject({ url: `/api/server/proof?u=${userId}&n=${n}`, remoteAddress: '203.0.113.9' })).statusCode).toBe(404);
    // Through the reverse proxy, the forwarded client counts, not the proxy.
    expect((await app.inject({ url: `/api/server/proof?u=${userId}&n=${n}`, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/server/proof?u=${userId}&n=nothex`, remoteAddress: '192.168.1.40' })).statusCode).toBe(400);
  });
  it('learns the internet address people reach it at through the proxy', async () => {
    await app.inject({ url: '/api/auth/me', remoteAddress: '127.0.0.1', headers: { ...auth(), 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'music.example.org', host: 'music.example.org' } });
    const a = (await app.inject({ url: '/api/server/addresses', headers: auth() })).json();
    expect(a.public).toContain('https://music.example.org');
    // Not from requests without a sign-in.
    await app.inject({ url: '/api/healthz', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', host: 'spoof.example.net' } });
    expect((await app.inject({ url: '/api/server/addresses', headers: auth() })).json().public).not.toContain('https://spoof.example.net');
  });
});
