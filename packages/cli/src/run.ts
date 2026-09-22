import { spawn } from 'node:child_process';
import { resolveOpenspecRoot } from '@openspec-ide/core';
import { PortInUseError, startServer } from '@openspec-ide/server';
import { ArgsError, helpText, parseArgs } from './args.js';

/** Что CLI напечатал и с каким кодом завершился бы. */
export interface RunOutcome {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** Запущенный сервер — только когда запуск удался. */
  readonly close?: () => Promise<void>;
}

const VERSION = '0.1.0';

/**
 * Выполняет запуск без побочных эффектов на process: вывод возвращается
 * вызывающему, чтобы поведение можно было проверить тестом.
 */
export async function run(argv: readonly string[]): Promise<RunOutcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof ArgsError) {
      stderr.push(error.message);
      return { code: 2, stdout, stderr };
    }
    throw error;
  }

  if (options.help) {
    stdout.push(helpText());
    return { code: 0, stdout, stderr };
  }
  if (options.version) {
    stdout.push(VERSION);
    return { code: 0, stdout, stderr };
  }

  const resolution = resolveOpenspecRoot(options.path);
  const root = resolution.kind === 'found' ? resolution.root : null;

  let server;
  try {
    server = await startServer({ root, port: options.port, dev: options.dev });
  } catch (error) {
    if (error instanceof PortInUseError) {
      stderr.push(error.message);
      return { code: 1, stdout, stderr };
    }
    stderr.push(error instanceof Error ? error.message : String(error));
    return { code: 1, stdout, stderr };
  }

  if (root === null) {
    stdout.push(
      `В каталоге ${resolution.startedFrom} и выше по дереву не найден каталог openspec/.`,
      'IDE откроется в состоянии «проект не инициализирован».',
      'Чтобы завести проект, выполните: openspec init',
    );
  } else {
    stdout.push(`Рабочее пространство: ${root}`);
  }
  stdout.push(`OpenSpec IDE: ${server.url}`);

  if (options.open) {
    openBrowser(server.url);
  }

  return { code: 0, stdout, stderr, close: server.close };
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Открыть браузер — удобство, а не условие запуска: URL уже напечатан.
  }
}
