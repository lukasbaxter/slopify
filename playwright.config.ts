import { defineConfig } from '@playwright/test';
// E2E runs against a server started on the fixture library and a data dir
// under /tmp; nothing here ever touches a real library or account.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  use: { baseURL: 'http://localhost:8080', trace: 'retain-on-failure' },
  workers: 1, // the flows share one server and one admin account
  webServer: {
    // NODE_ENV=test keeps the background tasks tick off; SAVE_TO_LIBRARY=0
    // stops enrichment from hitting live LrcLib/Deezer or writing sidecars.
    command: 'rm -rf /tmp/slopify-e2e-data && npm run build && NODE_ENV=test SAVE_TO_LIBRARY=0 SPEAKERS=0 MUSIC_DIR=fixtures/music DATA_DIR=/tmp/slopify-e2e-data PORT=8080 LOG_LEVEL=warn LOGIN_RATE_MAX=1000 RATE_MAX=100000 node server/dist/index.js',
    url: 'http://localhost:8080/healthz',
    reuseExistingServer: false,
    timeout: 120000,
  },
  // The autoplay flag is Chrome's own: set per project, so a WebKit browser a
  // test launches itself (e2e/remote.spec.ts) does not get it (WebKit on
  // Linux refuses to start with an option it does not know).
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } } },
  ],
});
