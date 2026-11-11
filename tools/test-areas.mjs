#!/usr/bin/env node
// Runs only the tests a change can break. Each area owns some paths and a
// command; a change runs the areas whose paths it touches. Server unit tests
// that import code from another package (../../mobile/address.js etc.) also
// belong to that package's area, found by reading the imports, so a phone
// fix runs the phone's tests without the whole server suite and the e2e.
//
//   node tools/test-areas.mjs                  areas changed vs origin/main (+ uncommitted), then run them
//   node tools/test-areas.mjs --base <ref>     ... vs another ref
//   node tools/test-areas.mjs --list           print the areas, run nothing
//   node tools/test-areas.mjs --json           {"areas":[...]} for CI, run nothing
//   node tools/test-areas.mjs android ios      run these areas
//   node tools/test-areas.mjs all              run every area
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();

// Server unit tests that reach into another package, by that package's dir.
function crossTests() {
  const dir = join(ROOT, 'server/src');
  const out = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/from '\.\.\/\.\.\/([a-z-]+)\//g)) (out[m[1]] ||= new Set()).add(`src/${f}`);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}
const cross = crossTests();
const vitest = (files) => (files?.length ? `npx vitest run ${files.join(' ')}` : null);

// paths: prefixes that make the area run. Changes to anything not owned by
// an area (root package.json, lockfile, .github, fixtures) run everything.
const AREAS = {
  lint: { paths: ['server/', 'web/', 'e2e/', 'tools/', '.eslintrc', 'tsconfig'], run: [['.', 'npm run lint']] },
  server: { paths: ['server/', 'fixtures/'], run: [['.', 'npm test']] },
  web: {
    paths: ['web/', 'server/', 'e2e/', 'playwright.config.ts', 'fixtures/'],
    run: [['server', vitest(cross.web)], ['.', 'npm run e2e']],
  },
  // The phone shell (Expo, ships as the Android APK and the SideStore ipa).
  android: { paths: ['mobile/'], run: [['server', vitest(cross.mobile)]] },
  desktop: { paths: ['desktop/'], run: [['desktop', 'node --test electron/*.test.js']] },
  tv: { paths: ['tv/'], run: [] },
  tools: { paths: ['tools/'], run: [['.', 'for t in tools/tests/*.test.sh; do bash "$t" || exit 1; done']] },
  // The native iPhone app. Simulator unit tests; skipped where there is no Xcode.
  ios: { paths: ['ios/'], run: [['ios', 'make test']], needs: 'xcodebuild' },
  // The native Android app (Kotlin). JVM unit tests; skipped where there is no Java.
  'android-native': { paths: ['android/'], run: [['android', 'make test']], needs: 'java' },
  // The image build; CI only (nothing to run locally).
  docker: { paths: ['Dockerfile', 'docker/', 'server/', 'web/'], run: [] },
};
// Owned by no area, but harmless: docs, readmes, other platforms' assets.
const IGNORED = [/^docs\//, /\.md$/, /^LICENSE$/, /^ha\//, /^custom_components\//, /^hacs\.json$/, /^brain\//, /^aligner\//];

function changedFiles(base) {
  const committed = sh(`git diff --name-only ${base}...HEAD`);
  const local = sh('git status --porcelain').split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop());
  return [...new Set([...committed.split('\n').filter(Boolean), ...local])];
}

export function areasFor(files) {
  const hit = new Set();
  for (const f of files) {
    if (IGNORED.some((re) => re.test(f))) continue;
    const owners = Object.entries(AREAS).filter(([, a]) => a.paths.some((p) => f.startsWith(p))).map(([k]) => k);
    if (!owners.length) return Object.keys(AREAS); // shared file: everything
    owners.forEach((k) => hit.add(k));
  }
  return Object.keys(AREAS).filter((k) => hit.has(k));
}

function run(areas) {
  let failed = [];
  for (const name of areas) {
    const a = AREAS[name];
    if (!a) { console.error(`unknown area: ${name} (have: ${Object.keys(AREAS).join(', ')})`); process.exit(2); }
    if (a.needs && spawnSync('which', [a.needs]).status !== 0) { console.log(`\n== ${name}: skipped (no ${a.needs})`); continue; }
    for (const [cwd, cmd] of a.run) {
      if (!cmd) continue;
      if (!existsSync(join(ROOT, cwd))) continue;
      console.log(`\n== ${name}: ${cmd}`);
      const r = spawnSync(cmd, { cwd: join(ROOT, cwd), shell: true, stdio: 'inherit' });
      if (r.status !== 0) { failed.push(name); break; }
    }
  }
  console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : `\nok: ${areas.join(', ') || '(nothing to run)'}`);
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const bi = args.indexOf('--base');
  const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base');
  if (named.includes('all')) run(Object.keys(AREAS));
  else if (named.length) run(named);
  else {
    const areas = areasFor(changedFiles(bi >= 0 ? args[bi + 1] : 'origin/main'));
    if (flag('--json')) console.log(JSON.stringify({ areas }));
    else if (flag('--list')) console.log(areas.join('\n') || '(none)');
    else run(areas);
  }
}
