import { buildServer } from './app.js';
import { config } from './config.js';

const app = await buildServer();
// First scan at boot, then the library is rescanned every 6 h; admins can trigger one any time.
(app as any).runScan();
setInterval(() => (app as any).runScan(), 6 * 3600 * 1000).unref();
try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
