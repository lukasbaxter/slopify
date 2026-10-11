import { test, expect, webkit, chromium, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { login, waitForLibrary } from './helpers';

// Download for offline in the web app (web/src/offline, web/public/sw.js):
// save an album, lose the connection, and the app opens the offline player,
// which plays it; back online, its plays reach the server. Run in WebKit
// (the engine of the installed app on an iPhone) and Chromium. "No
// connection" is the server really gone: each run starts its own server and
// stops it (Playwright's offline switch bypasses service workers in WebKit).
async function startServer(port: number, dataDir: string): Promise<ChildProcess> {
  const p = spawn('node', ['server/dist/index.js'], { env: { ...process.env, NODE_ENV: 'test', SAVE_TO_LIBRARY: '0', SPEAKERS: '0', MUSIC_DIR: 'fixtures/music', DATA_DIR: dataDir, PORT: String(port), LOG_LEVEL: 'warn', LOGIN_RATE_MAX: '1000', RATE_MAX: '100000' }, stdio: 'ignore' });
  await expect.poll(async () => { try { return (await fetch(`http://localhost:${port}/healthz`)).ok; } catch { return false; } }, { timeout: 30000 }).toBe(true);
  return p;
}
const stop = (p: ChildProcess) => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode) { r(); return; } p.once('exit', () => r()); p.kill('SIGTERM'); });
for (const [name, engine, port] of [['webkit', webkit, 8093], ['chromium', chromium, 8094]] as const) {
  test(`offline: download an album, play it with no connection (${name})`, async ({ isMobile }) => {
    test.skip(!!isMobile, 'one run per engine is enough');
    test.setTimeout(180000);
    const dataDir = `/tmp/slopify-e2e-offline-${name}`;
    fs.rmSync(dataDir, { recursive: true, force: true });
    let server = await startServer(port, dataDir);
    const browser = await engine.launch(name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {});
    const context = await browser.newContext({ baseURL: `http://localhost:${port}`, viewport: { width: 393, height: 852 } });
    const page: Page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    try {
      await login(page); await waitForLibrary(page);
      await page.waitForFunction(() => navigator.serviceWorker?.controller != null || navigator.serviceWorker?.ready, null, { timeout: 15000 });
      await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
      await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
      const n = await page.locator('.trackrow').count();
      await page.locator('button.more').first().click();
      await page.getByText('Download for offline').click();
      await expect(page.getByText(/First Light is ready offline/)).toBeVisible({ timeout: 60000 });
      // The menu now offers removal.
      await page.locator('button.more').first().click();
      await expect(page.getByText(/Remove download/)).toBeVisible();
      await page.keyboard.press('Escape');
      // The offline player and its files are cached (the page asked the worker on load).
      await expect.poll(() => page.evaluate(async () => (await (await caches.open('slopify-offline-shell')).keys()).length), { timeout: 15000 }).toBeGreaterThan(1);

      await stop(server);
      await page.goto('/');
      await expect(page.locator('h1', { hasText: 'Downloads' })).toBeVisible({ timeout: 20000 });
      await expect(page.locator('.item', { hasText: 'First Light' })).toContainText(`${n} songs`);
      await page.locator('.item', { hasText: 'First Light' }).click();
      await page.locator('#p').click();
      await expect.poll(() => page.evaluate(() => (document.getElementById('el') as HTMLAudioElement).currentTime), { timeout: 15000 }).toBeGreaterThan(0.5);
      expect(await page.evaluate(() => (document.getElementById('el') as HTMLAudioElement).src)).toMatch(/^blob:/);
      // Next song, then let a play count (half of a short song) by seeking.
      await page.locator('#bnext').click();
      await expect(page.locator('.row.on')).toHaveAttribute('data-i', '1');
      await expect.poll(() => page.evaluate(() => Number.isFinite((document.getElementById('el') as HTMLAudioElement).duration)), { timeout: 10000 }).toBe(true);
      await page.evaluate(() => { const el = document.getElementById('el') as HTMLAudioElement; el.currentTime = el.duration * 0.6; });
      await expect.poll(() => page.evaluate(async () => (await (await (await caches.open('slopify-offline')).match('/offline/library.json'))!.json()).plays.length), { timeout: 10000 }).toBeGreaterThan(0);
      // Sleep timer: end of song stops at the song's end instead of going on.
      await page.locator('#sleepsel').selectOption('end');
      await expect(page.locator('#sleeplbl')).toHaveText('Sleep: end of song');
      await page.evaluate(() => { const el = document.getElementById('el') as HTMLAudioElement; el.play(); el.currentTime = el.duration - 0.3; });
      await expect.poll(() => page.evaluate(() => (document.getElementById('el') as HTMLAudioElement).paused), { timeout: 10000 }).toBe(true);
      await expect(page.locator('.row.on')).toHaveAttribute('data-i', '1'); // stopped, did not go on to the next song
      await expect(page.locator('#sleeplbl')).toHaveText('Sleep timer');

      server = await startServer(port, dataDir);
      await page.locator('#back').click();
      await page.locator('#online').click();
      await waitForLibrary(page);
      // The offline play reaches the server and the library forgets it.
      await expect.poll(() => page.evaluate(async () => (await (await (await caches.open('slopify-offline')).match('/offline/library.json'))!.json()).plays.length), { timeout: 15000 }).toBe(0);
      expect(errors.filter((e) => !/ResizeObserver/.test(e))).toEqual([]);
    } finally { await browser.close(); await stop(server); }
  });
}
