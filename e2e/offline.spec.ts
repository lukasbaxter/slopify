import { test, expect, webkit, chromium, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { login, waitForLibrary } from './helpers';

// Download for offline, Spotify's way (web/src/offline, web/public/sw.js):
// download an album, lose the connection, and the app itself still opens,
// shows the album, greys out what is not downloaded, and plays the
// downloaded songs from the device; back online, the plays made offline
// reach the server. Run in WebKit (the engine of the installed app on an
// iPhone) and Chromium. "No connection" is the server really gone: each
// run starts its own server and stops it (Playwright's offline switch
// bypasses service workers in WebKit).
async function startServer(port: number, dataDir: string): Promise<ChildProcess> {
  const p = spawn('node', ['server/dist/index.js'], { env: { ...process.env, NODE_ENV: 'test', SAVE_TO_LIBRARY: '0', SPEAKERS: '0', MUSIC_DIR: 'fixtures/music', DATA_DIR: dataDir, PORT: String(port), LOG_LEVEL: 'warn', LOGIN_RATE_MAX: '1000', RATE_MAX: '100000' }, stdio: 'ignore' });
  await expect.poll(async () => { try { return (await fetch(`http://localhost:${port}/healthz`)).ok; } catch { return false; } }, { timeout: 30000 }).toBe(true);
  return p;
}
const stop = (p: ChildProcess) => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode) { r(); return; } p.once('exit', () => r()); p.kill('SIGTERM'); });
const libPlays = (page: Page) => page.evaluate(async () => { const r = await (await caches.open('slopify-offline')).match('/offline/library.json'); return r ? (await r.json()).plays.length : -1; });

for (const [name, engine, port] of [['webkit', webkit, 8093], ['chromium', chromium, 8094]] as const) {
  test(`offline: the app works with no connection (${name})`, async ({ isMobile }) => {
    test.skip(!!isMobile, 'one run per engine is enough');
    test.setTimeout(240000);
    const dataDir = `/tmp/slopify-e2e-offline-${name}`;
    fs.rmSync(dataDir, { recursive: true, force: true });
    let server = await startServer(port, dataDir);
    const browser = await engine.launch(name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {});
    const context = await browser.newContext({ baseURL: `http://localhost:${port}`, viewport: { width: 1280, height: 800 } });
    const page: Page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    try {
      await login(page); await waitForLibrary(page);
      // WebKit run: quality Lossless, so the original files are kept;
      // Chromium uses Very high (AAC at 320).
      const lossless = name === 'webkit';
      const tok = await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token || '');
      await page.request.patch('/api/prefs', { headers: { authorization: `Bearer ${tok}` }, data: { quality: lossless ? 'original' : 'high' } });
      await page.reload(); await waitForLibrary(page);

      // An album that will NOT be downloaded, seen once online.
      await page.locator('.card, .shortcut', { hasText: 'Analytical' }).first().click();
      await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
      await page.goBack().catch(() => {});

      await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
      await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
      const n = await page.locator('.trackrow').count();
      await page.locator('button.dlbtn').click();
      await expect(page.getByText(/First Light is ready offline/)).toBeVisible({ timeout: 90000 });
      await expect(page.locator('.trackrow .dl-mark')).toHaveCount(n);
      await expect(page.locator('button.dlbtn.on')).toBeVisible();
      const types = await page.evaluate(async () => { const c = await caches.open('slopify-offline'); const ks = (await c.keys()).filter((k) => k.url.includes('/offline/song/')); return [...new Set(await Promise.all(ks.map(async (k) => (await c.match(k))!.headers.get('content-type'))))]; });
      expect(types).toEqual([lossless ? 'audio/mpeg' : 'audio/mp4']);
      // The worker keeps a copy of the app.
      await expect.poll(() => page.evaluate(async () => (await (await caches.open('slopify-app-shell')).keys()).length), { timeout: 15000 }).toBeGreaterThan(1);

      // --- no connection ---
      await stop(server);
      await page.goto('/?debug'); // ?debug: window.__jf, to report a play below
      await expect(page.locator('.offline-banner')).toBeVisible({ timeout: 30000 });
      await waitForLibrary(page);
      // The album not downloaded opens, greyed out.
      await page.locator('.card, .shortcut', { hasText: 'Analytical' }).first().click();
      await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.trackrow.unavailable').first()).toBeVisible();
      await page.goBack().catch(() => {});
      // The downloaded one plays, from the device.
      await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
      await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.trackrow.unavailable')).toHaveCount(0);
      await page.locator('.trackrow').nth(1).dblclick();
      await expect.poll(async () => (await page.locator('.player').textContent()) || '', { timeout: 20000 }).toMatch(/0:0[2-9]|0:[1-5]\d/);
      // A play is kept for later. (The player reports one 8 s in; these
      // fixture songs are 5-8 s long, so the report is made directly.)
      await page.evaluate(() => (window as any).__jf.reportStart((window as any).__player.current.Id));
      await expect.poll(() => libPlays(page), { timeout: 10000 }).toBeGreaterThan(0);
      // Next goes on to the next downloaded song.
      const before = (await page.locator('.player').textContent()) || '';
      await page.locator('.player button[title="Next"], .player button[aria-label="Next"]').first().click();
      await expect.poll(async () => (await page.locator('.player').textContent()) || '', { timeout: 15000 }).not.toBe(before);

      // --- back online: the kept plays reach the server ---
      server = await startServer(port, dataDir);
      await page.reload();
      await waitForLibrary(page);
      await expect(page.locator('.offline-banner')).toHaveCount(0, { timeout: 30000 });
      await expect.poll(() => libPlays(page), { timeout: 20000 }).toBe(0);
      const hist = await page.request.get('/api/history?limit=20', { headers: { authorization: `Bearer ${tok}` } });
      expect(JSON.stringify(await hist.json())).toContain('"client":"offline"');
      expect(errors.filter((e) => !/ResizeObserver/.test(e))).toEqual([]);
    } finally { await browser.close(); await stop(server); }
  });
}
