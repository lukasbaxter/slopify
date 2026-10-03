import { buildServer } from './app.js';
import { config } from './config.js';

const app = await buildServer();
// A full scan at boot if asked; recurring scans are a scheduled task now (tasks.ts).
if (config.scanOnBoot) (app as any).runScan();
// New music on the SSD -> the NAS (see ingest.ts); the first sweep a minute after boot.
const ingest = (app as any).ingest;
if (ingest) {
  const sweep = () => ingest.sweep().then(() => (app as any).runAfterScan?.()).catch((e: any) => app.log.error(`ingest: ${e.message}`));
  setTimeout(sweep, 60000).unref();
  setInterval(sweep, config.ingest.everyMin * 60000).unref();
}
try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
