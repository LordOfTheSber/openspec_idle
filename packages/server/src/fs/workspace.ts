import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { OPENSPEC_DIR } from '@openspec-ide/core';

/** Результат поиска корня OpenSpec. */
export type RootResolution =
  | { readonly kind: 'found'; readonly root: string; readonly startedFrom: string }
  | { readonly kind: 'not-found'; readonly startedFrom: string; readonly searched: string[] };

/**
 * Ищет ближайший каталог `openspec/` вверх по дереву от `startDir`, тем же
 * способом, что и CLI OpenSpec. Возвращает каталог, *содержащий* `openspec/`.
 */
export function resolveOpenspecRoot(startDir: string): RootResolution {
  const startedFrom = canonicalize(startDir);
  const searched: string[] = [];

  let current = startedFrom;
  for (;;) {
    searched.push(current);
    const candidate = resolve(current, OPENSPEC_DIR);
    if (isDirectory(candidate)) {
      return { kind: 'found', root: current, startedFrom };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { kind: 'not-found', startedFrom, searched };
}

/**
 * Приводит путь к каноническому виду: абсолютный, с разрешёнными
 * символическими ссылками. Для несуществующего пути разрешает ближайшего
 * существующего предка и достраивает остаток — иначе проверить путь файла,
 * который ещё только будет создан, было бы нечем.
 */
export function canonicalize(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(head)) {
      // native: на Windows даёт настоящий регистр букв пути и разрешает
      // junction — иначе один и тот же каталог выглядел бы двумя разными.
      const real = realpathSync.native(head);
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    }
    const parent = dirname(head);
    if (parent === head) return absolute;
    tail.push(head.slice(parent.length + 1));
    head = parent;
  }
}

/**
 * Проверяет, что канонический `path` лежит внутри канонического `root`.
 * Сам корень считается принадлежащим себе.
 */
export function isInsideRoot(root: string, path: string): boolean {
  const canonicalRoot = canonicalize(root);
  const canonicalPath = canonicalize(path);
  if (canonicalPath === canonicalRoot) return true;
  return canonicalPath.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
