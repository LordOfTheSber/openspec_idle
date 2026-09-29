/** Фазы доски: подписи служебных колонок и фаза change по дереву. */
import type { TreeChange } from '@openspec-ide/core';

export const COLUMN_TITLE: Record<string, string> = {
  ready: 'Готово к работе',
  'in-progress': 'В работе',
  'to-archive': 'Готово к архивации',
};

/** Подпись колонки доски. */
export function columnTitle(id: string): string {
  return COLUMN_TITLE[id] ?? id;
}

/**
 * Фаза change по дереву — то же правило, что у доски: первый несозданный
 * артефакт, иначе по прогрессу плана. Нужна переключателю change, которому
 * не стоит ради подписи строить всю доску.
 */
export function phaseOf(change: TreeChange): string {
  const missing = change.artifacts.find((artifact) => artifact.state === 'missing');
  if (missing !== undefined) return missing.id;
  const progress = change.progress;
  if (progress === null || progress.total === 0 || progress.complete === 0) return 'ready';
  return progress.complete < progress.total ? 'in-progress' : 'to-archive';
}
