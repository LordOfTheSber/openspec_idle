import type { DriftReport, StaleRequirement } from '@openspec-ide/core';
import type { FileDiagnostic } from './diagnosticsModel.js';

/**
 * Замечания отчёта о пересечениях и устаревании по файлам дельт: строка — с
 * нуля, как в VS Code. Пересечение и устаревание — предупреждения,
 * «возможно устарела» — сведение.
 */
export function driftDiagnostics(report: DriftReport): Map<string, FileDiagnostic[]> {
  const result = new Map<string, FileDiagnostic[]>();
  const add = (path: string, item: FileDiagnostic): void => {
    result.set(path, [...(result.get(path) ?? []), item]);
  };
  for (const drift of Object.values(report.changes)) {
    for (const overlap of drift.overlaps) {
      add(overlap.path, {
        line: Math.max(0, overlap.line - 1),
        level: 'warning',
        message:
          `Требование «${overlap.requirement}» (${overlap.capability}) меняет и ` +
          `${overlap.others.map((other) => `«${other.change}» (${other.operation})`).join(', ')}. ` +
          'Change, архивированный вторым, должен учесть правки первого',
      });
    }
    for (const stale of drift.stale) add(stale.path, { line: Math.max(0, stale.line - 1), level: stale.certainty === 'stale' ? 'warning' : 'info', message: staleMessage(stale) });
  }
  return result;
}

/** Текст замечания об устаревшем требовании. */
export function staleMessage(stale: StaleRequirement): string {
  const head =
    stale.certainty === 'possible'
      ? `Дельта «${stale.requirement}», возможно, устарела: после создания change архивированы changes, менявшие это требование`
      : stale.removedFromMain
        ? `Требования «${stale.requirement}» больше нет в основном спеке — его убрали после того, как дельта была написана`
        : `Основной спек изменил «${stale.requirement}» после того, как дельта была написана (${stale.baseline ?? '?'}) — при архивации эти правки будут перезаписаны`;
  const parts = [
    stale.changedScenarios.length > 0 ? `изменены сценарии: ${stale.changedScenarios.join(', ')}` : null,
    stale.addedScenarios.length > 0 ? `добавлены: ${stale.addedScenarios.join(', ')}` : null,
    stale.removedScenarios.length > 0 && !stale.removedFromMain ? `убраны: ${stale.removedScenarios.join(', ')}` : null,
    stale.archivedAfter.length > 0 ? `архивированы: ${stale.archivedAfter.join(', ')}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? head : `${head}. ${parts.join('; ')}`;
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
