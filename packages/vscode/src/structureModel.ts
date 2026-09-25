import type { StructureReport } from '@openspec-ide/server';

/** Диагностика структуры: файл относительно корня, строка с 0, текст. */
export interface StructureDiagnostic {
  readonly line: number;
  readonly message: string;
}

/**
 * Раскладывает итог проверки структуры по файлам для панели «Проблемы».
 *
 * Лишний файл получает замечание на самом себе — в панели он виден под своим
 * именем и открывается щелчком. Остальное — отсутствующее, не того типа, лишние
 * папки (на папку диагностику не повесить) и ошибки описания — ложится на
 * строку правила в описании структуры.
 */
export function structureDiagnostics(report: StructureReport): Map<string, StructureDiagnostic[]> {
  const byFile = new Map<string, StructureDiagnostic[]>();
  const add = (path: string, line: number | null, message: string): void => {
    const list = byFile.get(path) ?? [];
    list.push({ line: Math.max(0, (line ?? 1) - 1), message });
    byFile.set(path, list);
  };

  if (!report.configured) return byFile;
  for (const error of report.errors) add(report.path, error.line, `Описание структуры: ${error.message}`);
  for (const issue of report.issues) {
    if (issue.kind === 'unexpected' && issue.actual === 'file') {
      add(issue.path, null, `${issue.message} (правило — ${report.path}${issue.line === null ? '' : `:${issue.line}`})`);
    } else {
      add(report.path, issue.line, issue.message);
    }
  }
  return byFile;
}
