import { test, expect } from '@playwright/test';
import { login, waitForLibrary } from './helpers';
import { api, uniq, fourAlbums, row, freshLibrary, shot } from './library-helpers';

// Spotify's playlist covers (server: playlist-covers.test.ts): a 2x2 grid
// of the first 4 different album covers, else the first song's cover, the
// same picture on the page and in Your Library.
test.use({ serviceWorkers: 'block' });

test.describe('desktop', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'desktop sidebar');
    await page.setViewportSize({ width: 1400, height: 900 });
    await login(page); await waitForLibrary(page);
  });

  test('a playlist of 4+ albums shows a 2x2 grid of their covers, fewer show the first song\'s cover', async ({ page }) => {
    const a = await api(page);
    const albums = await fourAlbums(a);
    const grid = `Grid ${uniq()}`, single = `Single ${uniq()}`;
    await freshLibrary(page, []);
    await a.post('/api/playlists', { name: grid, trackIds: albums.map((t: any) => t[0].id) });
    await a.post('/api/playlists', { name: single, trackIds: [albums[1][0].id, albums[2][0].id, albums[1][1].id] });
    await page.reload(); await waitForLibrary(page);
    const quadrants = async (sel: string) => quadrantsOf(page.locator(sel));
    const quadrantsOf = async (loc: any) => {
      const img = loc.first();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15000 }).toBe(true);
      return img.evaluate((el: HTMLImageElement) => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d')!; g.drawImage(el, 0, 0, 64, 64);
        return [[16, 16], [48, 16], [16, 48], [48, 48]].map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)).join(','));
      });
    };
    for (const [name, expectGrid] of [[grid, true], [single, false]] as const) {
      await row(page, name).click();
      await expect(page.locator('.hero .fitted-title, .hero h1').first()).toBeVisible();
      const q = await quadrants('.hero-cover img');
      if (expectGrid) expect(new Set(q).size).toBe(4); else expect(new Set(q).size).toBe(1);
      // the same picture in the library row
      const rowQ = await quadrantsOf(row(page, name).locator('img'));
      if (expectGrid) expect(new Set(rowQ).size).toBe(4); else expect(new Set(rowQ).size).toBe(1);
      await shot(page, `desktop-cover-${expectGrid ? 'grid' : 'single'}`);
    }
  });

});
