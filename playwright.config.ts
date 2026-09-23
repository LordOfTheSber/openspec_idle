import { defineConfig } from '@playwright/test';

/**
 * E2E прогоняются поверх собранной страницы и настоящего сервера,
 * запущенного на фикстурном проекте, — так проверяется то же, что увидит
 * пользователь, а не отдельно взятый компонент.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : 'dot',
  use: {
    launchOptions: {
      executablePath: process.env['CHROMIUM_PATH'] ?? undefined,
    },
  },
});
