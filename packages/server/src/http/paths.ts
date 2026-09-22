import { canonicalize, isInsideRoot } from '@openspec-ide/core';
import { isAbsolute, resolve } from 'node:path';

/** Путь отклонён, потому что ведёт за пределы рабочего пространства. */
export class OutsideWorkspaceError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(
      `Путь «${requested}» находится за пределами рабочего пространства ${root}. ` +
        'Операция отклонена.',
    );
    this.name = 'OutsideWorkspaceError';
  }
}

/**
 * Приводит запрошенный путь к абсолютному каноническому виду и проверяет, что
 * он принадлежит корню.
 *
 * Проверка выполняется после разрешения символических ссылок и относительных
 * переходов: сравнение строк до канонизации пропустило бы и `../`, и ссылку,
 * ведущую наружу.
 */
export function resolveInsideWorkspace(root: string, requested: string): string {
  const canonicalRoot = canonicalize(root);
  const absolute = isAbsolute(requested) ? requested : resolve(canonicalRoot, requested);
  const canonical = canonicalize(absolute);

  if (!isInsideRoot(canonicalRoot, canonical)) {
    throw new OutsideWorkspaceError(requested, canonicalRoot);
  }
  return canonical;
}
