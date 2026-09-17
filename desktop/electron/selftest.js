'use strict';
// Standalone check that discovery and both transports work against real hardware.
// Read-only: it identifies devices and reads status, and never starts playback.
//   node electron/selftest.js

const { Discovery } = require('./discovery');
const { BluOSTransport } = require('./transports/bluos');
const { CastTransport } = require('./transports/cast');

const DISCOVER_MS = 7000;

function main() {
  const found = [];
  const discovery = new Discovery((devices) => {
    found.length = 0;
    found.push(...devices);
  });

  console.log(`Discovering for ${DISCOVER_MS / 1000}s...\n`);
  discovery.start();

  setTimeout(async () => {
    discovery.stop();

    if (!found.length) {
      console.log('No devices found. Check that mDNS is not blocked on this network.');
      process.exit(1);
    }

    console.log(`Found ${found.length} device(s):\n`);
    for (const d of found) {
      console.log(`  [${d.kind.padEnd(5)}] ${d.name}`);
      console.log(`          ${d.host}:${d.port}  (${d.model})`);
    }

    console.log('\n--- BluOS status ---');
    for (const d of found.filter((x) => x.kind === 'bluos')) {
      try {
        const t = new BluOSTransport(d);
        const id = await t.identify();
        const s = await t.status();
        console.log(`  ${d.name}: ${id.brand} ${id.model} | state=${s.state} vol=${s.volume}` +
          (s.title ? ` | now: ${s.title}` : ''));
      } catch (e) {
        console.log(`  ${d.name}: FAILED ${e.message}`);
      }
    }

    console.log('\n--- Cast connectivity ---');
    for (const d of found.filter((x) => x.kind === 'cast')) {
      const t = new CastTransport(d);
      try {
        // Launching the receiver is the real proof the CASTV2 handshake works.
        // Nothing is loaded, so the device stays silent.
        await t._connect();
        console.log(`  ${d.name}: receiver launched OK`);
      } catch (e) {
        console.log(`  ${d.name}: FAILED ${e.message}`);
      } finally {
        t.close();
      }
    }

    console.log('\nDone.');
    process.exit(0);
  }, DISCOVER_MS);
}

main();
