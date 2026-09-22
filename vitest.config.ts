import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@openspec-ide/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@openspec-ide/server': fileURLToPath(
        new URL('./packages/server/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
