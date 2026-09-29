/**
 * Трассировка change: какие сценарии дельт закрыты какими пунктами плана.
 *
 * Связь живёт в самом плане — строкой `↳ <capability> / <сценарий>` под
 * пунктом. Без явной ссылки связь предполагается по названию сценария или
 * требования в тексте пункта и помечается как предполагаемая: так трассировка
 * работает и на планах, написанных до появления ссылок.
 */
import type { DeltaView } from './delta.js';
import type { DeltaOperation } from './specMarkdown.js';
import { parseTrackedDocument } from './trackedItems.js';

/** Сценарий дельты, который должен быть закрыт работой. */
export interface TraceScenario {
  /** `<capability>/<требование>/<сценарий>` — ключ связи. */
  readonly key: string;
  readonly capability: string;
  readonly requirement: string;
  readonly operation: DeltaOperation;
  readonly name: string;
  readonly line: number;
  readonly steps: readonly string[];
}

/** Ссылка пункта плана на сценарий или требование. */
export interface TraceReference {
  /** Номер строки ссылки в плане. */
  readonly line: number;
  readonly capability: string;
  readonly target: string;
  /** Ссылка нашла сценарий или требование в дельтах change. */
  readonly resolved: boolean;
}

/** Пункт плана с его ссылками. */
export interface TracePlanItem {
  /** Ключ пункта в метриках: `<группа>.<номер в группе>`. */
  readonly key: string;
  readonly line: number;
  readonly declaredNumber: string | null;
  readonly group: number;
  readonly text: string;
  readonly done: boolean;
  readonly references: readonly TraceReference[];
}

/** Связь сценария с пунктом плана. */
export interface TraceLink {
  readonly scenario: string;
  /** Строка пункта плана. */
  readonly item: number;
  readonly kind: 'explicit' | 'inferred';
}

/** Трассировка change целиком. */
export interface Trace {
  readonly scenarios: readonly TraceScenario[];
  readonly items: readonly TracePlanItem[];
  readonly links: readonly TraceLink[];
  /** Ключи сценариев, связанных хотя бы с одним пунктом. */
  readonly covered: readonly string[];
}

/** Операции, сценарии которых должны быть закрыты работой. */
const COVERED_OPERATIONS: ReadonlySet<DeltaOperation> = new Set(['ADDED', 'MODIFIED']);

/** Короче этого названия по тексту пункта не сопоставляются: слишком много ложных совпадений. */
export const MIN_INFERRED_NAME = 12;

const RE_REFERENCE = /^\s*(?:↳|->)\s*(.+?)\s*$/;
const RE_GROUP = /^##\s+\d+\./;
const RE_ITEM = /^\s*[-*]\s*\[[^\]]*\]/;

/** Название для сравнения: без регистра, кавычек и лишних пробелов. */
export function normalizeTraceName(value: string): string {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[«»"'`“”„]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ключ сценария. */
export function scenarioKey(capability: string, requirement: string, scenario: string): string {
  return `${capability}/${requirement}/${scenario}`;
}

/** Делит правую часть ссылки на capability и название. */
export function splitReference(value: string): { capability: string; target: string } | null {
  // Путь capability может содержать `/`, поэтому основной разделитель — с пробелами.
  const spaced = value.indexOf(' / ');
  if (spaced > 0) {
    return { capability: value.slice(0, spaced).trim(), target: value.slice(spaced + 3).trim() };
  }
  const slash = value.indexOf('/');
  if (slash > 0) return { capability: value.slice(0, slash).trim(), target: value.slice(slash + 1).trim() };
  return null;
}

/** Строки ссылок под каждым пунктом плана: строка пункта → ссылки. */
export function planReferences(text: string): Map<number, { line: number; capability: string; target: string }[]> {
  const result = new Map<number, { line: number; capability: string; target: string }[]>();
  let current: number | null = null;
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    if (RE_GROUP.test(raw)) {
      current = null;
      return;
    }
    if (RE_ITEM.test(raw)) {
      current = line;
      return;
    }
    const match = RE_REFERENCE.exec(raw);
    if (match?.[1] === undefined || current === null) return;
    const parts = splitReference(match[1]);
    if (parts === null || parts.capability === '' || parts.target === '') return;
    const list = result.get(current) ?? [];
    list.push({ line, ...parts });
    result.set(current, list);
  });
  return result;
}

/** Собирает сценарии дельт, которые должны быть закрыты работой. */
export function traceScenarios(views: readonly DeltaView[]): TraceScenario[] {
  const scenarios: TraceScenario[] = [];
  for (const view of views) {
    for (const group of view.groups) {
      if (!COVERED_OPERATIONS.has(group.operation)) continue;
      for (const requirement of group.requirements) {
        for (const scenario of requirement.scenarios) {
          scenarios.push({
            key: scenarioKey(view.capability, requirement.name, scenario.name),
            capability: view.capability,
            requirement: requirement.name,
            operation: group.operation,
            name: scenario.name,
            line: scenario.line,
            steps: scenario.steps,
          });
        }
      }
    }
  }
  return scenarios;
}

/** Строит трассировку по дельтам change и тексту его отслеживаемого артефакта. */
export function buildTrace(views: readonly DeltaView[], planText: string | null): Trace {
  const scenarios = traceScenarios(views);
  if (planText === null) return { scenarios, items: [], links: [], covered: [] };

  const document = parseTrackedDocument(planText);
  const references = planReferences(planText);
  const links: TraceLink[] = [];
  const seen = new Set<string>();
  const link = (scenario: string, item: number, kind: TraceLink['kind']): void => {
    const id = `${scenario}\u0000${item}`;
    if (seen.has(id)) return;
    seen.add(id);
    links.push({ scenario, item, kind });
  };

  const items: TracePlanItem[] = document.items.map((item) => {
    const own = references.get(item.line) ?? [];
    const resolvedRefs: TraceReference[] = own.map((reference) => {
      const target = normalizeTraceName(reference.target);
      const matched = scenarios.filter(
        (scenario) =>
          scenario.capability === reference.capability &&
          (normalizeTraceName(scenario.name) === target || normalizeTraceName(scenario.requirement) === target),
      );
      for (const scenario of matched) link(scenario.key, item.line, 'explicit');
      return { ...reference, resolved: matched.length > 0 };
    });

    if (own.length === 0) {
      const text = normalizeTraceName(item.text);
      for (const scenario of scenarios) {
        const name = normalizeTraceName(scenario.name);
        const requirement = normalizeTraceName(scenario.requirement);
        if (
          (name.length >= MIN_INFERRED_NAME && text.includes(name)) ||
          (requirement.length >= MIN_INFERRED_NAME && text.includes(requirement))
        ) {
          link(scenario.key, item.line, 'inferred');
        }
      }
    }

    return {
      key: `${item.group}.${item.index}`,
      line: item.line,
      declaredNumber: item.declaredNumber,
      group: item.group,
      text: item.text,
      done: item.done,
      references: resolvedRefs,
    };
  });

  const covered = scenarios.filter((scenario) => links.some((entry) => entry.scenario === scenario.key));
  return { scenarios, items, links, covered: covered.map((scenario) => scenario.key) };
}

/** Итог дописывания пункта в план. */
export interface AppendedPlanItem {
  readonly text: string;
  /** Строка нового пункта, начиная с 1. */
  readonly line: number;
  /** Номер нового пункта; `null`, если в плане нет групп. */
  readonly number: string | null;
}

/**
 * Дописывает пункт со ссылкой на сценарий в конец последней группы плана.
 *
 * Остальные байты файла не меняются: план правят и человек, и агент, а
 * перезапись из модели дала бы шумный дифф.
 */
export function appendPlanItem(
  planText: string,
  entry: { readonly capability: string; readonly target: string; readonly title: string },
): AppendedPlanItem {
  const document = parseTrackedDocument(planText);
  const lines = planText.split('\n');
  const endsWithNewline = planText.endsWith('\n');
  if (endsWithNewline) lines.pop();

  const reference = `  ↳ ${entry.capability} / ${entry.target}`;
  const lastGroup = document.groups[document.groups.length - 1];

  if (lastGroup === undefined) {
    const block = [`- [ ] ${entry.title}`, reference];
    const insertAt = lines.length;
    lines.push(...block);
    return { text: lines.join('\n') + (endsWithNewline ? '\n' : ''), line: insertAt + 1, number: null };
  }

  const inGroup = document.items.filter((item) => item.group === lastGroup.number);
  const number = `${lastGroup.number}.${inGroup.length + 1}`;

  let insertAfter: number;
  const lastItem = inGroup[inGroup.length - 1];
  if (lastItem !== undefined) {
    // После последнего пункта группы идут его строки продолжения и ссылки —
    // новый пункт встаёт за ними, а не между пунктом и его ссылкой.
    insertAfter = lastItem.line;
    while (insertAfter < lines.length) {
      const next = lines[insertAfter] ?? '';
      if (next.trim() === '' || RE_ITEM.test(next) || RE_GROUP.test(next) || !/^\s/.test(next)) break;
      insertAfter += 1;
    }
  } else if ((lines[lastGroup.line] ?? '').trim() === '' && lastGroup.line < lines.length) {
    // Пустая группа: пункт идёт после пустой строки за заголовком.
    insertAfter = lastGroup.line + 1;
  } else {
    lines.splice(lastGroup.line, 0, '');
    insertAfter = lastGroup.line + 1;
  }

  lines.splice(insertAfter, 0, `- [ ] ${number} ${entry.title}`, reference);
  return {
    text: lines.join('\n') + (endsWithNewline ? '\n' : ''),
    line: insertAfter + 1,
    number,
  };
}
