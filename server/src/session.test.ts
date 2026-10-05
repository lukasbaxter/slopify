import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { applyEvent, emptySession, positionNow, registerSession } from './session.js';

describe('session reconciliation', () => {
  it('newest event wins; older ones are rejected', () => {
    const s = emptySession();
    expect(applyEvent(s, { type: 'queue', ts: 1000, queue: ['a', 'b', 'c'], index: 0 }, 'c1', 1000).changed).toBe(true);
    expect(s.active).toBe('c1'); expect(s.trackId).toBe('a'); expect(s.playing).toBe(true);
    expect(applyEvent(s, { type: 'pause', ts: 3000, positionMs: 2000 }, 'c2', 3000).changed).toBe(true);
    expect(s.playing).toBe(false); expect(s.positionMs).toBe(2000);
    // an offline client's action from t=2000 arrives late: rejected
    expect(applyEvent(s, { type: 'next', ts: 2000 }, 'c1', 3500)).toEqual({ changed: false, reason: 'stale' });
    expect(s.trackId).toBe('a');
  });
  it('interpolates the position from the anchor while playing', () => {
    const s = emptySession();
    applyEvent(s, { type: 'queue', ts: 1000, queue: ['a'], index: 0, positionMs: 0 }, 'c1', 1000);
    expect(positionNow(s, 4000)).toBe(3000);
    applyEvent(s, { type: 'pause', ts: 4000 }, 'c1', 4000);
    expect(positionNow(s, 9000)).toBe(3000);
    applyEvent(s, { type: 'seek', ts: 9000, positionMs: 60000 }, 'c1', 9000);
    applyEvent(s, { type: 'play', ts: 9500 }, 'c1', 9500);
    expect(positionNow(s, 10500)).toBe(61000);
  });
  it('progress only counts from the active client and never rewinds a newer action', () => {
    const s = emptySession();
    applyEvent(s, { type: 'queue', ts: 1000, queue: ['a', 'b'], index: 0 }, 'c1', 1000);
    expect(applyEvent(s, { type: 'progress', ts: 1500, positionMs: 500 }, 'c2', 1500).changed).toBe(false);
    expect(applyEvent(s, { type: 'progress', ts: 1500, positionMs: 500 }, 'c1', 1500).changed).toBe(true);
    applyEvent(s, { type: 'seek', ts: 2000, positionMs: 30000 }, 'c2', 2000);
    expect(applyEvent(s, { type: 'progress', ts: 1900, positionMs: 900 }, 'c1', 2100).changed).toBe(false);
    expect(s.positionMs).toBe(30000);
  });
  it('next/previous walk the queue; previous restarts after 3 s', () => {
    const s = emptySession();
    applyEvent(s, { type: 'queue', ts: 1, queue: ['a', 'b', 'c'], index: 1 }, 'c1', 1);
    applyEvent(s, { type: 'next', ts: 2 }, 'c1', 2); expect(s.trackId).toBe('c');
    applyEvent(s, { type: 'next', ts: 3 }, 'c1', 3); expect(s.trackId).toBe('a'); // wraps
    applyEvent(s, { type: 'previous', ts: 4, positionMs: 5000 }, 'c1', 4); expect(s.trackId).toBe('a'); expect(s.positionMs).toBe(0);
    applyEvent(s, { type: 'previous', ts: 5, positionMs: 1000 }, 'c1', 5); expect(s.trackId).toBe('a'); // at index 0: stays
  });
});

describe('ws client ids across accounts', () => {
  // Two accounts, no library: just enough db for userByToken and the kv reads.
  const users: Record<string, any> = { tokA: { id: 'uA', name: 'A', role: 'user' }, tokB: { id: 'uB', name: 'B', role: 'user' } };
  const db = { prepare: (sql: string) => ({ get: (...args: any[]) => (sql.includes('FROM tokens t JOIN users') ? users[args[0] as string] : undefined), all: () => [], run: () => {} }) } as any;
  let app: any; let port = 0;
  beforeAll(async () => {
    app = Fastify();
    app.decorate('requireUser', (_req: any, _reply: any, done: any) => done());
    await app.register(websocket);
    registerSession(app, db);
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as any).port;
  });
  afterAll(async () => { await app.close(); });
  const hello = async (token: string, clientId: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await new Promise((r) => ws.on('open', r));
    const got = new Promise<any>((resolve) => ws.on('message', (d: any) => { const m = JSON.parse(String(d)); if (m.type === 'hello-ok') resolve(m); }));
    let closed = false; ws.on('close', () => { closed = true; });
    ws.send(JSON.stringify({ type: 'hello', token, clientId, instance: `i_${token}`, kind: 'web' }));
    return { ws, ok: await got, closed: () => closed };
  };
  it('another account cannot take over a connected client id', async () => {
    const a = await hello('tokA', 'c_crossacct1');
    const b = await hello('tokB', 'c_crossacct1');
    await new Promise((r) => setTimeout(r, 100));
    expect(a.ok.clientId).toBe('c_crossacct1');
    expect(b.ok.clientId).not.toBe('c_crossacct1'); // the id was taken: suffixed instead
    expect(a.closed()).toBe(false);                 // and the holder was not evicted
    a.ws.terminate(); b.ws.terminate();
  });
  it('a device that closes while holding the session does not pause the one still playing', async () => {
    const laptop = await hello('tokA', 'c_laptop_1');
    const seen: any[] = []; laptop.ws.on('message', (d: any) => seen.push(JSON.parse(String(d))));
    const phone = await hello('tokA', 'c_phone_1');
    // The laptop makes the sound...
    laptop.ws.send(JSON.stringify({ type: 'nowplaying', nowPlaying: { itemId: 't1', title: 'T', playing: true, position: 10 } }));
    // ...while the phone holds the session (a claim that never reached it, a stale tap).
    phone.ws.send(JSON.stringify({ type: 'claim' }));
    await new Promise((r) => setTimeout(r, 100));
    seen.length = 0;
    phone.ws.terminate();
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.filter((m) => m.type === 'session' && m.nowPlaying?.playing === false)).toEqual([]);
    expect(seen.filter((m) => m.type === 'roster').at(-1)?.activeClientId).toBe('c_laptop_1');
    laptop.ws.terminate();
  });
  it('a device coming back with an old claim yields to the one that took over, instead of pausing it', async () => {
    const phone = await hello('tokA', 'c_phone_2');
    phone.ws.send(JSON.stringify({ type: 'claim' }));
    await new Promise((r) => setTimeout(r, 50));
    // The phone locks and drops off; the laptop takes the session meanwhile.
    phone.ws.terminate();
    const laptop = await hello('tokA', 'c_laptop_2');
    const atLaptop: any[] = []; laptop.ws.on('message', (d: any) => atLaptop.push(JSON.parse(String(d))));
    laptop.ws.send(JSON.stringify({ type: 'claim' }));
    await new Promise((r) => setTimeout(r, 50));
    // The phone reconnects and re-asserts the claim it still remembers.
    const back = await hello('tokA', 'c_phone_2');
    const atPhone: any[] = []; back.ws.on('message', (d: any) => atPhone.push(JSON.parse(String(d))));
    back.ws.send(JSON.stringify({ type: 'claim', reassert: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(atLaptop.filter((m) => m.type === 'command' && m.command?.action === 'yield')).toEqual([]);
    expect(atPhone.some((m) => m.type === 'command' && m.command?.action === 'yield')).toBe(true);
    expect(atLaptop.filter((m) => m.type === 'roster').at(-1)?.activeClientId).toBe('c_laptop_2');
    // With nobody else holding it, a re-assert still takes the session (server restart, own reconnect).
    laptop.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    back.ws.send(JSON.stringify({ type: 'claim', reassert: true }));
    await new Promise((r) => setTimeout(r, 100));
    expect(atPhone.filter((m) => m.type === 'roster').at(-1)?.activeClientId).toBe('c_phone_2');
    back.ws.terminate();
  });
});
