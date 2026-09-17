import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildServer } from './app.js';

describe('server', () => {
  it('answers the health check', async () => {
    const app = await buildServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-app-')) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });
});
