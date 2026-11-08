import { test, expect, type Page } from '@playwright/test';
import { login, waitForLibrary } from './helpers';
import { uniq, names, row, centre, mouseDrag, freshLibrary, shot } from './library-helpers';

// The desktop layout at every window width: the greeting's shortcut grid
// steps 4, 3, 2, 1 with the main view's width, nothing passes the right
// edge (main view, top bar, right panel, player bar), and Your Library
// folds to a covers-only rail when it is narrow, dragging included.
test.use({ serviceWorkers: 'block' });

test.describe('window widths', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'desktop layout');
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page); await waitForLibrary(page);
  });
  const state = (page: Page) => page.evaluate(() => {
    const W = innerWidth; const over: string[] = [];
    if (document.documentElement.scrollWidth > W) over.push(`document ${document.documentElement.scrollWidth}`);
    for (const sel of ['.navbar', '.navbar-right', '.shell', '.sidebar', '.content', '.rightpanel', '.player', '.player-row', '.player-right']) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        const b = el.getBoundingClientRect();
        if (b.width && Math.round(b.right) > W) over.push(`${sel} ends at ${Math.round(b.right)}`);
        if (sel !== '.content' && el.scrollWidth > el.clientWidth + 1) over.push(`${sel} scrolls ${el.scrollWidth}/${el.clientWidth}`);
      }
    }
    const sc = document.querySelector('.shortcuts');
    return { over, cols: sc ? getComputedStyle(sc).gridTemplateColumns.split(' ').length : 0, folded: !!document.querySelector('.shell.rail-collapsed') };
  });

  test('the greeting grid steps 4, 3, 2, 1 with the main view; nothing goes past the right edge; the library folds to covers', async ({ page }) => {
    test.setTimeout(120000);
    const seen = new Set<number>();
    for (const panel of [false, true]) {
      if (panel) await page.locator('.player-right .icon-btn[title="Queue"]').click();
      for (let w = 1920; w >= 761; w -= 25) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(60);
        const s = await state(page);
        expect(s.over, `${w}px${panel ? ' with the queue open' : ''}`).toEqual([]);
        seen.add(s.cols);
        // the columns follow the main view's own width
        const main = await page.locator('.home').evaluate((el) => { const c = getComputedStyle(el); return el.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight); });
        expect(s.cols, `${w}px: main ${main}`).toBe(main >= 880 ? 4 : main >= 640 ? 3 : main >= 400 ? 2 : 1);
        // folded exactly when the main view would get under 560 px beside a full rail
        const full = w - 16 - 280 - 8 - (panel ? 8 + 340 : 0);
        expect(s.folded, `${w}px`).toBe(full < 560);
        if (panel && w === 1195) await shot(page, 'desktop-1195-queue-rail-folded');
        if (!panel && w === 1020) await shot(page, 'desktop-1020-three-columns');
        if (panel && w === 770) await shot(page, 'desktop-770-queue-one-column');
      }
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  test('the folded rail: covers with names as tooltips, + still works, and dragging works there too', async ({ page }) => {
    const n = uniq();
    const [A, B, C] = [`Hotel ${n}`, `India ${n}`, `Juliet ${n}`];
    await freshLibrary(page, [A, B, C]);
    await page.reload(); await waitForLibrary(page);
    await page.setViewportSize({ width: 840, height: 900 });
    await expect(page.locator('.shell.rail-collapsed')).toHaveCount(1);
    await expect(page.locator('.sidebar .libitem-text').first()).toBeHidden();
    await expect(row(page, A)).toHaveAttribute('title', A);
    expect((await page.locator('.sidebar').boundingBox())!.width).toBeLessThan(80);
    // + › Folder in the rail
    await page.locator('.sidebar .libhead [aria-label="Create playlist"]').click();
    await page.locator('.ctxmenu .ctxitem', { hasText: 'Folder' }).click();
    const F = `Kilo ${n}`;
    await page.locator('.sidebar .newplaylist-input').fill(F); await page.keyboard.press('Enter');
    await expect(row(page, F)).toBeVisible();
    await expect.poll(() => names(page)).toEqual([F, A, B, C]);
    // reorder: Juliet above Hotel
    const to = await centre(row(page, A));
    await mouseDrag(page, row(page, C), { x: to.x, y: to.y - 4 });
    await expect.poll(() => names(page)).toEqual([F, C, A, B]);
    // into the folder, then out again
    await mouseDrag(page, row(page, A), await centre(row(page, F)));
    await expect.poll(() => names(page)).toEqual([F, C, B]);
    await row(page, F).click();
    await expect.poll(() => names(page)).toEqual([F, A, C, B]);
    await shot(page, 'desktop-840-rail-folder');
    const last = await centre(row(page, B));
    await mouseDrag(page, row(page, A), { x: last.x, y: last.y + 8 });
    await expect.poll(() => names(page)).toEqual([F, C, B, A]);
    // wide again: the rail opens with the names
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.locator('.shell.rail-collapsed')).toHaveCount(0);
    await expect(row(page, A).locator('.libitem-name')).toBeVisible();
  });
});
