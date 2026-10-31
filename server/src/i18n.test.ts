import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';
// @ts-expect-error plain JS from the web app
import { match, resolve } from '../../web/src/i18n.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-i18n-'));
let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => { app = await buildServer({ dataDir: DATA, musicDir: DATA }); }, 60000);
afterAll(async () => { await app.close(); });

describe('language', () => {
  it('the server default is readable before sign-in', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/i18n' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ language: 'auto' });
  });

  it('matches what browsers and docker say to a language we have', () => {
    expect(match('de-AT')).toBe('de');
    expect(match('pt')).toBe('pt-BR');
    expect(match('pt_PT')).toBe('pt-BR');
    expect(match('zh-Hant-TW')).toBe('zh-TW');
    expect(match('zh')).toBe('zh-CN');
    expect(match('no')).toBe('nb');
    expect(match('auto')).toBe(null);
    expect(match('xx')).toBe(null);
  });

  it('the person beats the server, the server beats the browser', () => {
    expect(resolve('fr', 'de', ['ja'])).toBe('fr');
    expect(resolve('', 'de', ['ja'])).toBe('de');
    expect(resolve('', '', ['xx', 'ja-JP'])).toBe('ja');
    expect(resolve('', '', ['xx'])).toBe('en');
  });

  it('every translation keeps the placeholders of its English', () => {
    const dir = path.join(__dirname, '../../web/src/locales');
    const holes = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, string>;
      for (const [en, tr] of Object.entries(d)) expect(holes(tr), `${f}: ${en}`).toBe(holes(en));
    }
  });
});
