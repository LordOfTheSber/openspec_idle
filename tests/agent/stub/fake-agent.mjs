#!/usr/bin/env node
// Заглушка GigaCode CLI: воспроизводит записанные потоки настоящего CLI.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const recorded = join(here, '..', 'qwen-code-0.24.4');
const args = process.argv.slice(2);
const legacy = process.env.FAKE_AGENT_LEGACY === '1';

if (args.includes('--version')) {
  process.stdout.write(legacy ? '0.9.0-legacy\n' : '1.4.2-fake\n');
  process.exit(0);
}
if (args.includes('--help')) {
  const help = readFileSync(join(recorded, 'help.txt'), 'utf8');
  process.stdout.write(legacy ? help.replaceAll('"stream-json"', '"text-stream"').replaceAll('stream-json', 'text-stream') : help);
  process.exit(0);
}

const prompt = args[0] ?? '';
if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);

const format = args[args.indexOf('--output-format') + 1] ?? 'text';
const scenarioFile = process.env.FAKE_AGENT_SCENARIO_FILE;
const scenario =
  scenarioFile !== undefined && existsSync(scenarioFile)
    ? readFileSync(scenarioFile, 'utf8').trim()
    : (process.env.FAKE_AGENT_SCENARIO ?? 'write');
const cwd = process.cwd();

function lines(name) {
  return readFileSync(join(recorded, `stream-${name}.jsonl`), 'utf8')
    .replaceAll('/workspace', cwd)
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function emit(all, code, stderr = '') {
  if (format === 'json') {
    process.stdout.write(`[${all.join(',')}]\n`);
  } else {
    for (const line of all) process.stdout.write(`${line}\n`);
  }
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

switch (scenario) {
  case 'read':
    emit(lines('read'), 0);
    break;
  case 'write':
    writeFileSync(join(cwd, 'notes.md'), '# Заметки\n');
    emit(lines('write'), 0);
    break;
  case 'toolbudget':
    emit(lines('toolbudget'), 55, readFileSync(join(recorded, 'stream-toolbudget.stderr'), 'utf8'));
    break;
  case 'walltime':
    emit(lines('walltime'), 55, readFileSync(join(recorded, 'stream-walltime.stderr'), 'utf8'));
    break;
  case 'apierror':
    emit(lines('apierror'), 1);
    break;
  case 'unknown': {
    const all = lines('read');
    process.stdout.write(`${all[0]}\n{"type":"thought_summary","text":"размышление"}\n${all.slice(2, 5).join('\n')}\n{"type":"result","subt`);
    process.exit(0);
    break;
  }
  case 'echo-prompt': {
    const init = lines('read')[0];
    const text = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: prompt }] } });
    emit([init, text, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 10, output_tokens: 2 } })], 0);
    break;
  }
  case 'hang': {
    const all = lines('read');
    process.stdout.write(`${all[0]}\n${all[2]}\n${all[3]}\n`);
    // Игнорирует SIGTERM, если попросили: проверка принудительного снятия.
    if (process.env.FAKE_AGENT_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.stderr.write(`неизвестный сценарий ${scenario}\n`);
    process.exit(2);
}
