import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Every runtime dependency of the web app is one its code imports: an unused
// one (hls.js, long after the native players took over) is still installed,
// audited and listed in the third-party licenses for nothing.
test.skip(({ isMobile }) => isMobile, 'no browser needed');

test('the web app depends only on packages it imports', () => {
  const web = path.resolve(__dirname, '..', 'web');
  const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8')).dependencies || {});
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx?|tsx?|mjs)$/.test(e.name)) files.push(p); } };
  walk(path.join(web, 'src'));
  const code = [...files, path.join(web, 'vite.config.ts')].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const unused = deps.filter((d) => !new RegExp(`(?:from\\s*|import\\s*\\(?\\s*)['"]${d.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:/[^'"]*)?['"]`).test(code));
  expect(unused).toEqual([]);
});
