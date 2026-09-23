/**
 * Сборка десктопного приложения.
 *
 * Главный процесс вместе с сервером IDE собирается в один файл: так в
 * поставку не нужно везти node_modules рабочих пакетов. С ключом --release
 * дополнительно готовится встроенный CLI OpenSpec со всеми зависимостями —
 * его кладёт в ресурсы electron-builder.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const repo = join(pkg, '..', '..');
const dist = join(pkg, 'dist');
const release = process.argv.includes('--release');

rmSync(dist, { recursive: true, force: true });

const alias = {
  '@openspec-ide/core': join(repo, 'packages', 'core', 'src', 'index.ts'),
  '@openspec-ide/server': join(repo, 'packages', 'server', 'src', 'index.ts'),
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  alias,
  sourcemap: release ? false : 'linked',
  logLevel: 'warning',
};

// CommonJS: зависимости сервера (Fastify и его плагины) — CommonJS, и так
// они работают без обёрток. import.meta.url подставляется из __filename.
await build({
  ...common,
  entryPoints: [join(pkg, 'src', 'main.ts')],
  outfile: join(dist, 'main.cjs'),
  format: 'cjs',
  define: { 'import.meta.url': '__openspecImportMetaUrl' },
  banner: { js: "const __openspecImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});

await build({
  ...common,
  entryPoints: [join(pkg, 'src', 'preload.ts')],
  outfile: join(dist, 'preload.cjs'),
  format: 'cjs',
});

await build({
  ...common,
  platform: 'browser',
  target: 'chrome130',
  entryPoints: [join(pkg, 'src', 'start', 'start.ts')],
  outfile: join(dist, 'start', 'start.js'),
  format: 'iife',
});
for (const file of ['index.html', 'start.css']) {
  cpSync(join(pkg, 'src', 'start', file), join(dist, 'start', file));
}

if (!existsSync(join(repo, 'packages', 'web', 'dist', 'index.html'))) {
  console.warn('Внимание: страница IDE не собрана — выполните npm run build в корне репозитория.');
}

if (release) stageOpenspec();

/**
 * Копирует @fission-ai/openspec с его зависимостями в staging/openspec.
 * Пакет не собирается в один файл: он ищет свои схемы и package.json
 * относительными путями от разных модулей.
 */
function stageOpenspec() {
  const target = join(pkg, 'staging', 'openspec');
  rmSync(join(pkg, 'staging'), { recursive: true, force: true });
  const source = locatePackage('@fission-ai/openspec', repo);
  copyPackage(source, target);

  // Разрешение повторяет Node: зависимость ищется от каталога пакета, который
  // её требует. Первая встреченная версия кладётся в node_modules встроенного
  // CLI, другая версия того же пакета — рядом с тем, кому она нужна.
  const copied = new Map();
  const queue = [{ from: source, into: target }];
  let count = 0;
  while (queue.length > 0) {
    const { from, into } = queue.shift();
    const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'));
    const optional = manifest.optionalDependencies ?? {};
    for (const name of Object.keys({ ...manifest.dependencies, ...optional })) {
      const location = locatePackage(name, from, name in optional);
      if (location === null) continue;
      const hoisted = copied.get(name);
      if (hoisted === location) continue;
      const destination =
        hoisted === undefined ? join(target, 'node_modules', name) : join(into, 'node_modules', name);
      if (hoisted === undefined) copied.set(name, location);
      else if (existsSync(destination)) continue;
      copyPackage(location, destination);
      count += 1;
      queue.push({ from: location, into: destination });
    }
  }
  console.log(`Встроенный CLI OpenSpec: ${count} пакетов → ${target}`);
}

function locatePackage(name, fromDir, optional = false) {
  let current = fromDir;
  for (;;) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (optional) return null;
  throw new Error(`Не найден пакет ${name} (нужен ${fromDir}). Выполните npm ci.`);
}

function copyPackage(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (path) => !path.slice(from.length).split(/[\\/]/).includes('node_modules'),
  });
}
