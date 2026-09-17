import { buildServer } from './app.js';
import { config } from './config.js';

const app = await buildServer();
try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
