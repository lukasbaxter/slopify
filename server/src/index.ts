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
// docker stop / ^C: close cleanly so sqlite flushes and in-flight requests
// finish; a 10s force-exit covers a wedged socket (idle websockets, a stuck
// NAS read) that would otherwise hang the container until Docker's kill.
let closing = false;
const shutdown = (sig: string) => {
  if (closing) return; // a second signal: the force-exit timer is already armed
  closing = true;
  app.log.info(`${sig} received, shutting down`);
  setTimeout(() => process.exit(1), 10000).unref();
  app.close().then(() => process.exit(0), (e) => { app.log.error(e); process.exit(1); });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// A rejected promise nobody awaited (a background sweep, a speaker probe, a
// fire-and-forget fetch) is a bug to log with its stack, not a reason to kill
// a music server mid-song: nothing was depending on that promise's result.
process.on('unhandledRejection', (err) => { app.log.error({ err }, 'unhandled rejection'); });
// A synchronous throw that reached the event loop means unknown program state
// (half-applied writes, leaked handles): log it, try to close so sqlite
// flushes, and exit(1) so Docker/systemd restarts us fresh.
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception');
  setTimeout(() => process.exit(1), 5000).unref();
  app.close().then(() => process.exit(1), () => process.exit(1));
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
