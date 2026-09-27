import { buildServer } from './app.js';
import { config } from './config.js';

const app = await buildServer();
// A full scan at boot and every SCAN_EVERY_H hours (both configurable); admins can trigger one any time.
if (config.scanOnBoot) (app as any).runScan();
if (config.scanEveryH > 0) setInterval(() => (app as any).runScan(), config.scanEveryH * 3600 * 1000).unref();
// New music on the SSD -> the NAS (see ingest.ts); the first sweep a minute after boot.
const ingest = (app as any).ingest;
if (ingest) {
  const sweep = () => ingest.sweep().then(() => (app as any).runAfterScan?.()).catch((e: any) => app.log.error(`ingest: ${e.message}`));
  setTimeout(sweep, 60000).unref();
  setInterval(sweep, config.ingest.everyMin * 60000).unref();
}
setInterval(() => (app as any).runEnrich(), 3600 * 1000).unref();
try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
