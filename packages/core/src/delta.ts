import {
  type DeltaOperation,
  type ParsedRequirement,
  type ParsedScenario,
  parseSpecMarkdown,
} from './specMarkdown.js';

/** Требование дельты вместе с найденными в нём изъянами. */
export interface DeltaRequirement {
  readonly name: string;
  readonly line: number;
  readonly operation: DeltaOperation;
  readonly description: string;
  readonly scenarios: readonly ParsedScenario[];
  readonly reason: string | null;
  readonly migration: string | null;
  readonly renamedFrom: string | null;
  readonly renamedTo: string | null;
  /** Чего требованию не хватает по правилам его операции. */
  readonly missingFields: readonly string[];
}

/** Группа требований одной операции. */
export interface DeltaGroup {
  readonly operation: DeltaOperation;
  readonly requirements: readonly DeltaRequirement[];
  readonly scenarioCount: number;
}

/** Разобранная дельта одной capability. */
export interface DeltaView {
  readonly capability: string;
  readonly purpose: string | null;
  readonly groups: readonly DeltaGroup[];
  readonly requirementCount: number;
  readonly scenarioCount: number;
}

const OPERATION_ORDER: readonly DeltaOperation[] = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'];

/**
 * Собирает дельту capability из markdown.
 *
 * Названия требований берутся из разбора, а не из CLI: `show --deltas-only`
 * отдаёт текст описания и сценарии, но заголовков требований в нём нет, а без
 * них группу не показать.
 */
export function buildDeltaView(capability: string, text: string): DeltaView {
  const parsed = parseSpecMarkdown(text);

  const byOperation = new Map<DeltaOperation, DeltaRequirement[]>();
  for (const requirement of parsed.requirements) {
    if (requirement.operation === null) continue;
    const list = byOperation.get(requirement.operation) ?? [];
    list.push(toDeltaRequirement(requirement, requirement.operation));
    byOperation.set(requirement.operation, list);
  }

  const groups: DeltaGroup[] = [];
  for (const operation of OPERATION_ORDER) {
    const requirements = byOperation.get(operation);
    if (requirements === undefined) continue;
    groups.push({
      operation,
      requirements,
      scenarioCount: requirements.reduce((sum, item) => sum + item.scenarios.length, 0),
    });
  }

  return {
    capability,
    purpose: parsed.purpose,
    groups,
    requirementCount: groups.reduce((sum, group) => sum + group.requirements.length, 0),
    scenarioCount: groups.reduce((sum, group) => sum + group.scenarioCount, 0),
  };
}

function toDeltaRequirement(
  requirement: ParsedRequirement,
  operation: DeltaOperation,
): DeltaRequirement {
  const missing: string[] = [];

  // Удалённое требование без причины и указания по миграции оставляет
  // читателя без ответа на вопрос «что вместо него».
  if (operation === 'REMOVED') {
    if (requirement.reason === null) missing.push('Reason');
    if (requirement.migration === null) missing.push('Migration');
  }
  if (operation === 'RENAMED') {
    if (requirement.renamedFrom === null) missing.push('FROM');
    if (requirement.renamedTo === null) missing.push('TO');
  }

  return {
    name: requirement.name,
    line: requirement.line,
    operation,
    description: requirement.description,
    scenarios: requirement.scenarios,
    reason: requirement.reason,
    migration: requirement.migration,
    renamedFrom: requirement.renamedFrom,
    renamedTo: requirement.renamedTo,
    missingFields: missing,
  };
}

/** Строка сравнения требования дельты с его версией в основном спеке. */
export interface DiffLine {
  readonly kind: 'context' | 'added' | 'removed';
  readonly text: string;
}

/** Результат сравнения изменённого требования с основным спеком. */
export interface RequirementComparison {
  readonly name: string;
  /** Требование не найдено в основном спеке. */
  readonly missingInMainSpec: boolean;
  /** Похожие заголовки основного спека — подсказка при несовпадении. */
  readonly similarNames: readonly string[];
  readonly description: readonly DiffLine[];
  readonly addedScenarios: readonly string[];
  readonly removedScenarios: readonly string[];
  readonly keptScenarios: readonly string[];
}

/**
 * Сравнивает требование дельты с одноимённым требованием основного спека.
 *
 * OpenSpec требует, чтобы MODIFIED содержал требование целиком: при копировании
 * легко потерять часть сценариев, и именно это здесь становится видно.
 */
export function compareRequirement(
  deltaRequirement: DeltaRequirement,
  mainSpecText: string,
): RequirementComparison {
  const main = parseSpecMarkdown(mainSpecText);
  const match = main.requirements.find((item) => sameHeader(item.name, deltaRequirement.name));

  if (match === undefined) {
    return {
      name: deltaRequirement.name,
      missingInMainSpec: true,
      similarNames: similarTo(deltaRequirement.name, main.requirements.map((item) => item.name)),
      description: deltaRequirement.description
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((text) => ({ kind: 'added' as const, text })),
      addedScenarios: deltaRequirement.scenarios.map((scenario) => scenario.name),
      removedScenarios: [],
      keptScenarios: [],
    };
  }

  const deltaNames = new Set(deltaRequirement.scenarios.map((scenario) => scenario.name));
  const mainNames = new Set(match.scenarios.map((scenario) => scenario.name));

  return {
    name: deltaRequirement.name,
    missingInMainSpec: false,
    similarNames: [],
    description: diffLines(match.description, deltaRequirement.description),
    addedScenarios: [...deltaNames].filter((name) => !mainNames.has(name)),
    removedScenarios: [...mainNames].filter((name) => !deltaNames.has(name)),
    keptScenarios: [...deltaNames].filter((name) => mainNames.has(name)),
  };
}

/** Сравнивает заголовки без учёта пробелов и регистра, как это делает OpenSpec. */
export function sameHeader(left: string, right: string): boolean {
  return normalizeHeader(left) === normalizeHeader(right);
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Подбирает похожие заголовки по числу общих слов.
 *
 * Нужно ровно для одной подсказки: «такого требования нет, не это ли имелось в
 * виду» — поэтому расстояние редактирования здесь избыточно.
 */
function similarTo(name: string, candidates: readonly string[]): string[] {
  const words = new Set(normalizeHeader(name).split(' ').filter((word) => word.length > 2));
  if (words.size === 0) return [];

  return candidates
    .map((candidate) => {
      const other = normalizeHeader(candidate).split(' ');
      const shared = other.filter((word) => words.has(word)).length;
      return { candidate, shared };
    })
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

/** Построчное сравнение двух текстов. */
function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = before.split('\n').filter((line) => line.trim() !== '');
  const afterLines = after.split('\n').filter((line) => line.trim() !== '');
  const afterSet = new Set(afterLines);
  const beforeSet = new Set(beforeLines);

  const lines: DiffLine[] = [];
  for (const line of beforeLines) {
    lines.push({ kind: afterSet.has(line) ? 'context' : 'removed', text: line });
  }
  for (const line of afterLines) {
    if (!beforeSet.has(line)) lines.push({ kind: 'added', text: line });
  }
  return lines;
}
