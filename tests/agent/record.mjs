#!/usr/bin/env node
// Записывает интерфейс и потоки событий установленной сборки CLI агента.
//
//   node tests/agent/record.mjs <исполняемый файл> <каталог-результат>
//   node tests/agent/record.mjs gigacode tests/agent/gigacode-1.4.2
//
// Нужна сборка, принимающая флаги Qwen Code для OpenAI-совместимого шлюза
// (--auth-type openai --openai-base-url); модель подменяет mock-llm.mjs, поэтому
// ни ключ, ни сеть не нужны. После записи тест launch.test.ts сверяет шаблон
// аргументов IDE и с этой сборкой.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [bin, outArg] = process.argv.slice(2);
if (bin === undefined || outArg === undefined) {
  console.error('Использование: node tests/agent/record.mjs <исполняемый файл> <каталог-результат>');
  process.exit(2);
}
const out = resolve(outArg);
const mock = join(dirname(fileURLToPath(import.meta.url)), 'mock-llm.mjs');
mkdirSync(out, { recursive: true });

const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
const help = spawnSync(bin, ['--help'], { encoding: 'utf8' });
if (version.status !== 0) {
  console.error(`«${bin} --version» завершился с кодом ${version.status}: ${version.stderr}`);
  process.exit(1);
}
writeFileSync(join(out, 'help.txt'), help.stdout + help.stderr);

async function scenario(name, { mode = 'tool', delay = 0, env = {}, args = [], format = 'stream-json', file = `stream-${name}.jsonl` }) {
  const port = 18_500 + Math.floor(Math.random() * 400);
  const workspace = mkdtempSync(join(tmpdir(), 'agent-record-'));
  writeFileSync(join(workspace, 'tasks.md'), '- [ ] 1.1 Сделать\n');
  const server = spawn(process.execPath, [mock, String(port), mode, String(delay)], {
    env: { ...process.env, TARGET_FILE: join(workspace, 'tasks.md'), ...env(workspace) },
    stdio: 'ignore',
  });
  await new Promise((done) => setTimeout(done, 700));
  const result = spawnSync(
    bin,
    [
      'Выполни пункт 1.1',
      '--output-format',
      format,
      '--auth-type',
      'openai',
      '--openai-base-url',
      `http://127.0.0.1:${port}/v1`,
      '-m',
      'test-model',
      ...args,
    ],
    { cwd: workspace, encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'sk-record' }, timeout: 120_000 },
  );
  server.kill();
  const clean = (text) => text.split(workspace).join('/workspace');
  writeFileSync(join(out, file), clean(result.stdout));
  writeFileSync(join(out, file.replace(/\.jsonl?$/, '.stderr')), clean(result.stderr));
  rmSync(workspace, { recursive: true, force: true });
  console.log(`${name}: код ${result.status}`);
  return result.status;
}

const codes = {
  read: await scenario('read', { env: () => ({}), args: ['--approval-mode', 'plan', '--max-tool-calls', '5', '--max-wall-time', '60'] }),
  write: await scenario('write', {
    env: (workspace) => ({
      TOOL_NAME: 'write_file',
      TOOL_ARGS: JSON.stringify({ file_path: join(workspace, 'notes.md'), content: '# Заметки\n' }),
    }),
    args: ['--approval-mode', 'auto-edit', '--max-tool-calls', '5', '--max-wall-time', '60'],
  }),
  toolbudget: await scenario('toolbudget', { env: () => ({}), args: ['--approval-mode', 'plan', '--max-tool-calls', '0', '--max-wall-time', '60'] }),
  walltime: await scenario('walltime', { delay: 4000, env: () => ({}), args: ['--approval-mode', 'plan', '--max-tool-calls', '5', '--max-wall-time', '1s'] }),
  apierror: await scenario('apierror', { mode: 'fail', env: () => ({}), args: ['--approval-mode', 'plan'] }),
  oneshot: await scenario('oneshot', { env: () => ({}), args: ['--approval-mode', 'plan'], format: 'json', file: 'oneshot-read.json' }),
};

writeFileSync(
  join(out, 'recording.json'),
  `${JSON.stringify({ bin, version: version.stdout.trim(), recordedAt: new Date().toISOString(), exitCodes: codes }, null, 2)}\n`,
);
console.log(`Записано в ${out}. Проверьте: npx vitest run packages/server/src/agent packages/core/src/agentStream.test.ts`);
