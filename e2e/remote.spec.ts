import { test, expect, webkit, type Browser, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// One account on two devices: a phone playing, a desktop choosing what plays
// on it. Whatever the desktop picks has to play on the phone, without the
// desktop taking the music over.

const nowTitle = (p: Page) => p.evaluate(() => (document.querySelector('.player')?.textContent || ''));

async function device(browser: Browser, phone: boolean) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SlopifyMobile/0.1' }
    : { viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await login(page); await waitForLibrary(page);
  return page;
}

async function openAlbum(page: Page, name: string) {
  await page.locator('.card, .shortcut', { hasText: name }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
}

test('the desktop picks songs for the phone that is playing', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  // The phone is WebKit with its real autoplay rules (an iPhone, Safari):
  // sound may only start after a tap, so a song chosen elsewhere has to play
  // on the element the tap unlocked.
  const wk = await webkit.launch({ args: [] }); // none of the Chrome-only flags from the config
  const phone = await device(wk, true);
  const desk = await device(browser, false);

  // The phone plays a song.
  await openAlbum(phone, 'First Light');
  await phone.locator('.trackrow').nth(0).click();
  await expect.poll(() => nowTitle(phone), { timeout: 20000 }).toMatch(/0:0[1-9]|0:[1-5]\d/);

  // The desktop sees it playing on the phone...
  await expect.poll(() => nowTitle(desk), { timeout: 20000 }).toContain('River Harbour');

  // ...and double-clicks another song: it plays on the phone.
  await openAlbum(desk, 'First Light');
  const row = desk.locator('.trackrow').nth(2);
  const title = (await row.locator('.trackrow-name, .trackrow-title').first().textContent())!.trim();
  await row.dblclick();
  await expect.poll(() => nowTitle(phone), { timeout: 15000 }).toContain(title.slice(0, 12));
  await expect.poll(() => nowTitle(desk), { timeout: 15000 }).toContain(title.slice(0, 12));
  // The phone is still the one playing.
  expect(await desk.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused))).toBe(false);

  // Next from the desktop moves the phone on too.
  await desk.locator('.player button[title="Next"], .player button[aria-label="Next"]').first().click();
  await expect.poll(() => nowTitle(phone), { timeout: 15000 }).not.toContain(title.slice(0, 12));

  // Each shows up under a name of its own, not "Web Player (n)".
  const names = await desk.evaluate(async () => {
    const tok = JSON.parse(localStorage.getItem('slopify.session') || '{}').token;
    const r = await (await fetch('/api/session', { headers: { authorization: `Bearer ${tok}` } })).json();
    return r.clients.map((c: any) => c.name);
  });
  expect(names).toContain('Safari on iPhone');
  expect(names.some((n: string) => /^Chrome on (Mac|Linux|Windows)/.test(n))).toBe(true);
  await wk.close();
});

test('a phone picks a song from Liked Songs for the laptop that is playing', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const desk = await device(browser, false);
  const phone = await device(browser, true);
  // Like every track, so Liked Songs has a list to pick from.
  await phone.evaluate(async () => {
    const tok = JSON.parse(localStorage.getItem('slopify.session') || '{}').token;
    const h = { authorization: `Bearer ${tok}` };
    const r = await (await fetch('/api/search?q=a&limit=50', { headers: h })).json();
    for (const t of r.tracks || []) await fetch(`/api/likes/${t.id}`, { method: 'PUT', headers: h });
  });
  // The laptop plays.
  await openAlbum(desk, 'First Light');
  await desk.locator('.trackrow').nth(0).dblclick();
  await expect.poll(() => nowTitle(desk), { timeout: 20000 }).toMatch(/0:0[1-9]|0:[1-5]\d/);
  await expect.poll(() => nowTitle(phone), { timeout: 20000 }).toContain('River Harbour');
  // The phone opens Liked Songs and taps a song further down.
  await phone.reload(); await waitForLibrary(phone);
  await phone.locator('.tabbar button', { hasText: 'Your Library' }).click();
  await phone.getByText('Liked Songs', { exact: true }).first().click();
  await expect(phone.locator('.trackrow').nth(3)).toBeVisible({ timeout: 15000 });
  const row = phone.locator('.trackrow').nth(3);
  const title = (await row.locator('.trackrow-name, .trackrow-title').first().textContent())!.trim();
  // A real touch tap (a phone has no mouse), counting the play commands it sends.
  let sent = 0;
  phone.on('websocket', (ws) => ws.on('framesent', (f) => { if (String(f.payload).includes('"type":"command"') && String(f.payload).includes('"action":"play"')) sent += 1; }));
  await phone.reload(); await waitForLibrary(phone);
  await phone.locator('.tabbar button', { hasText: 'Your Library' }).click();
  await phone.getByText('Liked Songs', { exact: true }).first().click();
  await expect(phone.locator('.trackrow').nth(3)).toBeVisible({ timeout: 15000 });
  await phone.waitForTimeout(1500);
  const t0 = Date.now();
  await phone.locator('.trackrow').nth(3).tap();
  await expect.poll(() => nowTitle(desk), { timeout: 15000, intervals: [50] }).toContain(title.slice(0, 12));
  const tDesk = Date.now() - t0;
  await expect.poll(() => nowTitle(phone), { timeout: 15000, intervals: [50] }).toContain(title.slice(0, 12));
  console.log(`tap -> laptop ${tDesk} ms, -> phone shows it ${Date.now() - t0} ms`);
  await phone.waitForTimeout(1000);
  expect(sent).toBe(1);
  await expect.poll(() => nowTitle(phone), { timeout: 15000 }).toContain(title.slice(0, 12));
});


test('closing the phone app never pauses the laptop; a lock-screen pause still does', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const desk = await device(browser, false);
  const pctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  // Keep the page's lock-screen handlers where the test can press them.
  await pctx.addInitScript(() => {
    const ms = navigator.mediaSession as any; const handlers: Record<string, any> = {};
    (window as any).__ms = handlers;
    const orig = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (a: string, fn: any) => { handlers[a] = fn; try { orig(a, fn); } catch { /* unsupported */ } };
  });
  const phone = await pctx.newPage(); await login(phone); await waitForLibrary(phone);
  let toggles = 0;
  phone.on('websocket', (ws) => ws.on('framesent', (f) => { const p = String(f.payload); if (p.includes('"type":"command"') && p.includes('"action":"toggle"')) toggles += 1; }));
  await phone.reload(); await waitForLibrary(phone);
  // The laptop plays; the phone shows it.
  await openAlbum(desk, 'First Light');
  await desk.locator('.trackrow').nth(0).dblclick();
  await expect.poll(() => nowTitle(phone), { timeout: 20000 }).toContain('River Harbour');
  await expect.poll(() => phone.evaluate(() => typeof (window as any).__ms.pause), { timeout: 10000 }).toBe('function');
  await expect.poll(() => phone.evaluate(() => navigator.mediaSession.playbackState), { timeout: 10000 }).toBe('playing');
  // iOS pauses the stand-in session as the app closes: dropped.
  await phone.evaluate(() => { (window as any).__ms.pause(); window.dispatchEvent(new CustomEvent('slopify:appstate', { detail: { state: 'background' } })); });
  await phone.waitForTimeout(1600);
  expect(toggles).toBe(0);
  // A real lock-screen pause: reaches the laptop a moment later.
  await phone.evaluate(() => (window as any).__ms.pause());
  await phone.waitForTimeout(1500);
  await expect.poll(() => toggles, { timeout: 4000 }).toBe(1);
});

test('the 2-hour hold: closing the phone app never starts the paused music; a real lock-screen tap does', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const desk = await device(browser, false);
  // The iPhone app: its user agent and the shell's flag, so the hold applies.
  const pctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SlopifyMobile/0.1' });
  await pctx.addInitScript(() => {
    (window as any).slopifyShell = { deviceName: 'Test iPhone', deviceForm: 'phone', platform: 'ios', version: 'test' };
    const ms = navigator.mediaSession as any; const handlers: Record<string, any> = {};
    (window as any).__ms = handlers;
    const orig = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (a: string, fn: any) => { handlers[a] = fn; try { orig(a, fn); } catch { /* unsupported */ } };
  });
  const phone = await pctx.newPage(); await login(phone); await waitForLibrary(phone);
  let toggles = 0;
  phone.on('websocket', (ws) => ws.on('framesent', (f) => { const p = String(f.payload); if (p.includes('"type":"command"') && p.includes('"action":"toggle"')) toggles += 1; }));
  await phone.reload(); await waitForLibrary(phone);
  await openAlbum(desk, 'First Light');
  await desk.locator('.trackrow').nth(0).dblclick();
  await expect.poll(() => nowTitle(phone), { timeout: 20000 }).toContain('River Harbour');
  await expect.poll(() => phone.evaluate(() => navigator.mediaSession.playbackState), { timeout: 10000 }).toBe('playing');
  // The laptop pauses: the phone holds the paused session on its lock screen.
  await desk.locator('.player button[title="Pause"]').first().click();
  await expect.poll(() => phone.evaluate(() => navigator.mediaSession.playbackState), { timeout: 10000 }).toBe('paused');
  // iOS pauses the stand-in as the app closes: must not start the laptop.
  await phone.evaluate(() => { (window as any).__ms.pause(); window.dispatchEvent(new CustomEvent('slopify:appstate', { detail: { state: 'background' } })); });
  await phone.waitForTimeout(1600);
  expect(toggles).toBe(0);
  // A real tap on the held lock screen: plays, a moment later.
  await phone.evaluate(() => (window as any).__ms.pause());
  await expect.poll(() => toggles, { timeout: 4000 }).toBe(1);
});

test('a quick drag on the device sheet volume slider never skips; a swipe on the mini player still does', async ({ browser }, info) => {
  test.skip(info.project.name !== 'chromium', 'two devices of its own');
  const desk = await device(browser, false);
  const pctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const phone = await pctx.newPage(); await login(phone); await waitForLibrary(phone);
  let skips = 0;
  phone.on('websocket', (ws) => ws.on('framesent', (f) => { const p = String(f.payload); if (p.includes('"action":"next"') || p.includes('"action":"previous"')) skips += 1; }));
  await phone.reload(); await waitForLibrary(phone);
  await openAlbum(desk, 'First Light');
  await desk.locator('.trackrow').nth(0).dblclick();
  await expect.poll(() => phone.evaluate(() => document.body.textContent?.includes('Playing on')), { timeout: 20000 }).toBe(true);
  // A quick sideways swipe, as touch events on the element (the device sheet
  // opens inside the mini player's .player-row on the phone).
  const swipe = (sel: string) => phone.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement; const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2; const x0 = r.left + r.width * 0.25;
    const at = (x: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [at(x0)], changedTouches: [at(x0)], bubbles: true, cancelable: true }));
    for (let i = 1; i <= 5; i++) el.dispatchEvent(new TouchEvent('touchmove', { touches: [at(x0 + i * 30)], changedTouches: [at(x0 + i * 30)], bubbles: true, cancelable: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [at(x0 + 150)], bubbles: true, cancelable: true }));
  }, sel);
  await phone.locator('.player-row .devicebtn').first().click();
  await expect(phone.locator('.dm-volume input[type=range]')).toBeVisible();
  await swipe('.dm-volume input[type=range]');
  await phone.waitForTimeout(800);
  expect(skips).toBe(0);
  await phone.keyboard.press('Escape'); await phone.mouse.click(5, 5); await phone.waitForTimeout(400);
  await swipe('.player-row');
  await expect.poll(() => skips, { timeout: 3000 }).toBe(1);
});
