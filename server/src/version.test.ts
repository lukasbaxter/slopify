// The version the server reports (/api/server, Settings › About, problem
// reports) is the release the image was built from (SLOPIFY_VERSION, set by
// the Dockerfile from docker.yml), not server/package.json, which stays at
// whatever it was last bumped to.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

async function load(env: string | undefined) {
  vi.resetModules();
  if (env === undefined) vi.stubEnv('SLOPIFY_VERSION', undefined as any);
  else vi.stubEnv('SLOPIFY_VERSION', env);
  return (await import('./app.js')).VERSION;
}

describe('VERSION', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is the release stamped into the image', async () => {
    expect(await load('0.1.162')).toBe('0.1.162');
  });

  it('is an honest main build name', async () => {
    expect(await load('main-48d6b63')).toBe('main-48d6b63');
  });

  it('falls back to package.json in development', async () => {
    expect(await load(undefined)).toBe(pkg);
    expect(await load('')).toBe(pkg);
  });
});
