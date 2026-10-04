// Сборка команды проверки одним ESM-файлом. Используется скриптом сборки и
// дымовым тестом, чтобы тест проверял ровно тот файл, что уходит в CI.
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/** Собирает src/cli.ts в outfile. */
export async function bundleCheck(outfile) {
  await build({
    entryPoints: [here('./src/cli.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Пакеты монорепозитория — из исходников, как у расширения.
    alias: {
      '@openspec-ide/core': here('../core/src/index.ts'),
      '@openspec-ide/server': here('../server/src/index.ts'),
    },
    // Зависимости на CommonJS вызывают require — в ESM его нужно создать.
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
    legalComments: 'none',
    logLevel: 'warning',
  });
  chmodSync(outfile, 0o755);
}
