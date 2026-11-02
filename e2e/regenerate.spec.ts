import { test, expect } from '@playwright/test';
import { login, PW } from './helpers';

// A generated playlist's ⋯ menu has Regenerate: the prompt box opens with
// what was asked, the request can change, and the same playlist is filled
// again (the server side is server/src/brain.test.ts). The e2e server has no
// brain, so the AI status and job answers are stood in.
test.use({ serviceWorkers: 'block' });
test('Regenerate opens the prompt with the old request and refills the same playlist', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'desktop menus');
  await page.request.post('/api/auth/login', { data: { username: 'admin', password: 'admin' } }); // first-run password change happens in login()
  await login(page);
  const tok = (await (await page.request.post('/api/auth/login', { data: { username: 'admin', password: PW } })).json()).token;
  const pl = await (await page.request.post('/api/playlists', { headers: { authorization: `Bearer ${tok}` }, data: { name: 'Dub night' } })).json();
  const withPrompt = (p: any) => (p.id === pl.id ? { ...p, aiPrompt: 'warm dub techno' } : p);
  await page.route('**/api/playlists', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const j = await (await route.fetch()).json(); await route.fulfill({ json: { ...j, items: j.items.map(withPrompt) } });
  });
  await page.route(`**/api/playlists/${pl.id}`, async (route) => { const j = await (await route.fetch()).json(); await route.fulfill({ json: withPrompt(j) }); });
  await page.route('**/api/ai/status', (route) => route.fulfill({ json: { ok: true, by: 'brain' } }));
  let asked: any = null;
  await page.route('**/api/ai/playlists', (route) => { asked = route.request().postDataJSON(); return route.fulfill({ json: { id: 'job1', state: 'running', step: 'Starting' } }); });
  await page.route('**/api/jobs/job1', (route) => route.fulfill({ json: { id: 'job1', state: 'done', result: { playlistId: pl.id, name: 'Dub night', regenerated: true, count: 0, requested: 0 } } }));
  await page.reload();
  await page.locator('.sidebar').getByText('Dub night', { exact: true }).first().click();
  await page.locator('.iconbtn.more').first().click();
  await page.locator('.ctxmenu button', { hasText: 'Regenerate' }).click();
  const box = page.locator('.genpl textarea');
  await expect(page.locator('.genpl h3')).toHaveText('Regenerate playlist');
  await expect(box).toHaveValue('warm dub techno');
  await box.fill('colder dub techno, slower');
  await page.locator('.genpl button[type=submit]').click();
  await expect.poll(() => asked).toEqual({ prompt: 'colder dub techno, slower', playlistId: pl.id });
  await expect(page.locator('.genpl')).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator('.toast')).toContainText('Dub night regenerated');
  const all = await (await page.request.get('/api/playlists', { headers: { authorization: `Bearer ${tok}` } })).json();
  expect(all.items.filter((p: any) => p.name === 'Dub night')).toHaveLength(1);
});
