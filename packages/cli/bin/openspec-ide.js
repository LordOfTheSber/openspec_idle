#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/run.js', import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  console.error('OpenSpec IDE не собрана: нет файла packages/cli/dist/run.js.');
  console.error(`Соберите её в корне репозитория (${root}):`);
  console.error('  npm ci');
  console.error('  npm run build');
  process.exit(1);
}

const { run } = await import(entry.href);
const outcome = await run(process.argv.slice(2));

for (const line of outcome.stdout) console.log(line);
for (const line of outcome.stderr) console.error(line);

if (outcome.code !== 0) process.exit(outcome.code);
