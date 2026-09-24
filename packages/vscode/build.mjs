#!/usr/bin/env node
// Собирает расширение: код — одним CommonJS-файлом, интерфейс — копией
// собранного packages/web/dist в media/web.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundleExtension } from './bundle.mjs';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

const webDist = here('../web/dist/');
if (!existsSync(`${webDist}index.html`)) {
  console.error('Интерфейс не собран: нет packages/web/dist/index.html.');
  console.error('Соберите его в корне репозитория: npm run build');
  process.exit(1);
}

await bundleExtension(here('./dist/extension.cjs'));

const media = here('./media/web/');
rmSync(media, { recursive: true, force: true });
cpSync(webDist, media, { recursive: true });

console.error('Расширение собрано: packages/vscode/dist/extension.cjs');
