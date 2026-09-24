import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Интерфейс проверяется в HTTP-режиме бэкенда: та же сборка открывается и в
// панели VS Code, отличается только транспорт, который покрыт своими тестами.
const SERVE = fileURLToPath(new URL('../../scripts/serve.mjs', import.meta.url));

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
  options: {
    writable?: boolean;
    /** Переменные окружения процесса IDE поверх текущих. */
    env?: Record<string, string | undefined>;
    /** Подготовка копии проекта до запуска IDE. */
    prepare?: (root: string) => void;
  } = {},
): Promise<LaunchedIde> {
  // Тесты, которые пишут в файлы, работают на копии: фикстура в репозитории
  // должна оставаться неизменной.
  const source = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
  const temporary =
    options.writable === true ? mkdtempSync(join(tmpdir(), 'osi-e2e-')) : null;
  if (temporary !== null) cpSync(source, temporary, { recursive: true });
  const root = temporary ?? source;
  if (temporary !== null) options.prepare?.(temporary);
  const child: ChildProcess = spawn(process.execPath, [SERVE, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
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
