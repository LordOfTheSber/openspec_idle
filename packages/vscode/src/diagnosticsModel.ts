import type { ValidationEntry } from '@openspec-ide/server';

/** Уровень диагностики — в терминах панели «Проблемы». */
export type DiagnosticLevel = 'error' | 'warning' | 'info';

/** Одно замечание, привязанное к файлу. */
export interface FileDiagnostic {
  /** Строка с нуля, как в API VS Code. */
  readonly line: number;
  readonly level: DiagnosticLevel;
  readonly message: string;
}

const LEVEL: Record<ValidationEntry['level'], DiagnosticLevel> = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

/**
 * Раскладывает замечания валидации change по файлам.
 *
 * Замечание со строкой ложится на неё, без строки — на начало файла. Без
 * файла — на `proposal.md` change, если он есть, иначе на каталог change: в
 * панели «Проблемы» оно должно быть видно в любом случае.
 */
export function diagnosticsByFile(
  change: string,
  entries: readonly ValidationEntry[],
  exists: (path: string) => boolean,
): Map<string, FileDiagnostic[]> {
  const changeDir = `openspec/changes/${change}`;
  const fallback = exists(`${changeDir}/proposal.md`) ? `${changeDir}/proposal.md` : changeDir;
  const result = new Map<string, FileDiagnostic[]>();

  for (const entry of entries) {
    const file = entry.file === null ? fallback : entry.file.replaceAll('\\', '/');
    const line = entry.line === null ? 0 : Math.max(0, entry.line - 1);
    const list = result.get(file) ?? [];
    list.push({ line, level: LEVEL[entry.level], message: entry.message });
    result.set(file, list);
  }
  return result;
}

/**
 * Change, к которым относятся изменённые файлы.
 *
 * Пути — относительно корня рабочего пространства, как их сообщает
 * наблюдатель. Архив не проверяется: архивные changes неизменяемы.
 */
export function changesTouched(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const match = /^openspec\/changes\/([^/]+)\//.exec(path.replaceAll('\\', '/'));
    const name = match?.[1];
    if (name !== undefined && name !== 'archive') names.add(name);
  }
  return [...names].sort();
}
