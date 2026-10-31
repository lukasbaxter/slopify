// The app's translatable text: every t('...') and N_('...') with a literal
// string in web/src. Prints what each locale (web/src/locales/<code>.json,
// English text -> translation) is missing or no longer uses.
//   node tools/i18n.mjs                  counts per locale
//   node tools/i18n.mjs --keys           every string, as a JSON array
//   node tools/i18n.mjs --missing de     what de.json lacks, as a JSON array
//   node tools/i18n.mjs --prune          drop unused strings from every locale
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = path.join(root, 'web/src');
const dir = path.join(src, 'locales');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'locales' ? [] : walk(path.join(d, e.name))) : /\.(jsx?|tsx?)$/.test(e.name) && e.name !== 'i18n.js' ? [path.join(d, e.name)] : []);
const re = /\b(?:t|N_)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g;
const unescape = (s) => s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
const keys = new Set();
for (const f of walk(src)) for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) keys.add(unescape(m[1] ?? m[2] ?? m[3]));
const all = [...keys].sort();
const locales = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
const load = (c) => JSON.parse(fs.readFileSync(path.join(dir, `${c}.json`), 'utf8'));
const arg = process.argv[2];
if (arg === '--keys') console.log(JSON.stringify(all, null, 1));
else if (arg === '--missing') { const d = locales.includes(process.argv[3]) ? load(process.argv[3]) : {}; console.log(JSON.stringify(all.filter((k) => !d[k]), null, 1)); }
else if (arg === '--prune') for (const c of locales) { const d = load(c); const kept = Object.fromEntries(Object.entries(d).filter(([k]) => keys.has(k)).sort(([a], [b]) => a.localeCompare(b))); fs.writeFileSync(path.join(dir, `${c}.json`), `${JSON.stringify(kept, null, 1)}\n`); }
else {
  console.log(`${all.length} strings`);
  for (const c of locales.sort()) { const d = load(c); const missing = all.filter((k) => !d[k]).length; const unused = Object.keys(d).filter((k) => !keys.has(k)).length; console.log(`${c.padEnd(6)} ${all.length - missing} translated, ${missing} missing${unused ? `, ${unused} unused` : ''}`); }
}
