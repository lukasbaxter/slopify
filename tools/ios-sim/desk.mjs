// A second Slopify client for the harness: a headless Chromium page logged
// in as the same account (no window), driven through a command file, so the
// simulator's phone can show and control a session playing elsewhere.
//
//   node tools/ios-sim/desk.mjs <base-url> <user> <password> <dir>
//   echo 'play First Light' > <dir>/cmd     play an album here (the "laptop")
//   echo 'toggle' > <dir>/cmd               play/pause here
//   echo 'quit' > <dir>/cmd
// <dir>/state holds { playing, title, mirroring, position, at } twice a second.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [base, user, password, dir] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const r = await page.request.post(`${base}/api/auth/login`, { data: { username: user, password } });
const { token } = await r.json();
// The login form, as e2e/helpers.ts does it.
await page.goto(`${base}/?debug=1`);
const inputs = page.locator('.login input');
await inputs.nth(0).fill(user); await inputs.nth(1).fill(password);
await page.locator('.login .primary').click();
await page.waitForFunction(() => typeof window.__player === 'object', null, { timeout: 30000 });
const cmdFile = path.join(dir, 'cmd');
const say = (m) => fs.appendFileSync(path.join(dir, 'log'), `${new Date().toISOString().slice(11, 23)} ${m}\n`);
say('ready');
for (;;) {
  if (fs.existsSync(cmdFile)) {
    const cmd = fs.readFileSync(cmdFile, 'utf8').trim(); fs.rmSync(cmdFile);
    say(`cmd ${cmd}`);
    if (cmd === 'quit') break;
    try {
      if (cmd.startsWith('play ')) {
        const name = cmd.slice(5);
        await page.evaluate(async ({ name, token }) => {
          const h = { Authorization: `Bearer ${token}` };
          const a = (await (await fetch('/api/albums?limit=100', { headers: h })).json()).items.find((x) => x.name === name);
          const ids = (await (await fetch(`/api/albums/${a.id}`, { headers: h })).json()).tracks.map((t) => t.id);
          const p = window.__player; if (p.mirroring) p.relay?.claim();
          await p.playQueue(await window.__jf.itemsByIds(ids), 0, null);
        }, { name, token });
      } else if (cmd === 'toggle') await page.evaluate(() => window.__player.toggle());
    } catch (e) { say(`error ${e.message}`); }
  }
  const st = await page.evaluate(() => { const p = window.__player; const el = [...document.querySelectorAll('audio')].concat(window.__els || []).find((e) => !e.paused && e.getAttribute('src')); return { playing: p.playing, mirroring: p.mirroring, title: p.current?.Name || null, position: typeof p.positionNow === 'function' ? p.positionNow() : null, element: el ? el.currentTime : null, at: Date.now() / 1000 }; }).catch(() => null);
  fs.writeFileSync(path.join(dir, 'state'), JSON.stringify(st));
  await new Promise((res) => setTimeout(res, 500));
}
await browser.close();
