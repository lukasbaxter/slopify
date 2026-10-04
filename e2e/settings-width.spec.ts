import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Settings on a phone fits the screen: nothing (the Tasks list included)
// pushes the page sideways.
test('phone settings never scroll sideways', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
  await login(page); await waitForLibrary(page);
  await page.locator('.navbar-right .avatar').click();
  await page.locator('.avatarmenu button', { hasText: 'Settings' }).click();
  await expect(page.locator('.task-row').first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200); // the page slides in
  await page.locator('.task-row').first().scrollIntoViewIfNeeded();
  const wide = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > W + 1 || r.width > W + 1) && getComputedStyle(el).position !== 'fixed' && !el.closest('svg')) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
    }
    return { W, scroll: document.scrollingElement!.scrollWidth, out: out.slice(0, 25) };
  });
  console.log(JSON.stringify(wide, null, 1));
  expect(wide.out).toEqual([]);
});
