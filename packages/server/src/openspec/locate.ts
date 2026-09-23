import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { executableCandidates } from '../process/platform.js';

/** Где искали исполняемый файл и что нашли. */
export type CliLocation =
  | { readonly kind: 'found'; readonly bin: string; readonly source: 'project' | 'path' }
  | { readonly kind: 'not-found'; readonly searched: readonly string[] };

const BIN_NAME = 'openspec';

/**
 * Ищет исполняемый файл CLI OpenSpec: сначала в `node_modules/.bin` проекта и
 * выше по дереву, затем в PATH.
 *
 * Подъём по дереву обязателен: npm так же разрешает бинари, и в
 * монорепозитории зависимость обычно стоит в корне, а не в каталоге пакета.
 * Перечень просмотренных путей возвращается, чтобы сообщение об ошибке могло
 * его показать — иначе «не найден» ничего не объясняет.
 */
export function locateOpenspecCli(root: string, env: NodeJS.ProcessEnv = process.env): CliLocation {
  const searched: string[] = [];

  let current = root;
  for (;;) {
    for (const projectBin of executableCandidates(join(current, 'node_modules', '.bin'), BIN_NAME)) {
      searched.push(projectBin);
      if (isExecutable(projectBin)) return { kind: 'found', bin: projectBin, source: 'project' };
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const candidate of executableCandidates(dir, BIN_NAME)) {
      searched.push(candidate);
      if (isExecutable(candidate)) return { kind: 'found', bin: candidate, source: 'path' };
    }
  }

  return { kind: 'not-found', searched };
}

/** Текст блокирующего уведомления, когда CLI не найден. */
export function missingCliNotice(location: Extract<CliLocation, { kind: 'not-found' }>): {
  readonly title: string;
  readonly tool: string;
  readonly install: string;
  readonly searched: readonly string[];
} {
  return {
    title: 'Не найден CLI OpenSpec — без него IDE не может читать проект',
    tool: '@fission-ai/openspec',
    install: 'npm install -D @fission-ai/openspec',
    searched: location.searched,
  };
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // На Windows признака исполняемости нет: X_OK проверяет лишь наличие.
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
