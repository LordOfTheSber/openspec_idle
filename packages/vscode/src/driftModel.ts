import { type DriftReport, type StaleRequirement, driftFindings } from '@openspec-ide/core';
import type { FileDiagnostic } from './diagnosticsModel.js';

export { staleMessage } from '@openspec-ide/core';

/** Замечания отчёта о пересечениях и устаревании по файлам: строка — с нуля, как в VS Code. */
export function driftDiagnostics(report: DriftReport): Map<string, FileDiagnostic[]> {
  const result = new Map<string, FileDiagnostic[]>();
  for (const finding of driftFindings(report)) {
    result.set(finding.path, [
      ...(result.get(finding.path) ?? []),
      { line: Math.max(0, finding.line - 1), level: finding.level, message: finding.message },
    ]);
  }
  return result;
}

/** Устаревшее требование на строке файла дельты (строка с 1), у которого есть что сравнить. */
export function staleAt(report: DriftReport | null, path: string, line: number): { change: string; stale: StaleRequirement } | null {
  if (report === null) return null;
  for (const [change, drift] of Object.entries(report.changes)) {
    const stale = drift.stale.find((item) => item.path === path && item.line === line && item.before !== null);
    if (stale !== undefined) return { change, stale };
  }
  return null;
}
