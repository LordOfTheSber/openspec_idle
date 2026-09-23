#!/usr/bin/env node
// Заглушка внешнего редактора для тестов: записывает аргументы в файл из
// FAKE_EDITOR_LOG и завершается.
import { appendFileSync } from 'node:fs';

const log = process.env.FAKE_EDITOR_LOG;
if (log !== undefined) appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\n`);
