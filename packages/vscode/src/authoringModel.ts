import { isAbsolute, relative } from 'node:path';
import type { AuthoringIssue, AuthoringLensAction } from '@openspec-ide/core';
import type { FileDiagnostic } from './diagnosticsModel.js';

/** Внутренние команды подсказок над строками — в палитре их нет. */
export const LENS_COMMANDS = {
  openLocation: 'openspec.openLocation',
  addPlanItem: 'openspec.addPlanItem',
} as const;

/**
 * Путь файла относительно корня рабочего пространства, через `/`; `null`,
 * если файл вне корня.
 */
export function relativeToRoot(root: string | null, absolute: string): string | null {
  if (root === null) return null;
  const path = relative(root, absolute);
  if (path === '' || path.startsWith('..') || isAbsolute(path)) return null;
  return path.replaceAll('\\', '/');
}

/** Команда VS Code для подсказки над строкой; `null` — подсказка без действия. */
export function lensCommand(action: AuthoringLensAction): { command: string; arguments: unknown[] } | null {
  switch (action.kind) {
    case 'open':
      return { command: LENS_COMMANDS.openLocation, arguments: [action.location.path, action.location.line] };
    case 'add-plan-item':
      return { command: LENS_COMMANDS.addPlanItem, arguments: [action.change, action.capability, action.requirement] };
    case 'none':
      return null;
  }
}

/** Раскладывает замечания ссылок по файлам: строка — с нуля, как в VS Code. */
export function authoringDiagnostics(issues: readonly AuthoringIssue[]): Map<string, FileDiagnostic[]> {
  const result = new Map<string, FileDiagnostic[]>();
  for (const issue of issues) {
    const list = result.get(issue.path) ?? [];
    list.push({ line: Math.max(0, issue.line - 1), level: issue.level, message: issue.message });
    result.set(issue.path, list);
  }
  return result;
}
