import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
// One lane of the device lab's browser matrix: the e2e suite in one browser
// against a server of its own (own port, own data dir), so lanes run side by
// side. lab.sh starts one `playwright test -c` per lane with:
//   LAB_LANE  chromium | firefox | webkit | phone
//   LAB_PORT  the lane's server port (default 8180)
//   LAB_DATA  the lane's data dir (default /tmp/slopify-lab-<lane>)
//   LAB_OPEN_GATES=1  name a desktop lane's project 'chromium', so the specs
//             gated on `project.name === 'chromium'` (two-device and
//             one-run-is-enough tests) run in that engine too
// The server is built once by lab.sh beforehand (no `npm run build` here).
// The repo's own playwright.config.ts is untouched.
const root = path.resolve(__dirname, '../..');
const lane = process.env.LAB_LANE || 'chromium';
const port = Number(process.env.LAB_PORT || 8180);
const data = process.env.LAB_DATA || `/tmp/slopify-lab-${lane}`;
const chromeArgs = ['--autoplay-policy=no-user-gesture-required'];

const use: Record<string, unknown> = {
  chromium: { browserName: 'chromium', launchOptions: { args: chromeArgs } },
  phone: { browserName: 'chromium', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, launchOptions: { args: chromeArgs } },
  // Firefox: allow autoplay the way the Chrome flag does.
  firefox: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 720 }, launchOptions: { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } } },
  webkit: { browserName: 'webkit', viewport: { width: 1280, height: 720 } },
}[lane] as Record<string, unknown>;
if (!use) throw new Error(`LAB_LANE ${lane}: chromium | firefox | webkit | phone`);

const gates = process.env.LAB_OPEN_GATES === '1' && lane !== 'phone';
const name = gates ? 'chromium' : lane;
const tag = gates ? `${lane}-gates` : lane; // results/<tag>, results/<tag>.json

export default defineConfig({
  testDir: path.join(root, 'e2e'),
  // offline.spec starts its own servers on fixed ports (8093/8094) and
  // launches WebKit and Chromium itself whatever the project: run it in the
  // chromium lane only, or the lanes collide.
  testIgnore: lane === 'chromium' ? [] : ['**/offline.spec.ts'],
  outputDir: path.join(root, `tools/device-lab/results/${tag}`),
  reporter: [['list'], ['json', { outputFile: path.join(root, `tools/device-lab/results/${tag}.json`) }]],
  timeout: 60000,
  workers: 1, // a lane's tests share its server and admin
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `rm -rf ${data} && NODE_ENV=test SAVE_TO_LIBRARY=0 SPEAKERS=0 MUSIC_DIR=fixtures/music DATA_DIR=${data} PORT=${port} LOG_LEVEL=warn LOGIN_RATE_MAX=1000 RATE_MAX=100000 node server/dist/index.js`,
    cwd: root,
    url: `http://localhost:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name, use }],
});
