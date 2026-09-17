import { defineConfig } from '@playwright/test';
// E2E runs against a server started on the fixture library and a data dir
// under /tmp; nothing here ever touches a real library or account.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  use: { baseURL: 'http://localhost:8080', trace: 'retain-on-failure' },
  webServer: {
    command: 'MUSIC_DIR=fixtures/music DATA_DIR=/tmp/slopify-e2e-data PORT=8080 npm run build -w web && MUSIC_DIR=fixtures/music DATA_DIR=/tmp/slopify-e2e-data PORT=8080 node server/dist/index.js',
    url: 'http://localhost:8080/healthz',
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'phone', use: { browserName: 'chromium', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true } }],
});
