/**
 * Изменения основного спека по требованиям: что добавится, изменится,
 * переименуется и пропадёт.
 *
 * Строится по двум текстам спека — до и после архивации, — а не по дельте:
 * дельта говорит о намерении, а предпросмотр обязан показать результат.
 * Требования делятся на блоки так же, как их делит CLI при архивации: от
 * заголовка `### Requirement:` до следующего такого заголовка или раздела
 * `## `, без учёта строк внутри блоков кода.
 */

import { type TextDiff, diffText } from './textDiff.js';

/** Требование в блочном разборе спека. */
export interface RequirementBlock {
  readonly name: string;
  /** Номер строки заголовка, начиная с 1. */
  readonly line: number;
  /** Текст блока без строки заголовка, без хвостовых пустых строк. */
  readonly body: string;
  readonly scenarios: readonly { readonly name: string; readonly body: string }[];
}

/** Состояние требования после архивации. */
export type RequirementChangeKind = 'added' | 'modified' | 'renamed' | 'unchanged';

/** Требование спека после архивации и то, что с ним произошло. */
export interface RequirementChange {
  readonly name: string;
  readonly kind: RequirementChangeKind;
  /** Номер строки заголовка в спеке после архивации. */
  readonly line: number;
  /** Прежнее имя переименованного требования. */
  readonly renamedFrom: string | null;
  /** У переименованного требования поменялся и текст. */
  readonly textChanged: boolean;
  readonly addedScenarios: readonly string[];
  readonly removedScenarios: readonly string[];
  /** Сценарии с тем же именем, но другим текстом. */
  readonly changedScenarios: readonly string[];
}

/** Удаляемое требование. */
export interface RemovedRequirement {
  readonly name: string;
  /** Номер строки заголовка в текущем спеке. */
  readonly line: number;
}

/** Изменения одного спека. */
export interface SpecChange {
  readonly status: 'created' | 'updated' | 'unchanged';
  /** Требования спека после архивации в порядке файла. */
  readonly requirements: readonly RequirementChange[];
  readonly removed: readonly RemovedRequirement[];
  readonly counts: {
    readonly added: number;
    readonly modified: number;
    readonly renamed: number;
    readonly removed: number;
  };
  readonly diff: TextDiff;
}

/** Пара переименования из секции RENAMED дельты. */
export interface RenamePair {
  readonly from: string;
  readonly to: string;
}

const REQUIREMENT_HEADER = /^###\s*Requirement:\s*(.+?)\s*$/i;
const SECTION_HEADER = /^##\s+/;
const SCENARIO_HEADER = /^####\s+(.+?)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Имя требования так, как его сравнивает CLI: без закрывающей серии `#`
 * заголовка и пробелов по краям, с учётом регистра.
 */
export function normalizeRequirementName(name: string): string {
  return name.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

function normalizeScenarioName(header: string): string {
  return header
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/^Scenario:\s*/i, '')
    .trim();
}

/** Отмечает строки, лежащие внутри блоков кода, включая сами ограждения. */
function fenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (open === null) {
      if (match?.[1] !== undefined) {
        open = match[1];
        mask.push(true);
      } else {
        mask.push(false);
      }
    } else {
      mask.push(true);
      if (match?.[1] !== undefined && match[1][0] === open[0] && match[1].length >= open.length) {
        open = null;
      }
    }
  }
  return mask;
}

/** Делит спек на блоки требований. */
export function requirementBlocks(text: string): RequirementBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  const blocks: RequirementBlock[] = [];

  let index = 0;
  while (index < lines.length) {
    const header = mask[index] === true ? null : REQUIREMENT_HEADER.exec(lines[index] ?? '');
    if (header?.[1] === undefined) {
      index += 1;
      continue;
    }

    const line = index + 1;
    const body: string[] = [];
    index += 1;
    while (index < lines.length) {
      const current = lines[index] ?? '';
      const masked = mask[index] === true;
      if (!masked && (REQUIREMENT_HEADER.test(current) || SECTION_HEADER.test(current))) break;
      body.push(current);
      index += 1;
    }

    blocks.push({
      name: normalizeRequirementName(header[1]),
      line,
      body: trimEndLines(body).join('\n'),
      scenarios: scenarioBlocks(body, mask.slice(line, line + body.length)),
    });
  }
  return blocks;
}

function scenarioBlocks(
  lines: readonly string[],
  mask: readonly boolean[],
): { name: string; body: string }[] {
  const scenarios: { name: string; body: string }[] = [];
  let current: { name: string; lines: string[] } | null = null;
  lines.forEach((line, index) => {
    const header = mask[index] === true ? null : SCENARIO_HEADER.exec(line);
    if (header?.[1] !== undefined) {
      if (current !== null) scenarios.push({ name: current.name, body: trimEndLines(current.lines).join('\n') });
      current = { name: normalizeScenarioName(header[1]), lines: [] };
      return;
    }
    current?.lines.push(line);
  });
  if (current !== null) {
    const last: { name: string; lines: string[] } = current;
    scenarios.push({ name: last.name, body: trimEndLines(last.lines).join('\n') });
  }
  return scenarios;
}

function trimEndLines(lines: readonly string[]): string[] {
  const result = lines.map((line) => line.trimEnd());
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  while (result.length > 0 && result[0] === '') result.shift();
  return result;
}

/**
 * Пары переименований из дельты — в тех же записях, что понимает CLI:
 * `FROM: \`### Requirement: A\`` и следующая за ней `TO: …`, с маркером
 * списка или без него.
 */
export function renamePairs(deltaText: string): RenamePair[] {
  const lines = deltaText.replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  const pairs: RenamePair[] = [];
  let inRenamed = false;
  let pending: string | null = null;

  lines.forEach((line, index) => {
    if (mask[index] === true) return;
    const section = /^##\s+(.+?)\s*$/.exec(line);
    if (section?.[1] !== undefined) {
      inRenamed = section[1].toLowerCase() === 'renamed requirements';
      pending = null;
      return;
    }
    if (!inRenamed) return;
    const from = /^\s*[-*+]?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/.exec(line);
    if (from?.[1] !== undefined) {
      pending = normalizeRequirementName(from[1]);
      return;
    }
    const to = /^\s*[-*+]?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/.exec(line);
    if (to?.[1] !== undefined && pending !== null) {
      pairs.push({ from: pending, to: normalizeRequirementName(to[1]) });
      pending = null;
    }
  });
  return pairs;
}

/**
 * Сравнивает спек до и после архивации.
 *
 * `before` — `null` у capability, которой ещё нет. Переименования берутся из
 * дельт: по двум текстам переименование не отличить от пары «удалено +
 * добавлено».
 */
export function describeSpecChange(
  before: string | null,
  after: string,
  renames: readonly RenamePair[] = [],
): SpecChange {
  const oldBlocks = before === null ? [] : requirementBlocks(before);
  const newBlocks = requirementBlocks(after);
  const oldByName = new Map(oldBlocks.map((block) => [block.name, block]));
  const newNames = new Set(newBlocks.map((block) => block.name));
  const renamedTo = new Map(renames.map((pair) => [pair.to, pair.from]));
  const consumed = new Set<string>();

  const requirements: RequirementChange[] = newBlocks.map((block) => {
    const same = oldByName.get(block.name);
    if (same !== undefined) {
      consumed.add(block.name);
      const scenarios = compareScenarios(same, block);
      return {
        name: block.name,
        kind: same.body === block.body ? 'unchanged' : 'modified',
        line: block.line,
        renamedFrom: null,
        textChanged: same.body !== block.body,
        ...scenarios,
      };
    }

    const from = renamedTo.get(block.name);
    const previous = from === undefined || newNames.has(from) ? undefined : oldByName.get(from);
    if (from !== undefined && previous !== undefined) {
      consumed.add(from);
      return {
        name: block.name,
        kind: 'renamed',
        line: block.line,
        renamedFrom: from,
        textChanged: previous.body !== block.body,
        ...compareScenarios(previous, block),
      };
    }

    return {
      name: block.name,
      kind: 'added',
      line: block.line,
      renamedFrom: null,
      textChanged: true,
      addedScenarios: block.scenarios.map((scenario) => scenario.name),
      removedScenarios: [],
      changedScenarios: [],
    };
  });

  const removed = oldBlocks
    .filter((block) => !consumed.has(block.name))
    .map((block) => ({ name: block.name, line: block.line }));

  const diff = diffText(before ?? '', after);
  const count = (kind: RequirementChangeKind): number =>
    requirements.filter((requirement) => requirement.kind === kind).length;

  return {
    status: before === null ? 'created' : diff.added + diff.removed === 0 ? 'unchanged' : 'updated',
    requirements,
    removed,
    counts: {
      added: count('added'),
      modified: count('modified'),
      renamed: count('renamed'),
      removed: removed.length,
    },
    diff,
  };
}

/**
 * Сценарии, появившиеся, пропавшие и изменившиеся у требования. Одноимённые
 * сценарии сопоставляются по порядку — как их считает CLI.
 */
function compareScenarios(
  before: RequirementBlock,
  after: RequirementBlock,
): Pick<RequirementChange, 'addedScenarios' | 'removedScenarios' | 'changedScenarios'> {
  const remaining = new Map<string, string[]>();
  for (const scenario of before.scenarios) {
    remaining.set(scenario.name, [...(remaining.get(scenario.name) ?? []), scenario.body]);
  }

  const addedScenarios: string[] = [];
  const changedScenarios: string[] = [];
  for (const scenario of after.scenarios) {
    const bodies = remaining.get(scenario.name);
    const previous = bodies?.shift();
    if (previous === undefined) {
      addedScenarios.push(scenario.name);
    } else if (previous !== scenario.body) {
      changedScenarios.push(scenario.name);
    }
  }

  const removedScenarios = [...remaining.entries()].flatMap(([name, bodies]) => bodies.map(() => name));
  return { addedScenarios, removedScenarios, changedScenarios };
}
