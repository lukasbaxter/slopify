import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// The Brain task (server/src/brain.ts) as an admin sees it: its row says what
// the brain is doing, its menu holds the household's rules, the Location box
// saves on Enter. The task list is the real one with a Brain row added: the
// e2e server has no brain.
test.use({ serviceWorkers: 'block' });
test('the Brain row shows what it is doing and its rules save', async ({ page }, info) => {
  const INFO = 'Heard 20,000 of 120,000 songs, about 8 h to go · Next song in its top 10: 9.2% (old mix 0.6%)';
  let location = '';
  const saved: any[] = [];
  await page.route('**/api/admin/tasks', async (route) => {
    const r = await route.fetch(); const j = await r.json();
    j.tasks.push({
      id: 'brain', name: 'Brain', description: 'The recommender on your GPU box.', schedule: { mode: 'daily', at: '04:00' }, canWatch: false, next: null,
      running: null, last: null, info: INFO,
      settings: [
        { key: 'power', label: 'GPU power', type: 'select', default: 'normal', value: 'normal', options: [{ value: 'full', label: 'Full: no breaks' }, { value: 'normal', label: 'Normal: 10 min on, 10 off' }, { value: 'cpu', label: "Don't use the GPU (slow)" }] },
        { key: 'pauseListening', label: 'Pause while anyone is listening', type: 'toggle', default: false, value: false },
        { key: 'location', label: 'Where you listen', type: 'text', default: '', value: location, placeholder: 'Lisbon, Portugal', maxLength: 100, help: 'A city, for the weather.' },
      ],
    });
    await route.fulfill({ json: j });
  });
  await page.route('**/api/admin/tasks/brain/settings', async (route) => {
    const body = route.request().postDataJSON(); saved.push(body.values);
    if (body.values.location !== undefined) location = body.values.location;
    await route.fulfill({ json: {} });
  });
  await login(page); await waitForLibrary(page);
  await page.locator('.navbar-right .avatar').click();
  await page.locator('.avatarmenu button', { hasText: 'Settings' }).click();
  const row = page.locator('.task-row', { hasText: 'Brain' });
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator('.task-meta')).toHaveText(INFO);
  await row.locator('.task-dots').click();
  const pop = row.locator('.task-pop');
  const box = pop.getByPlaceholder('Lisbon, Portugal');
  await box.fill('Lisbon, Portugal'); await box.press('Enter');
  await expect.poll(() => saved).toContainEqual({ location: 'Lisbon, Portugal' });
  await pop.locator('select').selectOption('cpu');
  await expect.poll(() => saved).toContainEqual({ power: 'cpu' });
  if (info.project.name === 'phone') {
    const b = await pop.boundingBox(); const W = page.viewportSize()!.width;
    expect(b!.x).toBeGreaterThanOrEqual(0); expect(b!.x + b!.width).toBeLessThanOrEqual(W + 1);
  }
});
