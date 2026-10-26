import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { login } from './helpers';

// Over HTTP/2 (nginx in front, `http2 on`) every answer shares one
// connection, and bytes a media element has not read yet hold the
// connection's receive window. On the TV (2026-10-26) the playing original
// and the next one preloading held it: lyrics and the track a phone picked
// arrived 4-12 s late, the moment a skip cancelled those streams. Lyrics
// stuck on "we don't have them", taps from the phone did nothing.
// Here: a server of its own on two big originals, an HTTP/2 front like
// nginx's, and six preloading elements (desktop Chrome buffers more than the
// TV's WebView, so it takes more of them to fill the window).

let server: ChildProcess | null = null, front: http2.Http2SecureServer | null = null, dir = '', base = '';

test.beforeAll(async ({}, info) => {
  if (info.project.name !== 'chromium') return;
  test.setTimeout(120000);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-h2-'));
  const music = path.join(dir, 'music', 'Big', 'Long');
  fs.mkdirSync(music, { recursive: true });
  // Noise does not compress: 7 minutes of FLAC is ~46 MB, an original's size.
  for (const [n, c] of [[1, 'pink'], [2, 'brown']] as const) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anoisesrc=d=420:c=${c}:r=44100:a=0.3`, '-ac', '2',
      '-metadata', `title=Long ${n}`, '-metadata', 'artist=Big', '-metadata', 'album=Long', '-metadata', `track=${n}`, path.join(music, `0${n}.flac`)]);
  }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const port = 18000 + Math.floor(Math.random() * 2000);
  server = spawn(process.execPath, ['server/dist/index.js'], {
    env: { ...process.env, NODE_ENV: 'test', SAVE_TO_LIBRARY: '0', SPEAKERS: '0', MUSIC_DIR: path.join(dir, 'music'), DATA_DIR: path.join(dir, 'data'), PORT: String(port), LOG_LEVEL: 'warn', LOGIN_RATE_MAX: '1000', RATE_MAX: '100000' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  // nginx's part: HTTP/2 to the browser, HTTP/1.1 upstream, unbuffered, back-pressured.
  front = http2.createSecureServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')), allowHTTP1: true });
  front.on('request', (req, res) => {
    const headers: any = { ...req.headers }; for (const k of Object.keys(headers)) if (k.startsWith(':')) delete headers[k];
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
      const h: any = { ...r.headers }; delete h.connection; delete h['keep-alive']; delete h['transfer-encoding'];
      res.writeHead(r.statusCode || 502, h); r.pipe(res);
    });
    up.on('error', () => res.destroy());
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  await new Promise<void>((r) => front!.listen(0, () => r()));
  base = `https://localhost:${(front.address() as any).port}`;
});
test.afterAll(async () => {
  front?.close(); server?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// Six elements preloading (one playing) on the URLs `urlOf` builds; the
// slowest of ten small API answers meanwhile.
async function slowest(page: Page, urlOf: string) {
  return page.evaluate(async (urlOf) => {
    const w = window as any, jf = w.__jf;
    const tok = jf.token;
    const s = await (await fetch('/api/search?q=Long&limit=10', { headers: { authorization: `Bearer ${tok}` } })).json();
    const ids = s.tracks.filter((t: any) => /^Long [12]$/.test(t.title)).map((t: any) => t.id);
    const els = ids.length === 2 ? [0, 1, 2, 3, 4, 5].map((k) => {
      const a = new Audio(`${jf[urlOf](ids[k % 2])}&k=${k}`); a.preload = 'auto'; document.body.append(a); a.load(); return a;
    }) : [];
    if (!els.length) return { worst: -1, src: '' };
    await els[0].play().catch(() => {});
    let worst = 0;
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now(); const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 8000);
      try { await (await fetch(`/api/tracks/${ids[0]}`, { headers: { authorization: `Bearer ${tok}` }, signal: ctl.signal, cache: 'no-store' })).json(); } catch { /* 8 s: counted as such */ }
      clearTimeout(to);
      worst = Math.max(worst, performance.now() - t0);
      await new Promise((r) => setTimeout(r, 700));
    }
    const src = els[0].src;
    for (const a of els) { a.pause(); a.removeAttribute('src'); a.load(); a.remove(); }
    return { worst: Math.round(worst), src };
  }, urlOf);
}

test('preloading originals do not hold up the API on the same HTTP/2 connection', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'one server of its own; Chrome is where the window is held');
  test.setTimeout(120000);
  const run = async (urlOf: string) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: base }); // a fresh connection each
    const page = await ctx.newPage();
    await login(page);
    await page.goto('/?debug=1');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__jf), { timeout: 15000 }).toBe('object');
    await page.evaluate(() => { (window as any).__jf.quality = 'original'; });
    const r = await slowest(page, urlOf);
    await ctx.close();
    return r;
  };
  // Whole-file answers (what every player asked for before): the API stalls.
  const whole = await run('streamUrl');
  console.log(`whole files: slowest API answer ${whole.worst} ms`);
  expect(whole.worst).toBeGreaterThan(2000);
  // What the web player asks for now: the original in pieces. No stall.
  const pieces = await run('playbackUrl');
  console.log(`in pieces: slowest API answer ${pieces.worst} ms (${pieces.src.replace(/token=[^&]*/, 'token=…')})`);
  expect(pieces.src).toContain('chunk=1');
  expect(pieces.worst).toBeGreaterThan(-1);
  expect(pieces.worst).toBeLessThan(1000);
});
