#!/usr/bin/env node
// Собирает команду проверки одним файлом dist/openspec-ide-check.mjs.
import { fileURLToPath } from 'node:url';
import { bundleCheck } from './bundle.mjs';

const outfile = fileURLToPath(new URL('./dist/openspec-ide-check.mjs', import.meta.url));
await bundleCheck(outfile);
console.error('Команда проверки собрана: packages/check/dist/openspec-ide-check.mjs');
