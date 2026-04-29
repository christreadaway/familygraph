'use strict';

// Playwright config for the dashboard end-to-end suite. The webServer block
// boots an isolated Family Graph server in /tmp/fg-pw with a fresh secret +
// SQLite file, so the browser flows do not collide with a developer's
// running instance and never touch real data.

const { defineConfig } = require('@playwright/test');
const path = require('path');

const PORT = process.env.PW_FG_PORT || 13500;
const HOME = path.join('/tmp', 'fg-pw-' + process.pid);

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.js',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    headless: true,
    trace: 'retain-on-failure',
    // Use the headless-shell chromium build that `npx playwright install
    // chromium` puts in /opt/pw-browsers — the full headed chromium isn't
    // available in this environment.
    launchOptions: { channel: 'chromium' },
  },
  webServer: {
    command: `FAMILY_GRAPH_HOME=${HOME} FAMILY_GRAPH_PORT=${PORT} node server/index.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      FAMILY_GRAPH_HOME: HOME,
      FAMILY_GRAPH_PORT: String(PORT),
    },
  },
});
