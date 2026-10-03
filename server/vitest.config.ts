import { defineConfig } from 'vitest/config';

// The api tests boot the real server against the shared fixture library, and
// the enrich pass that follows a scan would write artist.jpg/cover.jpg into
// it in the background - poisoning the NEXT run's enrich tests. Tests never
// write into the library.
export default defineConfig({ test: { env: { SAVE_TO_LIBRARY: '0' } } });
