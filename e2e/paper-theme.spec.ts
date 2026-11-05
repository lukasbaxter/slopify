import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';
import fs from 'node:fs';
import path from 'node:path';

// A light theme paints the whole app from its four colours, so anything that
// still assumes a dark page goes unreadable. This walks the screens in Paper
// and measures the real contrast of every label and icon, at rest and on hover.
const PAPER = { accent: '#1a7f4b', bg: '#f4f1ea', surface: '#ffffff', fg: '#141414' };
const THEME = process.env.AUDIT_THEME === 'default' ? { accent: '#1ed760', bg: '#121212', surface: '#1f1f1f', fg: '#ffffff' } : PAPER;
const SHOTS = process.env.SHOT_DIR; // set to keep a picture of each screen

// Runs in the page. Returns everything under `root` that fails.
function audit(rootSel: string) {
  const parse = (c: string) => {
    // color-mix() computes to color(srgb r g b / a), with 0-1 channels.
    const x = c.match(/color\(srgb ([^)]+)\)/); if (x) { const q = x[1].split(/[ /]+/).filter(Boolean).map(Number); return [q[0] * 255, q[1] * 255, q[2] * 255, q[3] ?? 1]; }
    const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
  const over = (top: number[], under: number[]) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  // Every colour the element's background can be: a gradient is judged by its
  // stops, so text that crosses from dark to light fails on the bad end.
  const backdrops = (el: Element): number[][] | null => {
    const layers: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      layers.push(e);
      const s = getComputedStyle(e); const c = parse(s.backgroundColor);
      if (s.backgroundImage.includes('url(')) return null;
      if (s.backgroundImage === 'none' && c && c[3] === 1) break;
    }
    let out = [[0, 0, 0, 1]];
    for (const e of layers.reverse()) {
      const s = getComputedStyle(e); const c = parse(s.backgroundColor);
      if (c && c[3] > 0) out = out.map((u) => over(c, u));
      if (s.backgroundImage.includes('gradient')) {
        const stops = (s.backgroundImage.match(/(rgba?|color)\([^)]+\)/g) || []).map((x) => parse(x)!).filter(Boolean);
        if (stops.length) out = stops.flatMap((st) => out.map((u) => over(st, u)));
      }
    }
    return out;
  };
  const name = (el: Element): string => el.tagName === 'svg' ? `svg in ${name(el.parentElement!)}` : `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    for (let e: Element | null = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < .05) return false; }
    return true;
  };
  const bad: { el: string; ratio: number; text: string; fg: string }[] = [];
  const root = document.querySelector(rootSel) || document.body;
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join('');
    const svg = el.tagName === 'svg';
    const input = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !['range', 'color', 'checkbox', 'file', 'hidden'].includes((el as HTMLInputElement).type);
    if (!text && !svg && !input) continue;
    if (el.closest('svg') && !svg) continue;
    if (el.closest('.mixband, .tile')) continue; // white on the art colour, the same in every theme
    if (el.closest('.mobile-topbar') && document.querySelector('.hero')) continue; // floats over the header, not on its own box
    if ((el as HTMLButtonElement).disabled || el.closest('[disabled],[aria-disabled="true"]') || !visible(el)) continue;
    const s = getComputedStyle(el); const fg = parse(s.color); if (!fg) continue;
    if (svg && (s.fill !== 'none' && !/currentcolor/i.test(el.getAttribute('fill') || 'currentcolor'))) continue; // own colours (art, logos)
    const under = backdrops(el); if (!under) continue;
    const need = svg || el.closest('.fs') ? 3 : 4.5; // Now Playing sits on the cover colour, so it is judged as large type
    const worst = Math.min(...under.map((u) => ratio(over(fg, u), u)));
    if (worst < need) bad.push({ el: name(el), ratio: Math.round(worst * 10) / 10, text: text.slice(0, 24), fg: s.color });
  }
  return bad;
}

test('every screen is readable in a light theme', async ({ page, isMobile }) => {
  test.setTimeout(240000);
  await login(page); await waitForLibrary(page);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token);
  const headers = { Authorization: `Bearer ${token}` };
  await page.request.patch('/api/prefs', { headers, data: { theme: THEME } });
  await page.reload(); await waitForLibrary(page);
  const tag = isMobile ? 'phone' : 'desktop';

  const seen = new Map<string, { el: string; ratio: number; text: string; fg: string; where: string }>();
  const check = async (where: string, root = 'body') => {
    await page.waitForTimeout(350);
    for (const b of await page.evaluate(audit, root)) { const k = `${b.el}|${b.fg}`; if (!seen.has(k)) seen.set(k, { ...b, where }); }
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${tag}-${where.replace(/\W+/g, '-')}.png`) }); }
  };
  // Hover state, for each kind of control on the screen.
  const hovers = async (where: string) => {
    if (isMobile) return;
    const kinds = await page.evaluate(() => {
      const out = new Map<string, number>(); const all = [...document.querySelectorAll('button, a, [role=button], .card, .trackrow, .libitem, .shortcut, .pill, .qrow')];
      all.forEach((el, i) => { const r = el.getBoundingClientRect(); const k = String((el as HTMLElement).className); if (!out.has(k) && r.width > 2 && r.top >= 0 && r.bottom <= innerHeight) { out.set(k, i); el.setAttribute('data-audit', String(i)); } });
      return [...out.values()];
    });
    for (const i of kinds.slice(0, 50)) {
      const el = page.locator(`[data-audit="${i}"]`);
      if (!await el.hover({ timeout: 800, force: true }).then(() => true).catch(() => false)) continue;
      await page.waitForTimeout(170); // past the hover transition
      for (const b of await page.evaluate(audit, `[data-audit="${i}"]`)) { const k = `hover ${b.el}|${b.fg}`; if (!seen.has(k)) seen.set(k, { ...b, where: `${where} (hover)` }); }
    }
    await page.mouse.move(0, 0);
  };
  const screen = async (where: string) => { await check(where); await hovers(where); };

  await screen('home');
  await page.locator('.card', { hasText: 'First Light' }).first().click();
  await expect(page.locator('.trackrow').first()).toBeVisible({ timeout: 15000 });
  await screen('album');

  // Start music, so the player, its play button and the queue are real.
  await page.locator('.actions .play-big, .actions button').first().click().catch(() => {});
  await page.locator('.trackrow').first().dblclick().catch(() => {});
  await page.waitForTimeout(800);
  await screen('album playing');

  // The artist page, plain and with a photo behind the name.
  const link = page.locator('.hero .linkish, .hero-owner, .trackrow .rowlink').first();
  await link.click().catch(() => {});
  await page.waitForTimeout(900);
  if (await page.locator('.hero.artist').count()) {
    await screen('artist');
    const h1 = page.locator('.hero.artist h1');
    await page.evaluate(() => { const h = document.querySelector('.hero.artist')!; h.classList.add('with-banner'); (h as HTMLElement).style.setProperty('--banner', 'url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)'); });
    await check('artist banner');
    // White on the photo's dark wash, in every theme.
    const name = await h1.evaluate((e) => getComputedStyle(e).color);
    if (name !== 'rgb(255, 255, 255)') seen.set('artist name', { el: 'h1 artist name', ratio: 0, text: '', fg: name, where: 'artist banner' });
  }

  if (isMobile) {
    await page.locator('.tabbar button').nth(1).click(); await page.waitForTimeout(400); await check('search');
    await page.locator('input.search').first().fill('light').catch(() => {}); await page.waitForTimeout(800); await check('search results');
    await page.locator('.tabbar button').nth(2).click(); await page.waitForTimeout(500); await check('library');
    await page.locator('.tabbar button').nth(0).click(); await page.waitForTimeout(500); await check('home again');
    await page.locator('.player-row').first().click({ position: { x: 60, y: 20 } }).catch(() => {});
    await page.waitForTimeout(500);
    if (await page.locator('.fs').count()) { await check('now playing'); await page.locator('.fs-chevron').first().click().catch(() => {}); await page.waitForTimeout(400); }
    await page.locator('button.avatar, .avatar').first().click().catch(() => {});
    await page.waitForTimeout(400); await check('account menu');
    await page.locator('.avatarmenu button', { hasText: 'Settings' }).click().catch(() => {});
    await page.waitForTimeout(600); await check('settings');
    await page.locator('.setrow', { hasText: 'View profile' }).click().catch(() => {});
    await page.waitForTimeout(700); await check('profile');
    await page.locator('.tabbar button').nth(1).click(); await page.waitForTimeout(400);
    await page.locator('input.search').first().fill('light').catch(() => {}); await page.waitForTimeout(800);
    await page.locator('.trackrow-more').first().click().catch(() => {});
    await page.waitForTimeout(500); await check('song sheet');
    await page.mouse.click(190, 40); await page.waitForTimeout(400);
    await page.locator('.player-right .devicebtn').first().click().catch(() => {});
    await page.waitForTimeout(500); await check('device sheet');
  } else {
    const nav = async (label: string) => { await page.locator('.sidebar .navitem', { hasText: label }).first().click(); await page.waitForTimeout(500); };
    await nav('Search'); await screen('browse');
    await page.locator('input.search').fill('light'); await page.waitForTimeout(800); await screen('search results');
    await nav('Home');
    await page.locator('.trackrow, .card').first().click({ button: 'right' }).catch(() => {});
    await page.waitForTimeout(300); await check('context menu'); await page.keyboard.press('Escape');
    await page.locator('button.avatar').click(); await page.waitForTimeout(250); await check('account menu');
    await page.locator('.avatarmenu button', { hasText: 'History' }).click();
    await expect(page.locator('.sf')).toBeVisible({ timeout: 10000 }); await page.waitForTimeout(1000); await screen('history');
    await nav('Home');
    await page.locator('button.avatar').click();
    await page.locator('.avatarmenu button', { hasText: 'Settings' }).click();
    await expect(page.locator('.settings')).toBeVisible({ timeout: 10000 }); await screen('settings');
    await page.locator('[title="Queue"]').first().click().catch(() => {});
    await page.waitForTimeout(500); await screen('queue');
    await page.locator('.player-right .devicebtn').first().click().catch(() => {});
    await page.waitForTimeout(400); await check('device menu'); await page.keyboard.press('Escape');
    await page.locator('.player .fs-open, .player-art, .player img').first().click().catch(() => {});
    await page.waitForTimeout(500);
    if (await page.locator('.fs').count()) await check('now playing');
  }

  const list = [...seen.values()].sort((a, b) => a.ratio - b.ratio);
  console.log(`${list.length} unreadable (${tag}):\n${list.map((b) => `${b.ratio}  ${b.where}  ${b.el}  "${b.text}"  ${b.fg}`).join('\n')}`);
  expect(list.map((b) => `${b.where}: ${b.el} ${b.ratio}`)).toEqual([]);
});

// The play button itself, named because it was the one that went black on black.
test('the play button shows its icon in a light theme', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the phone mini player has no filled play button');
  await login(page); await waitForLibrary(page);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token);
  await page.request.patch('/api/prefs', { headers: { Authorization: `Bearer ${token}` }, data: { theme: PAPER } });
  await page.reload(); await waitForLibrary(page);
  const play = page.locator('.player-buttons .play');
  const [bg, fg] = await play.evaluate((e) => { const s = getComputedStyle(e); return [s.backgroundColor, s.color]; });
  expect(fg).not.toBe(bg);
  expect(fg).not.toBe('rgb(0, 0, 0)');
});

test.afterEach(async ({ page }) => {
  // The account is shared with the other specs: put its theme back.
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('slopify.session') || '{}').token).catch(() => null);
  if (token) await page.request.patch('/api/prefs', { headers: { Authorization: `Bearer ${token}` }, data: { theme: { accent: '#1ed760', bg: '#121212', surface: '#1f1f1f', fg: '#ffffff' } } });
});
