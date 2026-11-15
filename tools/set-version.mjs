#!/usr/bin/env node
// One version for the whole project. Every place that carries a version
// number is written from here, so Settings, the apps and the release tag
// never disagree (Settings said 0.1.81 at v0.1.197 because nothing did this).
//   node tools/set-version.mjs 0.1.198     write it everywhere
//   node tools/set-version.mjs --check     fail if any place differs from package.json
//   node tools/set-version.mjs --check 0.1.198   ... or from this version (the release tag)
// Release: run it with the new version, commit, then tag v<version>.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const at = (p) => path.join(root, p);
const args = process.argv.slice(2);
const check = args[0] === '--check';
const wanted = (check ? args[1] : args[0])?.replace(/^v/, '') || JSON.parse(fs.readFileSync(at('package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(wanted)) { console.error(`not a version: ${wanted}`); process.exit(2); }
// A build number that only ever grows: 0.1.198 -> 1198 (the Android scheme).
const [a, b, c] = wanted.split('.').map(Number);
const build = String(a * 1_000_000 + b * 1_000 + c);

// Each place: the file, how to read what it has, how to write the new one.
const json = (file, get, set) => ({
  file,
  read: (text) => get(JSON.parse(text)),
  write: (text) => { const j = JSON.parse(text); set(j); return JSON.stringify(j, null, 2) + '\n'; },
});
const line = (file, re, want = wanted) => ({
  file, want,
  read: (text) => text.match(re)?.[2],
  write: (text) => text.replace(re, `$1${want}$3`),
});
const places = [
  json('package.json', (j) => j.version, (j) => { j.version = wanted; }),
  json('server/package.json', (j) => j.version, (j) => { j.version = wanted; }),
  json('web/package.json', (j) => j.version, (j) => { j.version = wanted; }),
  json('desktop/package.json', (j) => j.version, (j) => { j.version = wanted; }),
  json('mobile/package.json', (j) => j.version, (j) => { j.version = wanted; }),
  json('mobile/app.json', (j) => j.expo.version, (j) => { j.expo.version = wanted; }),
  json('package-lock.json', (j) => [j.version, j.packages[''].version, j.packages.server?.version, j.packages.web?.version].every((v) => v === wanted) ? wanted : `${j.version}/${j.packages.server?.version}/${j.packages.web?.version}`,
    (j) => { j.version = wanted; for (const k of ['', 'server', 'web']) if (j.packages[k]) j.packages[k].version = wanted; }),
  json('desktop/package-lock.json', (j) => (j.version === wanted && j.packages[''].version === wanted ? wanted : j.version), (j) => { j.version = wanted; j.packages[''].version = wanted; }),
  json('mobile/package-lock.json', (j) => (j.version === wanted && j.packages[''].version === wanted ? wanted : j.version), (j) => { j.version = wanted; j.packages[''].version = wanted; }),
  line('ios/project.yml', /(MARKETING_VERSION: ")([^"]*)(")/),
  line('ios/project.yml', /(CURRENT_PROJECT_VERSION: ")([^"]*)(")/, build),
  line('android/app/build.gradle.kts', /(findProperty\("slopifyVersion"\) as String\?\) \?: ")([^"]*)(")/),
];

let wrong = 0;
for (const p of places) {
  if (!fs.existsSync(at(p.file))) continue;
  const text = fs.readFileSync(at(p.file), 'utf8');
  const want = p.want ?? wanted;
  const has = p.read(text);
  if (has === want) continue;
  if (check) { console.error(`${p.file}: ${has ?? 'no version found'}, expected ${want}`); wrong++; continue; }
  const next = p.write(text);
  if (p.read(next) !== want) { console.error(`${p.file}: could not set the version`); wrong++; continue; }
  fs.writeFileSync(at(p.file), next);
  console.log(`${p.file}: ${has} -> ${want}`);
}
if (wrong) process.exit(1);
console.log(check ? `every version is ${wanted}` : `version is ${wanted}`);
