import type { ContextMap } from '@openspec-ide/core';

/** Диагностика карты контекста: строка с 0, текст, важность. */
export interface ContextDiagnostic {
  readonly line: number;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

/**
 * Раскладывает замечания карты контекста по файлам для панели «Проблемы».
 * Замечание ложится на строку поля в `index.md` модуля или в ADR, а без строки —
 * на начало файла. На папку диагностику не повесить, поэтому замечание о
 * модуле без `index.md` в панель не попадает — оно видно в разделе «Контекст».
 */
export function contextDiagnostics(map: ContextMap): Map<string, ContextDiagnostic[]> {
  const byFile = new Map<string, ContextDiagnostic[]>();
  for (const issue of map.issues) {
    if (issue.kind === 'missing-index') continue;
    const list = byFile.get(issue.path) ?? [];
    list.push({ line: Math.max(0, (issue.line ?? 1) - 1), message: issue.message, severity: issue.severity });
    byFile.set(issue.path, list);
  }
  return byFile;
}
