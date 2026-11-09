import { defineConfig } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  outputDir: '../../.cache/regress/test-results',
  // Real GPU, one window at a time: parallel runs would distort frame timing.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.REGRESS_CHANNEL || 'msedge',
    // Headless browsers can fall back to software rendering, which makes splat timing meaningless.
    headless: false,
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    launchOptions: {
      args: [
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
      ],
    },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    cwd: '../..',
  },
});
