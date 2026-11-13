import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';

// Owner, 11-13: Aurora drew nothing on "Match album art". audioMotion's
// registerGradient rewrites the colour list it is given (strings become
// objects), and the hand-drawn styles read that same list: every frame threw.
for (const style of ['aurora', 'orb']) {
  test(`${style} draws on album colours`, async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'desktop full screen');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await login(page);
    await page.goto('/?debug=1'); await waitForLibrary(page);
    await page.locator('.card, .shortcut', { hasText: 'First Light' }).first().click();
    await page.locator('.trackrow').first().dblclick();
    await expect(page.locator('.player button[title="Pause"]').first()).toBeVisible({ timeout: 20000 });
    await page.evaluate((s) => { localStorage.setItem('conduit.fsTab', 'viz'); (window as any).__updatePrefs({ viz: { style: s, gradient: 'album', smoothing: 0.6 } }); }, style);
    await page.locator('.player button[title="Now playing view"]').first().click();
    await expect(page.locator('canvas.viz-drawn')).toHaveCount(1, { timeout: 10000 });
    await page.waitForTimeout(2500);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
