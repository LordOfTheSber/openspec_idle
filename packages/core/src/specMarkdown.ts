/**
 * Разбор структуры спеков и дельт OpenSpec.
 *
 * Нужен там, где CLI не отдаёт позиций в файле: поиск с переходом к строке и
 * панель структуры документа. Содержимое требований берётся из CLI, а этот
 * разбор отвечает на вопрос «где это лежит в файле».
 */

/** Операция дельты над требованиями. */
export type DeltaOperation = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';

/** Сценарий требования. */
export interface ParsedScenario {
  readonly name: string;
  /** Номер строки заголовка сценария, начиная с 1. */
  readonly line: number;
  /** Строки шагов WHEN/THEN/AND. */
  readonly steps: readonly string[];
}

/** Требование спека или дельты. */
export interface ParsedRequirement {
  readonly name: string;
  readonly line: number;
  /** Операция дельты, под которой требование объявлено; `null` в основном спеке. */
  readonly operation: DeltaOperation | null;
  readonly scenarios: readonly ParsedScenario[];
  /** Текст описания требования между заголовком и первым сценарием. */
  readonly description: string;
  /** Причина удаления — обязательна для операции REMOVED. */
  readonly reason: string | null;
  /** Указание по миграции — обязательно для операции REMOVED. */
  readonly migration: string | null;
  /** Прежнее имя — обязательно для операции RENAMED. */
  readonly renamedFrom: string | null;
  /** Новое имя — обязательно для операции RENAMED. */
  readonly renamedTo: string | null;
}

/** Разобранный документ спека или дельты. */
export interface ParsedSpecDocument {
  readonly title: string | null;
  readonly purpose: string | null;
  readonly requirements: readonly ParsedRequirement[];
  /** Найденные структурные нарушения формата. */
  readonly problems: readonly SpecProblem[];
}

/** Структурное нарушение формата OpenSpec. */
export interface SpecProblem {
  readonly line: number;
  readonly kind: 'scenario-wrong-level' | 'requirement-without-scenario' | 'scenario-outside-requirement';
  readonly message: string;
}

const RE_TITLE = /^#\s+(.+?)\s*$/;
const RE_H2 = /^##\s+(.+?)\s*$/;
const RE_REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/;
const RE_SCENARIO = /^####\s+Scenario:\s*(.+?)\s*$/;
// Сценарий, записанный тремя решётками, — самая частая ошибка: OpenSpec такой
// блок молча не распознаёт, поэтому его нужно ловить отдельно.
const RE_SCENARIO_WRONG = /^###\s+Scenario:\s*(.+?)\s*$/;
const RE_STEP = /^\s*-\s+\*\*(WHEN|THEN|AND|IF|GIVEN)\*\*/i;
const RE_REASON = /^\*\*Reason\*\*:\s*(.*)$/i;
const RE_MIGRATION = /^\*\*Migration\*\*:\s*(.*)$/i;
// Прежнее и новое имя записываются как `FROM: \`### Requirement: Имя\``.
// Как у CLI: строка может начинаться маркером списка — `- FROM: …`.
const RE_RENAME_FROM = /^\s*[-*+]?\s*FROM:\s*`?(?:###\s*Requirement:\s*)?(.+?)`?\s*$/;
const RE_RENAME_TO = /^\s*[-*+]?\s*TO:\s*`?(?:###\s*Requirement:\s*)?(.+?)`?\s*$/;
const RE_DELTA_HEADER = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/;

/** Разбирает markdown спека или дельты. */
export function parseSpecMarkdown(text: string): ParsedSpecDocument {
  const lines = text.split('\n');

  let title: string | null = null;
  let purpose: string | null = null;
  let operation: DeltaOperation | null = null;
  let inPurpose = false;

  const requirements: ParsedRequirement[] = [];
  const problems: SpecProblem[] = [];
  const purposeLines: string[] = [];

  let currentRequirement: {
    name: string;
    line: number;
    operation: DeltaOperation | null;
    scenarios: ParsedScenario[];
    description: string[];
    reason: string | null;
    migration: string | null;
    renamedFrom: string | null;
    renamedTo: string | null;
  } | null = null;
  let currentScenario: { name: string; line: number; steps: string[] } | null = null;
  /** `FROM:` без заголовка требования ждёт своего `TO:` — формат шаблона OpenSpec. */
  let pendingFrom: { name: string; line: number } | null = null;

  const closeScenario = (): void => {
    if (currentScenario !== null && currentRequirement !== null) {
      currentRequirement.scenarios.push({
        name: currentScenario.name,
        line: currentScenario.line,
        steps: currentScenario.steps,
      });
    }
    currentScenario = null;
  };

  const closeRequirement = (): void => {
    closeScenario();
    if (currentRequirement === null) return;
    // Удалённое и переименованное требование сценариев не несёт — они
    // описывают поведение, которого больше нет или которое не менялось.
    const needsScenarios =
      currentRequirement.operation !== 'REMOVED' && currentRequirement.operation !== 'RENAMED';
    if (needsScenarios && currentRequirement.scenarios.length === 0) {
      problems.push({
        line: currentRequirement.line,
        kind: 'requirement-without-scenario',
        message: `Требование «${currentRequirement.name}» не содержит ни одного сценария`,
      });
    }
    requirements.push({
      name: currentRequirement.name,
      line: currentRequirement.line,
      operation: currentRequirement.operation,
      scenarios: currentRequirement.scenarios,
      description: currentRequirement.description.join('\n').trim(),
      reason: currentRequirement.reason,
      migration: currentRequirement.migration,
      renamedFrom: currentRequirement.renamedFrom,
      renamedTo: currentRequirement.renamedTo,
    });
    currentRequirement = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const lineNumber = index + 1;

    const titleMatch = RE_TITLE.exec(raw);
    if (titleMatch?.[1] !== undefined && title === null) {
      title = titleMatch[1];
      continue;
    }

    const deltaMatch = RE_DELTA_HEADER.exec(raw);
    if (deltaMatch?.[1] !== undefined) {
      closeRequirement();
      operation = deltaMatch[1] as DeltaOperation;
      inPurpose = false;
      continue;
    }

    const h2Match = RE_H2.exec(raw);
    if (h2Match?.[1] !== undefined) {
      closeRequirement();
      inPurpose = h2Match[1].trim().toLowerCase() === 'purpose';
      if (!inPurpose) operation = null;
      continue;
    }

    const requirementMatch = RE_REQUIREMENT.exec(raw);
    if (requirementMatch?.[1] !== undefined) {
      closeRequirement();
      inPurpose = false;
      currentRequirement = {
        name: requirementMatch[1],
        line: lineNumber,
        operation,
        scenarios: [],
        description: [],
        reason: null,
        migration: null,
        renamedFrom: null,
        renamedTo: null,
      };
      continue;
    }

    const scenarioMatch = RE_SCENARIO.exec(raw);
    if (scenarioMatch?.[1] !== undefined) {
      if (currentRequirement === null) {
        problems.push({
          line: lineNumber,
          kind: 'scenario-outside-requirement',
          message: `Сценарий «${scenarioMatch[1]}» объявлен вне требования`,
        });
        continue;
      }
      closeScenario();
      currentScenario = { name: scenarioMatch[1], line: lineNumber, steps: [] };
      continue;
    }

    const wrongScenario = RE_SCENARIO_WRONG.exec(raw);
    if (wrongScenario?.[1] !== undefined) {
      problems.push({
        line: lineNumber,
        kind: 'scenario-wrong-level',
        message:
          `Сценарий «${wrongScenario[1]}» записан тремя решётками. ` +
          'OpenSpec требует ровно четырёх, иначе блок молча не распознаётся',
      });
      continue;
    }

    if (operation === 'RENAMED') {
      const from = RE_RENAME_FROM.exec(raw);
      if (from?.[1] !== undefined && (currentRequirement === null || currentRequirement.renamedFrom !== null)) {
        closeRequirement();
        pendingFrom = { name: from[1].trim(), line: lineNumber };
        continue;
      }
      const to = RE_RENAME_TO.exec(raw);
      if (to?.[1] !== undefined && pendingFrom !== null) {
        requirements.push({
          name: to[1].trim(),
          line: pendingFrom.line,
          operation: 'RENAMED',
          scenarios: [],
          description: '',
          reason: null,
          migration: null,
          renamedFrom: pendingFrom.name,
          renamedTo: to[1].trim(),
        });
        pendingFrom = null;
        continue;
      }
    }

    if (currentRequirement !== null) {
      const reason = RE_REASON.exec(raw);
      if (reason?.[1] !== undefined) {
        currentRequirement.reason = reason[1].trim() === '' ? null : reason[1].trim();
        continue;
      }
      const migration = RE_MIGRATION.exec(raw);
      if (migration?.[1] !== undefined) {
        currentRequirement.migration = migration[1].trim() === '' ? null : migration[1].trim();
        continue;
      }
      const from = RE_RENAME_FROM.exec(raw);
      if (from?.[1] !== undefined) {
        currentRequirement.renamedFrom = from[1].trim();
        continue;
      }
      const to = RE_RENAME_TO.exec(raw);
      if (to?.[1] !== undefined) {
        currentRequirement.renamedTo = to[1].trim();
        continue;
      }
    }

    if (inPurpose) {
      purposeLines.push(raw);
      continue;
    }
    if (currentScenario !== null && RE_STEP.test(raw)) {
      currentScenario.steps.push(raw.trim());
      continue;
    }
    if (currentScenario === null && currentRequirement !== null && raw.trim() !== '') {
      currentRequirement.description.push(raw);
    }
  }

  closeRequirement();
  purpose = purposeLines.join('\n').trim() || null;

  return { title, purpose, requirements, problems };
}
