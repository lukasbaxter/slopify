// The app's words in the person's language. English is the source and the
// key: t('Add to queue') is the translation from locales/<code>.json, or the
// English itself when there is none yet, so a missing string never shows a
// key. {name} placeholders are filled from the second argument.
//
// Which language: the person's own pick (Settings, saved in their prefs and
// cached here), else the server's LANGUAGE (docker), else the browser's.
// The dictionary is loaded before the first render (main.jsx) and a change
// reloads the page, so no component has to re-render on its own.

export const LANGUAGES = [
  ['en', 'English'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
  ['pt-BR', 'Português (Brasil)'],
  ['nl', 'Nederlands'],
  ['pl', 'Polski'],
  ['ru', 'Русский'],
  ['uk', 'Українська'],
  ['tr', 'Türkçe'],
  ['sv', 'Svenska'],
  ['da', 'Dansk'],
  ['nb', 'Norsk bokmål'],
  ['fi', 'Suomi'],
  ['cs', 'Čeština'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['id', 'Bahasa Indonesia'],
  ['vi', 'Tiếng Việt'],
];

const USER_KEY = 'slopify.lang.user';     // the person's pick, '' = automatic
const SERVER_KEY = 'slopify.lang.server'; // the server's LANGUAGE, last seen
const files = import.meta.glob('./locales/*.json');

let dict = null;
let current = 'en';

const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const write = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };

/** The closest language we have for a code like 'pt', 'pt-PT', 'zh-Hant-TW' or 'no'. */
export function match(code) {
  if (!code || code === 'auto') return null;
  const c = String(code).replace('_', '-').toLowerCase();
  const exact = LANGUAGES.find(([k]) => k.toLowerCase() === c);
  if (exact) return exact[0];
  if (c.startsWith('zh')) return /tw|hk|mo|hant/.test(c) ? 'zh-TW' : 'zh-CN';
  if (c === 'no' || c.startsWith('nn') || c.startsWith('no-') || c.startsWith('nb')) return 'nb';
  const base = c.split('-')[0];
  return LANGUAGES.find(([k]) => k.toLowerCase().split('-')[0] === base)?.[0] || null;
}

export function resolve(user = read(USER_KEY), server = read(SERVER_KEY), browser = typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : []) {
  return match(user) || match(server) || browser.map(match).find(Boolean) || 'en';
}

export const language = () => current;
export const userLanguage = () => read(USER_KEY);

/** Marks text in a module-level constant for translation; show it with t(value) when rendering. */
export const N_ = (s) => s;

export function t(s, vars) {
  let out = (dict && dict[s]) || s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return out;
}

/** Load the dictionary for the resolved language. Called once before the first render. */
export async function loadLanguage() {
  current = resolve();
  document.documentElement.lang = current;
  const load = files[`./locales/${current}.json`];
  if (current !== 'en' && load) {
    try { dict = (await load()).default; } catch { dict = null; }
  }
  return current;
}

/** The server's default, checked after start; a change applies on the next launch, or now if nothing was known yet. */
export async function checkServerLanguage(baseUrl = '') {
  try {
    const r = await fetch(`${baseUrl}/api/i18n`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const { language: l } = await r.json();
    const before = resolve();
    write(SERVER_KEY, l && l !== 'auto' ? l : '');
    if (resolve() !== before && !read(USER_KEY)) window.location.reload();
  } catch { /* offline: keep what we had */ }
}

/** The person's pick ('' = automatic), from Settings or their synced prefs. Reloads when it changes what is shown. */
export function setUserLanguage(code) {
  const before = resolve();
  write(USER_KEY, code || '');
  // A moment first, so the pick that caused this has been saved to the account.
  if (resolve() !== before) setTimeout(() => window.location.reload(), 800);
}
