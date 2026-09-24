#!/usr/bin/env node
// Бэкенд IDE в HTTP-режиме — только для разработки интерфейса и сквозных
// тестов. Пользователи работают через расширение VS Code (packages/vscode).
//
//   node scripts/serve.mjs [путь] [--port <номер>] [--dev]
//
// --dev: страницу отдаёт Vite, сервер отдаёт только API.
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const entry = new URL('../packages/server/dist/index.js', import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  console.error('Бэкенд не собран: нет packages/server/dist/index.js. Выполните npm run build.');
  process.exit(1);
}

const { resolveOpenspecRoot, startServer } = await import(entry.href);

let path = process.cwd();
let port = null;
let dev = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--dev') dev = true;
  else if (arg === '--port') {
    port = Number(args[index + 1]);
    index += 1;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error('--port ожидает номер порта от 1 до 65535');
      process.exit(2);
    }
  } else if (arg.startsWith('-')) {
    console.error(`Неизвестная опция ${arg}`);
    process.exit(2);
  } else path = arg;
}

const resolution = resolveOpenspecRoot(path);
const root = resolution.kind === 'found' ? resolution.root : null;
const server = await startServer({ root, port, dev });

console.log(root === null ? `Каталог openspec/ не найден от ${resolution.startedFrom}` : `Рабочее пространство: ${root}`);
console.log(`OpenSpec IDE (разработка): ${server.url}`);

const stop = () => void server.close().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
