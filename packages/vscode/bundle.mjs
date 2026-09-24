// Сборка кода расширения одним CommonJS-файлом. Используется скриптом сборки
// и дымовым тестом, чтобы тест проверял ровно тот бандл, что уходит в .vsix.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/** Собирает src/extension.ts в outfile. */
export async function bundleExtension(outfile) {
  await build({
    entryPoints: [here('./src/extension.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // VS Code 1.90 работает на Node 20.
    target: 'node20',
    sourcemap: true,
    external: ['vscode'],
    // Пакеты монорепозитория берутся из исходников: сборка не зависит от
    // того, собраны ли их dist.
    alias: {
      '@openspec-ide/core': here('../core/src/index.ts'),
      '@openspec-ide/server': here('../server/src/index.ts'),
    },
    // В CommonJS нет import.meta: серверный код обращается к нему только для
    // пути к странице, которую встроенный бэкенд не раздаёт.
    define: { 'import.meta.url': '__importMetaUrl' },
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    logLevel: 'warning',
  });
}
