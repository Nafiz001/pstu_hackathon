import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive a real browser against the real API.
 *
 * There are no mocks and no fixtures: every assertion below is about money that actually moved
 * through the ledger. That is the point — the UI's job is to tell the truth about the backend,
 * and a test against a stubbed API cannot check that.
 *
 * The API is expected to be running (the compose stack on :18090, or `npm run dev` in ../backend
 * with API_TARGET set). Vite is started here.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Serially: the tests share one database, and a couple of them assert on totals.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
