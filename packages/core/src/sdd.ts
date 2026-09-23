/**
 * Правила спек-ориентированности процесса.
 *
 * `openspec schema validate` отвечает на вопрос «корректна ли схема». Здесь —
 * другой вопрос: «остался ли процесс SDD». Правила опираются только на поля
 * схемы — `generates`, `requires`, `apply` — и никогда на имена артефактов:
 * артефакт может называться как угодно, лишь бы делал своё дело.
 */

import type { SchemaDocument } from './schemaDocument.js';

/** Уровень правила. */
export type RuleLevel = 'error' | 'warning';

/** Поле схемы, к которому относится нарушение, — для перехода в форму. */
export type SchemaField =
  | 'generates'
  | 'requires'
  | 'instruction'
  | 'apply.requires'
  | 'apply.tracks'
  | 'sdd_waivers';

/** Описание правила. */
export interface SddRule {
  readonly id: string;
  readonly level: RuleLevel;
  readonly title: string;
}

/** Правила, которые проверяются всегда. Набор общий для всех проектов. */
export const SDD_RULES: readonly SddRule[] = [
  { id: 'sdd/behaviour-contract', level: 'error', title: 'Есть артефакт-контракт поведения' },
  { id: 'sdd/code-after-contract', level: 'error', title: 'Работа по коду зависит от контракта' },
  { id: 'sdd/tracked-artifact', level: 'error', title: 'Отслеживаемый артефакт объявлен и существует' },
  { id: 'sdd/reachable', level: 'error', title: 'Все артефакты достижимы' },
  { id: 'sdd/motivation-first', level: 'warning', title: 'Спекам предшествует мотивация' },
  { id: 'sdd/artifact-instruction', level: 'warning', title: 'У каждого артефакта есть инструкция' },
];

/** Нарушение правила. */
export interface Violation {
  readonly rule: string;
  readonly level: RuleLevel;
  /** Артефакт, к которому относится нарушение; `null` — к схеме в целом. */
  readonly artifact: string | null;
  readonly field: SchemaField | null;
  readonly message: string;
  readonly fix: string;
}

/** Отчёт о соответствии. */
export interface ConformanceReport {
  /** Действующие нарушения, ошибки выше предупреждений. */
  readonly violations: readonly Violation[];
  /** Правила, от которых схема отказалась с причиной, и что они бы нашли. */
  readonly waived: readonly {
    readonly rule: SddRule;
    readonly reason: string;
    readonly violations: readonly Violation[];
  }[];
  /** Правила, проверку которых схема прошла. */
  readonly passed: readonly SddRule[];
  /** Правила, неприменимые к этой схеме, и почему. */
  readonly notApplicable: readonly { readonly rule: SddRule; readonly reason: string }[];
  readonly errors: number;
  readonly warnings: number;
  /** Схему можно назначать: нет действующих нарушений уровня «ошибка». */
  readonly assignable: boolean;
}

/** Артефакт порождает дельты спеков — контракт поведения. */
export function isContract(artifact: { readonly generates: string }): boolean {
  return /^specs\//.test(artifact.generates.trim());
}

/** Все зависимости артефакта — прямые и через цепочку, без повторов. */
export function transitiveDependencies(document: SchemaDocument, id: string): string[] {
  const byId = new Map(document.artifacts.map((artifact) => [artifact.id, artifact]));
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [...(byId.get(id)?.requires ?? [])];
  while (stack.length > 0) {
    const next = stack.shift();
    if (next === undefined || seen.has(next) || next === id) continue;
    seen.add(next);
    order.push(next);
    stack.push(...(byId.get(next)?.requires ?? []));
  }
  return order;
}

/**
 * Артефакты, которые процесс в принципе может довести до готовности: все
 * их зависимости существуют и сами достижимы. Цикл и ссылка на
 * несуществующий артефакт делают артефакт недостижимым.
 */
export function reachableArtifacts(document: SchemaDocument): Set<string> {
  const known = new Set(document.artifacts.map((artifact) => artifact.id));
  const ready = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of document.artifacts) {
      if (ready.has(artifact.id)) continue;
      if (artifact.requires.every((dependency) => known.has(dependency) && ready.has(dependency))) {
        ready.add(artifact.id);
        changed = true;
      }
    }
  }
  return ready;
}

const RULE_BY_ID = new Map(SDD_RULES.map((rule) => [rule.id, rule]));

function rule(id: string): SddRule {
  const found = RULE_BY_ID.get(id);
  if (found === undefined) throw new Error(`Неизвестное правило ${id}`);
  return found;
}

/** Проверяет схему по правилам SDD с учётом объявленных отказов. */
export function checkConformance(document: SchemaDocument): ConformanceReport {
  const found = new Map<string, Violation[]>(SDD_RULES.map((item) => [item.id, []]));
  const notApplicable: { rule: SddRule; reason: string }[] = [];
  const push = (violation: Violation): void => {
    found.get(violation.rule)?.push(violation);
  };

  const contracts = document.artifacts.filter(isContract);
  const byId = new Map(document.artifacts.map((artifact) => [artifact.id, artifact]));

  // Контракт поведения.
  if (contracts.length === 0) {
    push({
      rule: 'sdd/behaviour-contract',
      level: 'error',
      artifact: null,
      field: 'generates',
      message:
        'Ни один артефакт не порождает дельт спеков — в процессе нет контракта поведения, ' +
        'с которым можно сверить реализацию.',
      fix:
        'Добавьте артефакт с generates: specs/**/*.md — или объявите адресный отказ от ' +
        'правила с причиной.',
    });
  }

  // Работа по коду зависит от контракта.
  if (contracts.length === 0) {
    notApplicable.push({
      rule: rule('sdd/code-after-contract'),
      reason: 'в схеме нет контракта поведения, от которого могла бы зависеть работа',
    });
  } else if (document.apply.requires.length === 0) {
    push({
      rule: 'sdd/code-after-contract',
      level: 'error',
      artifact: null,
      field: 'apply.requires',
      message:
        'Начало работ не требует ни одного артефакта — код можно писать до того, как ' +
        'определено поведение.',
      fix: 'Перечислите в apply.requires артефакт, который зависит от контракта поведения.',
    });
  } else {
    for (const id of document.apply.requires) {
      const artifact = byId.get(id);
      if (artifact === undefined) continue; // несуществующий артефакт — забота структурной проверки
      if (isContract(artifact)) continue;
      const chain = transitiveDependencies(document, id);
      if (chain.some((dependency) => byId.get(dependency) !== undefined && isContract(byId.get(dependency)!))) {
        continue;
      }
      push({
        rule: 'sdd/code-after-contract',
        level: 'error',
        artifact: id,
        field: 'requires',
        message:
          `Работа начинается с артефакта «${id}», который не зависит от контракта поведения. ` +
          `Его цепочка зависимостей: ${chain.length === 0 ? 'пусто' : `${id} ← ${chain.join(' ← ')}`}.`,
        fix: `Добавьте в зависимости «${id}» артефакт-контракт или то, что от него зависит.`,
      });
    }
  }

  // Отслеживаемый артефакт.
  const tracks = document.apply.tracks;
  if (tracks === null) {
    push({
      rule: 'sdd/tracked-artifact',
      level: 'error',
      artifact: null,
      field: 'apply.tracks',
      message: 'Не объявлен отслеживаемый артефакт — прогресс работы по такому процессу не измерить.',
      fix: 'Укажите в apply.tracks файл артефакта с пунктами-чекбоксами, например tasks.md.',
    });
  } else if (!document.artifacts.some((artifact) => artifact.generates === tracks)) {
    push({
      rule: 'sdd/tracked-artifact',
      level: 'error',
      artifact: null,
      field: 'apply.tracks',
      message: `Отслеживаемым объявлен «${tracks}», но ни один артефакт схемы его не порождает.`,
      fix: 'Укажите путь, который порождает один из артефактов схемы.',
    });
  }

  // Достижимость.
  const reachable = reachableArtifacts(document);
  const known = new Set(document.artifacts.map((artifact) => artifact.id));
  for (const artifact of document.artifacts) {
    if (reachable.has(artifact.id)) continue;
    const missing = artifact.requires.filter((dependency) => !known.has(dependency));
    push({
      rule: 'sdd/reachable',
      level: 'error',
      artifact: artifact.id,
      field: 'requires',
      message:
        missing.length > 0
          ? `Артефакт «${artifact.id}» зависит от несуществующего: ${missing.join(', ')}.`
          : `Артефакт «${artifact.id}» недостижим: его зависимости не могут быть выполнены — ` +
            'вероятно, они образуют цикл.',
      fix: 'Уберите несуществующие и циклические зависимости.',
    });
  }

  // Мотивация перед спеками.
  for (const contract of contracts) {
    const chain = transitiveDependencies(document, contract.id);
    const motivated = chain.some((dependency) => {
      const artifact = byId.get(dependency);
      return artifact !== undefined && !isContract(artifact);
    });
    if (!motivated) {
      push({
        rule: 'sdd/motivation-first',
        level: 'warning',
        artifact: contract.id,
        field: 'requires',
        message:
          `Контракт «${contract.id}» ни от чего не зависит — спеки пишутся без объяснения, ` +
          'зачем нужно изменение.',
        fix: `Добавьте в зависимости «${contract.id}» артефакт с мотивацией, например proposal.`,
      });
    }
  }

  // Инструкции.
  for (const artifact of document.artifacts) {
    if (artifact.instruction !== null && artifact.instruction.trim() !== '') continue;
    push({
      rule: 'sdd/artifact-instruction',
      level: 'warning',
      artifact: artifact.id,
      field: 'instruction',
      message: `У артефакта «${artifact.id}» не заполнена инструкция — агент не сможет по нему работать.`,
      fix: 'Заполните инструкцию: она попадает в промпт агента.',
    });
  }

  // Отказы: применяется только адресный отказ с причиной.
  const notices: Violation[] = [];
  const waivedRules = new Map<string, string>();
  for (const waiver of document.waivers) {
    if (!RULE_BY_ID.has(waiver.rule)) {
      notices.push({
        rule: 'sdd/unknown-waiver',
        level: 'warning',
        artifact: null,
        field: 'sdd_waivers',
        message: `Отказ от неизвестного правила «${waiver.rule}» — такого правила нет.`,
        fix: `Проверьте идентификатор. Известные правила: ${SDD_RULES.map((item) => item.id).join(', ')}.`,
      });
      continue;
    }
    if (waiver.reason === null) {
      notices.push({
        rule: 'sdd/waiver-without-reason',
        level: 'warning',
        artifact: null,
        field: 'sdd_waivers',
        message: `Отказ от правила «${waiver.rule}» не применён: не указана причина.`,
        fix: 'Отказ от SDD должен быть решением, а не умолчанием — укажите причину.',
      });
      continue;
    }
    waivedRules.set(waiver.rule, waiver.reason);
  }

  const violations: Violation[] = [...notices];
  const waived: { rule: SddRule; reason: string; violations: Violation[] }[] = [];
  const passed: SddRule[] = [];
  const skipped = new Set(notApplicable.map((item) => item.rule.id));

  for (const item of SDD_RULES) {
    const list = found.get(item.id) ?? [];
    const reason = waivedRules.get(item.id);
    if (reason !== undefined) {
      waived.push({ rule: item, reason, violations: list });
    } else if (list.length > 0) {
      violations.push(...list);
    } else if (!skipped.has(item.id)) {
      passed.push(item);
    }
  }

  violations.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  const errors = violations.filter((violation) => violation.level === 'error').length;

  return {
    violations,
    waived,
    passed,
    notApplicable,
    errors,
    warnings: violations.length - errors,
    assignable: errors === 0,
  };
}
