import { defineConfig } from '@playwright/test';

/**
 * E2E десктопного приложения: настоящий Electron с собранным главным
 * процессом (`npm run desktop:build`). На Linux без дисплея — под xvfb-run.
 */
export default defineConfig({
  testDir: './tests/desktop',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : 'dot',
});
