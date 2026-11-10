import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';
import { api, uniq, names, row, centre, mouseDrag, freshLibrary, shot } from './library-helpers';

// Your Library's folders and order (server: library-folders.test.ts): + ›
// Folder, dragging with a mouse (reorder, into and out of folders, Escape,
// a failed save rolled back) and with a long press on the phone, kept on
// the server so a reload (or another device) shows the same.
test.use({ serviceWorkers: 'block' });

test.describe('desktop', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'desktop sidebar');
    await page.setViewportSize({ width: 1400, height: 900 });
    await login(page); await waitForLibrary(page);
  });

  test('+ makes a folder; dragging reorders, goes into and out of folders, and it all stays after a reload', async ({ page }) => {
    const n = uniq();
    const [A, B, C, D] = [`Alpha ${n}`, `Bravo ${n}`, `Charlie ${n}`, `Delta ${n}`];
    await freshLibrary(page, [A, B, C, D]);
    await page.reload(); await waitForLibrary(page);
    await expect.poll(() => names(page)).toEqual([A, B, C, D]);

    // Reorder: Charlie above Alpha. Mid-drag the others make room and the line shows.
    const to = await centre(row(page, A));
    await mouseDrag(page, row(page, C), { x: to.x, y: to.y - 4 }, {
      midway: async (p) => {
        await expect(p.locator('.libitem.lib-lifted')).toHaveCount(1);
        await expect(p.locator('.libdrop')).toHaveCSS('opacity', '1');
        await shot(p, 'desktop-mid-drag');
      },
      hold: async (p) => {
        await expect(p.locator('.libitem.lib-lifted')).toHaveCount(1);
        expect(await row(p, A).evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
      },
    });
    await expect.poll(() => names(page)).toEqual([C, A, B, D]);
    await expect(page.locator('.libitem.lib-lifted')).toHaveCount(0);

    // Escape puts it back.
    const b = await centre(row(page, B)); const d = await centre(row(page, D));
    await page.mouse.move(b.x, b.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(b.x, b.y + ((d.y - b.y) * i) / 8); await page.waitForTimeout(16); }
    await page.keyboard.press('Escape'); await page.mouse.up(); await page.waitForTimeout(300);
    await expect.poll(() => names(page)).toEqual([C, A, B, D]);

    // A small wobble is still a click: Bravo opens.
    const bb = await centre(row(page, B));
    await page.mouse.move(bb.x, bb.y); await page.mouse.down(); await page.mouse.move(bb.x + 2, bb.y + 2); await page.mouse.up();
    await expect(page.locator('.hero').getByText(B)).toBeVisible();

    // + › Folder
    await page.locator('.sidebar .libhead [aria-label="Create playlist"]').click();
    await page.locator('.ctxmenu .ctxitem', { hasText: 'Folder' }).click();
    const F = `Road ${n}`;
    await page.locator('.sidebar .newplaylist-input').fill(F); await page.keyboard.press('Enter');
    await expect(row(page, F)).toBeVisible();
    await expect.poll(() => names(page)).toEqual([F, C, A, B, D]);
    await expect(row(page, F).locator('.libitem-sub')).toHaveText('Folder • 0 items');

    // Into it: Bravo dropped on the folder (it lights up first).
    const f = await centre(row(page, F));
    await mouseDrag(page, row(page, B), f, { hold: async (p) => { await expect(row(p, F)).toHaveClass(/lib-target/); await expect(p.locator('.libdrop')).toHaveCSS('opacity', '0'); } });
    await expect.poll(() => names(page)).toEqual([F, C, A, D]);
    await expect(row(page, F).locator('.libitem-sub')).toHaveText('Folder • 1 items');
    // Opened, its things show under it.
    await row(page, F).click();
    await expect.poll(() => names(page)).toEqual([F, B, C, A, D]);
    await expect(row(page, B)).toHaveClass(/infolder/);
    // Delta into the open folder: dropped between the folder and Bravo, it is the folder's first.
    // (Below a folder's last thing is the top level again.)
    const fb = await centre(row(page, B));
    await mouseDrag(page, row(page, D), { x: fb.x, y: fb.y - 4 });
    await expect.poll(() => names(page)).toEqual([F, D, B, C, A]);
    await expect(row(page, D)).toHaveClass(/infolder/);
    await shot(page, 'desktop-library-folder');
    // Out of it: Bravo to the bottom.
    const last = await centre(row(page, A));
    await mouseDrag(page, row(page, B), { x: last.x, y: last.y + 8 });
    await expect.poll(() => names(page)).toEqual([F, D, C, A, B]);
    await expect(row(page, B)).not.toHaveClass(/infolder/);

    // Every device: the server has it, a reload shows it.
    const layout = await (await api(page)).get('/api/library/layout');
    expect(layout.folders.map((x: any) => x.name)).toEqual([F]);
    await page.reload(); await waitForLibrary(page);
    await expect.poll(() => names(page)).toEqual([F, D, C, A, B]);

    // A folder moves with what it holds (shut while it moves: no folder in a folder).
    const end = await centre(row(page, B));
    await mouseDrag(page, row(page, F), { x: end.x, y: end.y + 8 }, { hold: async (p) => { await expect(row(p, D)).toHaveCount(0); } });
    await expect.poll(() => names(page)).toEqual([C, A, B, F, D]);

    // Rename, then delete: what it held comes back where the folder was.
    await row(page, F).click({ button: 'right' });
    await page.locator('.ctxmenu .ctxitem', { hasText: 'Rename' }).click();
    const G = `Trips ${n}`;
    await page.locator('.sidebar .newplaylist-input').fill(G); await page.keyboard.press('Enter');
    await expect(row(page, G)).toBeVisible();
    page.once('dialog', (dl) => dl.accept());
    await row(page, G).click({ button: 'right' });
    await page.locator('.ctxmenu .ctxitem', { hasText: 'Delete' }).click();
    await expect.poll(() => names(page)).toEqual([C, A, B, D]);
    await page.reload(); await waitForLibrary(page);
    await expect.poll(() => names(page)).toEqual([C, A, B, D]);
    expect((await (await api(page)).get('/api/playlists')).items.length).toBe(4); // nothing it held was deleted
  });

  test('a failed save puts the library back as it was', async ({ page }) => {
    const n = uniq();
    const [A, B, C] = [`Echo ${n}`, `Foxtrot ${n}`, `Golf ${n}`];
    await freshLibrary(page, [A, B, C]);
    await page.reload(); await waitForLibrary(page);
    await page.route('**/api/library/layout', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, json: { error: 'down' } }) : r.continue()));
    const to = await centre(row(page, A));
    await mouseDrag(page, row(page, C), { x: to.x, y: to.y - 4 });
    await expect.poll(() => names(page)).toEqual([A, B, C]);
  });

  test('a folder takes a photo from its menu and shows it in the library', async ({ page }) => {
    const n = uniq(); const F = `Pics ${n}`;
    await freshLibrary(page, [`Hotel ${n}`]);
    await page.reload(); await waitForLibrary(page);
    await page.locator('.sidebar .libhead [aria-label="Create playlist"]').click();
    await page.locator('.ctxmenu .ctxitem', { hasText: 'Folder' }).click();
    await page.locator('.sidebar .newplaylist-input').fill(F); await page.keyboard.press('Enter');
    await expect(row(page, F)).toBeVisible();
    await expect(row(page, F).locator('img')).toHaveCount(0); // the folder icon until it has a picture
    await row(page, F).click({ button: 'right' });
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.ctxmenu .ctxitem', { hasText: 'Choose photo' }).click();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwHwyBNAMDA8N/BgB/bQn3nmDm/gAAAABJRU5ErkJggg==', 'base64');
    await (await chooser).setFiles({ name: 'p.png', mimeType: 'image/png', buffer: png });
    const img = row(page, F).locator('img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    await page.reload(); await waitForLibrary(page); // kept on the server
    await expect(row(page, F).locator('img')).toBeVisible();
  });
});

test.describe('phone', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'phone', 'touch');
    await login(page); await waitForLibrary(page);
  });

  test('a long press lifts a row and drags it; a tap still opens; a swipe still scrolls', async ({ page }) => {
    const n = uniq();
    const list = Array.from({ length: 14 }, (_, i) => `Phone ${String.fromCharCode(65 + i)} ${n}`);
    await freshLibrary(page, list);
    await page.reload(); await waitForLibrary(page);
    await page.locator('.tabbar button', { hasText: 'Your Library' }).click();
    await expect.poll(() => names(page)).toEqual(list);
    await expect(row(page, list[0]).locator('.libitem-name')).toBeVisible(); // names, not a covers-only rail
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x?: number, y?: number) => cdp.send('Input.dispatchTouchEvent', { type: type as any, touchPoints: x == null ? [] : [{ x, y: y! }] });

    // A swipe scrolls, it does not drag: a finger down and straight up the
    // list, as raw touch events (Chrome's synthesized scroll gesture does
    // not scroll anything in headless Chrome on Linux, where CI runs).
    const scroller = page.locator('.liblist');
    const s0 = await scroller.evaluate((el) => el.scrollTop);
    const mid = await centre(row(page, list[3]));
    await touch('touchStart', mid.x, mid.y);
    for (let dy = 10; dy <= 250; dy += 10) { await touch('touchMove', mid.x, mid.y - dy); await page.waitForTimeout(8); }
    await touch('touchEnd');
    await page.waitForTimeout(300);
    await expect(page.locator('.libitem.lib-lifted')).toHaveCount(0);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(s0);
    await expect.poll(() => names(page)).toEqual(list);
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(200);

    // Hold, then drag C above A.
    const c = await centre(row(page, list[2])); const a = await centre(row(page, list[0]));
    await touch('touchStart', c.x, c.y);
    await page.waitForTimeout(550);
    await expect(page.locator('.libitem.lib-lifted')).toHaveCount(1);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', c.x, c.y + ((a.y - 4 - c.y) * i) / 12); await page.waitForTimeout(16);
      if (i === 7) { await page.waitForTimeout(250); await shot(page, 'phone-mid-drag'); }
    }
    await page.waitForTimeout(150);
    await touch('touchEnd');
    await page.waitForTimeout(400);
    const moved = [list[2], list[0], list[1], ...list.slice(3)];
    await expect.poll(() => names(page)).toEqual(moved);
    await expect(page.locator('.ctxmenu')).toHaveCount(0); // a drag, not the menu

    // Held still and let go: the row's menu.
    const b = await centre(row(page, list[1]));
    await touch('touchStart', b.x, b.y); await page.waitForTimeout(550); await touch('touchEnd');
    await expect(page.locator('.ctxmenu .ctxitem', { hasText: 'Pin playlist' })).toBeVisible();
    await page.locator('.ctxmenu-scrim').click();

    // Kept on the server.
    await page.reload(); await waitForLibrary(page);
    await page.locator('.tabbar button', { hasText: 'Your Library' }).click();
    await expect.poll(() => names(page)).toEqual(moved);
    await shot(page, 'phone-library');

    // A tap opens.
    await row(page, list[0]).tap();
    await expect(page.locator('.hero').getByText(list[0])).toBeVisible();
  });

  test('+ › Folder on the phone, and a long-press drag into it', async ({ page }) => {
    const n = uniq();
    const [A, B] = [`Lima ${n}`, `Mike ${n}`];
    await freshLibrary(page, [A, B]);
    await page.reload(); await waitForLibrary(page);
    await page.locator('.tabbar button', { hasText: 'Your Library' }).click();
    await page.locator('.libhead [aria-label="Create playlist"]').click();
    await page.locator('.ctxmenu .ctxitem', { hasText: 'Folder' }).click();
    await expect(page.locator('.newpl h2')).toHaveText('Give your folder a name');
    const F = `November ${n}`;
    await page.locator('.newpl input').fill(F); await page.locator('.newpl .newpl-create').click();
    await expect.poll(() => names(page)).toEqual([F, A, B]);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x?: number, y?: number) => cdp.send('Input.dispatchTouchEvent', { type: type as any, touchPoints: x == null ? [] : [{ x, y: y! }] });
    const b = await centre(row(page, B)); const f = await centre(row(page, F));
    await touch('touchStart', b.x, b.y); await page.waitForTimeout(550);
    for (let i = 1; i <= 12; i++) { await touch('touchMove', b.x, b.y + ((f.y - b.y) * i) / 12); await page.waitForTimeout(16); }
    await expect(row(page, F)).toHaveClass(/lib-target/);
    await touch('touchEnd'); await page.waitForTimeout(400);
    await expect.poll(() => names(page)).toEqual([F, A]);
    await row(page, F).tap();
    await expect.poll(() => names(page)).toEqual([F, B, A]);
    await shot(page, 'phone-library-folder');
  });
});
