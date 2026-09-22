#!/usr/bin/env node
// Поднимает сервер и Vite одной командой: сервер отдаёт API, Vite — страницу с HMR.
import { spawn } from 'node:child_process';
import process from 'node:process';

const children = [];

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const tag = `[${name}]`;
  child.stdout.on('data', (chunk) => process.stdout.write(`${tag} ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`${tag} ${chunk}`));
  child.on('exit', (code) => {
    console.log(`${tag} завершился с кодом ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', 'node', ['--watch', 'packages/cli/bin/openspec-ide.js', '--no-open', '--dev']);
run('web', 'npm', ['run', 'dev', '-w', '@openspec-ide/web']);
