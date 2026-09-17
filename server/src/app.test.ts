import { describe, it, expect } from 'vitest';
import { buildServer } from './app.js';

describe('server', () => {
  it('answers the health check', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });
});
