/**
 * Playwright E2E config: headless Chromium against the Vite dev server.
 *
 * Covers the scenarios Node tests can't reach: file open/save dialogs (via
 * setInputFiles / download interception), real WebCodecs export, AudioContext.
 *
 * `--autoplay-policy=no-user-gesture-required` lets <audio>/AudioContext start
 * without a user gesture; vite.config.ts already sets the COOP/COEP headers
 * the app needs (SharedArrayBuffer for vocal separation).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    acceptDownloads: true,
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: 'npx vite --no-open',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
