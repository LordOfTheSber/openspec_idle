import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENSPEC_DIR,
  diffLines,
  parseSpecMarkdown,
  sameRequirement,
  type DeltaOperation,
  type DiffLine,
  type ParsedRequirement,
} from '@openspec-ide/core';

/** Требование дельты одного change по одной capability. */
export interface DeltaEntry {
  readonly change: string;
  /** Дата архивации из имени каталога `YYYY-MM-DD-<name>`; у активного — `null`. */
  readonly date: string | null;
  readonly capability: string;
  readonly operation: DeltaOperation;
  readonly name: string;
  readonly renamedFrom: string | null;
  readonly renamedTo: string | null;
  /** Текст требования: описание и сценарии; у REMOVED и RENAMED — пусто. */
  readonly text: string;
  readonly line: number;
  readonly file: string;
}

/** Запись истории требования: от новых к старым. */
export interface HistoryEntry {
  readonly change: string;
  readonly date: string | null;
  readonly operation: DeltaOperation;
  /** Имя требования в этом change. */
  readonly name: string;
  readonly renamedFrom: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly diff: readonly DiffLine[];
}

/** Читает дельты changes: архивных — для истории, активных — для признаков. */
export class DeltaArchive {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /** Дельты архивных changes, от старых к новым. */
  async archived(): Promise<DeltaEntry[]> {
    const base = join(this.#root, OPENSPEC_DIR, 'changes', 'archive');
    const names = (await listDirs(base)).sort();
    const entries: DeltaEntry[] = [];
    for (const name of names) {
      const date = /^(\d{4}-\d{2}-\d{2})-/.exec(name)?.[1] ?? null;
      const change = date === null ? name : name.slice(11);
      entries.push(...(await this.#readChange(join(base, name), change, date, `${OPENSPEC_DIR}/changes/archive/${name}`)));
    }
    return entries;
  }

  /** Дельты активного change. */
  active(change: string): Promise<DeltaEntry[]> {
    return this.#readChange(
      join(this.#root, OPENSPEC_DIR, 'changes', change),
      change,
      null,
      `${OPENSPEC_DIR}/changes/${change}`,
    );
  }

  async #readChange(dir: string, change: string, date: string | null, relative: string): Promise<DeltaEntry[]> {
    const entries: DeltaEntry[] = [];
    const walk = async (specsDir: string, capability: string[]): Promise<void> => {
      let items;
      try {
        items = await readdir(specsDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (item.isDirectory()) {
          await walk(join(specsDir, item.name), [...capability, item.name]);
        } else if (item.name === 'spec.md' && capability.length > 0) {
          const text = await readFile(join(specsDir, item.name), 'utf8');
          const cap = capability.join('/');
          const file = `${relative}/specs/${cap}/spec.md`;
          for (const requirement of parseSpecMarkdown(text).requirements) {
            if (requirement.operation === null) continue;
            entries.push({
              change,
              date,
              capability: cap,
              operation: requirement.operation,
              name: requirement.renamedTo ?? requirement.name,
              renamedFrom: requirement.renamedFrom,
              renamedTo: requirement.renamedTo,
              text: requirementText(requirement),
              line: requirement.line,
              file,
            });
          }
        }
      }
    };
    await walk(join(dir, 'specs'), []);
    return entries;
  }
}

/** Описание и сценарии требования одним текстом — для сравнения версий. */
export function requirementText(requirement: Pick<ParsedRequirement, 'description' | 'scenarios' | 'operation'>): string {
  if (requirement.operation === 'REMOVED' || requirement.operation === 'RENAMED') return '';
  const scenarios = requirement.scenarios.map((scenario) => [`#### Scenario: ${scenario.name}`, ...scenario.steps].join('\n'));
  return [requirement.description, ...scenarios].filter((part) => part.trim() !== '').join('\n\n');
}

/**
 * История требования по архиву: от новых changes к старым, через цепочку
 * переименований. `before` — текст по предыдущей записи.
 */
export function requirementHistory(archived: readonly DeltaEntry[], capability: string, name: string): HistoryEntry[] {
  const names = [name];
  const matched: DeltaEntry[] = [];
  for (const entry of [...archived].reverse()) {
    if (entry.capability !== capability) continue;
    if (entry.operation === 'RENAMED') {
      if (entry.renamedTo !== null && names.some((known) => sameRequirement(known, entry.renamedTo!))) {
        matched.push(entry);
        if (entry.renamedFrom !== null) names.push(entry.renamedFrom);
      }
      continue;
    }
    if (names.some((known) => sameRequirement(known, entry.name))) matched.push(entry);
  }
  // Текст «до» — ближайшая более старая запись с текстом.
  return matched.map((entry, index) => {
    const older = matched.slice(index + 1).find((candidate) => candidate.text !== '');
    const before = older?.text ?? null;
    const after = entry.text === '' ? null : entry.text;
    return {
      change: entry.change,
      date: entry.date,
      operation: entry.operation,
      name: entry.name,
      renamedFrom: entry.renamedFrom,
      before,
      after,
      diff: after === null ? [] : diffLines(before ?? '', after),
    };
  });
}

/**
 * Текущее имя требования по старому: переименования из архива применяются по
 * порядку. `null` — переименований не было.
 */
export function renamedTo(archived: readonly DeltaEntry[], capability: string | null, oldName: string): string | null {
  let current = oldName;
  let changed = false;
  for (const entry of archived) {
    if (entry.operation !== 'RENAMED' || entry.renamedFrom === null || entry.renamedTo === null) continue;
    if (capability !== null && entry.capability !== capability) continue;
    if (sameRequirement(entry.renamedFrom, current)) {
      current = entry.renamedTo;
      changed = true;
    }
  }
  return changed ? current : null;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
