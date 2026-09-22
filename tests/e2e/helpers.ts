import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../packages/cli/bin/openspec-ide.js', import.meta.url));

/** Запущенный для теста экземпляр IDE. */
export interface LaunchedIde {
  readonly url: string;
  /** Корень рабочего пространства, на котором запущена IDE. */
  readonly root: string;
  stop(): Promise<void>;
}

/** Поднимает IDE на фикстурном проекте и дожидается адреса из вывода. */
export async function launchIde(
  fixture: string,
  options: { writable?: boolean } = {},
): Promise<LaunchedIde> {
  // Тесты, которые пишут в файлы, работают на копии: фикстура в репозитории
  // должна оставаться неизменной.
  const source = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
  const temporary =
    options.writable === true ? mkdtempSync(join(tmpdir(), 'osi-e2e-')) : null;
  if (temporary !== null) cpSync(source, temporary, { recursive: true });
  const root = temporary ?? source;
  const child: ChildProcess = spawn(process.execPath, [CLI, root, '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IDE не сообщила адрес')), 30_000);
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(buffer);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`IDE завершилась с кодом ${code ?? 'неизвестно'}`));
    });
  });

  return {
    url,
    root,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (child.exitCode === null) child.kill('SIGKILL');
      if (temporary !== null) rmSync(temporary, { recursive: true, force: true });
    },
  };
}
