/**
 * Пересечения активных changes, устаревшие дельты и забытые changes.
 *
 * Модуль чистый: историю (git, архив, даты) собирает бэкенд, а здесь по ней
 * решается, что пересекается, что устарело и что давно ждёт архивации.
 */
import { type AuthoringSources, scanDelta } from './authoring.js';
import type { DeltaOperation } from './specMarkdown.js';
import { type RequirementBlock, normalizeRequirementName, requirementBlocks } from './specChange.js';

/** Требование, которое затрагивает дельта change. */
export interface RequirementTouch {
  readonly change: string;
  readonly capability: string;
  /** Имя так, как его сравнивает архивация CLI. */
  readonly requirement: string;
  readonly operation: DeltaOperation;
  readonly path: string;
  readonly line: number;
}

/** Требование, которое затрагивают два и более change. */
export interface Overlap {
  readonly capability: string;
  readonly requirement: string;
  readonly touches: readonly RequirementTouch[];
}

/**
 * Затронутые требования: заголовки ADDED, MODIFIED и REMOVED и прежние имена
 * RENAMED (строка `FROM:`).
 */
export function requirementTouches(sources: AuthoringSources): RequirementTouch[] {
  const touches: RequirementTouch[] = [];
  for (const change of sources.changes) {
    for (const delta of change.deltas) {
      for (const mention of scanDelta(delta.text).mentions) {
        const counts =
          (mention.role === 'header' && mention.operation !== 'RENAMED') ||
          (mention.role === 'from' && mention.operation === 'RENAMED');
        if (!counts) continue;
        touches.push({
          change: change.name,
          capability: delta.capability,
          requirement: mention.name,
          operation: mention.operation,
          path: delta.path,
          line: mention.line,
        });
      }
    }
  }
  return touches;
}

/** Требования, которые затрагивают два и более разных change. */
export function findOverlaps(sources: AuthoringSources): Overlap[] {
  const groups = new Map<string, RequirementTouch[]>();
  for (const touch of requirementTouches(sources)) {
    const key = `${touch.capability}\u0000${touch.requirement}`;
    groups.set(key, [...(groups.get(key) ?? []), touch]);
  }
  return [...groups.values()]
    .filter((touches) => new Set(touches.map((touch) => touch.change)).size > 1)
    .map((touches) => ({
      capability: touches[0]?.capability ?? '',
      requirement: touches[0]?.requirement ?? '',
      touches,
    }))
    .sort((a, b) => a.capability.localeCompare(b.capability) || a.requirement.localeCompare(b.requirement));
}

/** Как изменилось требование основного спека между базовой версией и текущей. */
export interface RequirementDrift {
  /** Требования больше нет в основном спеке. */
  readonly removedFromMain: boolean;
  readonly textChanged: boolean;
  readonly addedScenarios: readonly string[];
  readonly removedScenarios: readonly string[];
  readonly changedScenarios: readonly string[];
  /** Текст требования тогда и сейчас — для сравнения. */
  readonly before: string;
  readonly after: string | null;
}

/**
 * Сравнивает требование в основном спеке на момент начала change с текущим.
 * `null` — не изменилось или сравнивать не с чем (в базовой версии требования
 * не было).
 */
export function compareBaseline(base: string | null, current: string | null, requirement: string): RequirementDrift | null {
  if (base === null) return null;
  const name = normalizeRequirementName(requirement);
  const before = requirementBlocks(base).find((block) => block.name === name);
  if (before === undefined) return null;
  const after = current === null ? undefined : requirementBlocks(current).find((block) => block.name === name);
  const blockText = (block: RequirementBlock): string => `### Requirement: ${block.name}\n${block.body}\n`;

  if (after === undefined) {
    return {
      removedFromMain: true,
      textChanged: true,
      addedScenarios: [],
      removedScenarios: before.scenarios.map((scenario) => scenario.name),
      changedScenarios: [],
      before: blockText(before),
      after: null,
    };
  }
  if (after.body === before.body) return null;

  const beforeScenarios = new Map(before.scenarios.map((scenario) => [scenario.name, scenario.body]));
  const afterScenarios = new Map(after.scenarios.map((scenario) => [scenario.name, scenario.body]));
  return {
    removedFromMain: false,
    textChanged: true,
    addedScenarios: [...afterScenarios.keys()].filter((key) => !beforeScenarios.has(key)),
    removedScenarios: [...beforeScenarios.keys()].filter((key) => !afterScenarios.has(key)),
    changedScenarios: [...afterScenarios.entries()]
      .filter(([key, body]) => beforeScenarios.has(key) && beforeScenarios.get(key) !== body)
      .map(([key]) => key),
    before: blockText(before),
    after: blockText(after),
  };
}

/** Требование, которое затронул архивный change. */
export interface ArchivedTouch {
  /** Каталог архива, например `2026-09-24-add-export`. */
  readonly archive: string;
  /** Дата архивации из имени каталога, `YYYY-MM-DD`; `null`, если её там нет. */
  readonly date: string | null;
  readonly capability: string;
  readonly requirement: string;
  readonly operation: DeltaOperation;
}

/** Требования, которые затрагивали архивные changes. */
export function archivedTouches(
  archives: readonly { readonly name: string; readonly deltas: readonly { readonly capability: string; readonly text: string }[] }[],
): ArchivedTouch[] {
  const sources: AuthoringSources = {
    mainSpecs: [],
    changes: archives.map((archive) => ({
      name: archive.name,
      deltas: archive.deltas.map((delta) => ({ ...delta, path: '' })),
      plan: null,
    })),
  };
  return requirementTouches(sources).map((touch) => ({
    archive: touch.change,
    date: /^(\d{4}-\d{2}-\d{2})-/.exec(touch.change)?.[1] ?? null,
    capability: touch.capability,
    requirement: touch.requirement,
    operation: touch.operation,
  }));
}

/** Архивные changes, менявшие требование в этот день или позже. */
export function archivedSince(
  touches: readonly ArchivedTouch[],
  capability: string,
  requirement: string,
  since: string | null,
): string[] {
  if (since === null) return [];
  const day = since.slice(0, 10);
  return [
    ...new Set(
      touches
        .filter((touch) => touch.capability === capability && touch.requirement === requirement)
        .filter((touch) => touch.date !== null && touch.date >= day)
        .map((touch) => touch.archive),
    ),
  ].sort();
}

/** Порог «change забыт», дней. */
export const FORGOTTEN_AFTER_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Сколько дней готовый к архивации change ждёт; `null` — не готов, активен
 * недавно или активность неизвестна.
 */
export function forgottenDays(
  readyToArchive: boolean,
  lastActivity: string | null,
  now: string,
  threshold = FORGOTTEN_AFTER_DAYS,
): number | null {
  if (!readyToArchive || lastActivity === null) return null;
  const since = Date.parse(lastActivity);
  const current = Date.parse(now);
  if (Number.isNaN(since) || Number.isNaN(current)) return null;
  const days = Math.floor((current - since) / DAY_MS);
  return days >= threshold ? days : null;
}

/** Порядок пакетной архивации: по дате создания, без даты — последними по имени. */
export function archiveOrder(changes: readonly { readonly name: string; readonly created: string | null }[]): string[] {
  return [...changes]
    .sort((a, b) => {
      if (a.created !== null && b.created !== null && a.created !== b.created) return a.created < b.created ? -1 : 1;
      if (a.created === null && b.created !== null) return 1;
      if (a.created !== null && b.created === null) return -1;
      return a.name.localeCompare(b.name);
    })
    .map((change) => change.name);
}

/** Базовая версия дельты в git: коммит, где файл дельты появился. */
export interface DeltaBaseline {
  readonly commit: string;
  /** Дата коммита, ISO. */
  readonly date: string;
  /** Основной спек capability в этом коммите; `null`, если его тогда не было. */
  readonly mainSpec: string | null;
}

/** Что известно о change помимо файлов. */
export interface DriftChangeInput {
  readonly name: string;
  readonly created: string | null;
  readonly lastActivity: string | null;
  readonly readyToArchive: boolean;
}

/** Всё, из чего собирается отчёт. */
export interface DriftInput {
  readonly sources: AuthoringSources;
  readonly git: boolean;
  /** Текущий момент, ISO. */
  readonly now: string;
  readonly changes: readonly DriftChangeInput[];
  /**
   * Базовые версии по пути файла дельты: `null` — дельта не закоммичена, нет
   * ключа — неизвестно (нет git).
   */
  readonly baselines: Readonly<Record<string, DeltaBaseline | null>>;
  readonly archived: readonly ArchivedTouch[];
}

/** Пересечение с точки зрения одного change. */
export interface ChangeOverlap {
  readonly capability: string;
  readonly requirement: string;
  readonly operation: DeltaOperation;
  readonly path: string;
  readonly line: number;
  readonly others: readonly { readonly change: string; readonly operation: DeltaOperation; readonly path: string; readonly line: number }[];
}

/** Устаревшее требование дельты. */
export interface StaleRequirement {
  readonly capability: string;
  readonly requirement: string;
  readonly operation: DeltaOperation;
  readonly path: string;
  readonly line: number;
  /** `stale` — сравнение по git, `possible` — по архиву без git. */
  readonly certainty: 'stale' | 'possible';
  /** Коммит базовой версии (сокращённый) и его дата либо дата создания change. */
  readonly baseline: string | null;
  readonly since: string | null;
  readonly removedFromMain: boolean;
  readonly addedScenarios: readonly string[];
  readonly removedScenarios: readonly string[];
  readonly changedScenarios: readonly string[];
  readonly archivedAfter: readonly string[];
  readonly before: string | null;
  readonly after: string | null;
}

/** Состояние одного change. */
export interface ChangeDrift {
  readonly created: string | null;
  readonly lastActivity: string | null;
  readonly forgottenDays: number | null;
  readonly overlaps: readonly ChangeOverlap[];
  readonly stale: readonly StaleRequirement[];
}

/** Отчёт по всем активным changes. */
export interface DriftReport {
  readonly git: boolean;
  readonly generatedAt: string;
  readonly overlaps: readonly Overlap[];
  readonly changes: Readonly<Record<string, ChangeDrift>>;
  /** Changes «Готово к архивации» в порядке пакетной архивации. */
  readonly archiveOrder: readonly string[];
}

/** Собирает отчёт. */
export function buildDriftReport(input: DriftInput): DriftReport {
  const overlaps = findOverlaps(input.sources);
  const touches = requirementTouches(input.sources);
  const mainByCapability = new Map(input.sources.mainSpecs.map((spec) => [spec.capability, spec.text]));
  const changes: Record<string, ChangeDrift> = {};

  for (const change of input.changes) {
    const own = overlaps.flatMap((overlap) =>
      overlap.touches
        .filter((touch) => touch.change === change.name)
        .map(
          (touch): ChangeOverlap => ({
            capability: touch.capability,
            requirement: touch.requirement,
            operation: touch.operation,
            path: touch.path,
            line: touch.line,
            others: overlap.touches
              .filter((other) => other.change !== change.name)
              .map((other) => ({ change: other.change, operation: other.operation, path: other.path, line: other.line })),
          }),
        ),
    );

    const stale: StaleRequirement[] = [];
    for (const touch of touches) {
      if (touch.change !== change.name || touch.operation === 'ADDED') continue;
      const common = {
        capability: touch.capability,
        requirement: touch.requirement,
        operation: touch.operation,
        path: touch.path,
        line: touch.line,
      };
      if (input.git) {
        const baseline = input.baselines[touch.path];
        if (baseline === undefined || baseline === null) continue;
        const drift = compareBaseline(baseline.mainSpec, mainByCapability.get(touch.capability) ?? null, touch.requirement);
        if (drift === null) continue;
        stale.push({
          ...common,
          certainty: 'stale',
          baseline: baseline.commit.slice(0, 7),
          since: baseline.date,
          removedFromMain: drift.removedFromMain,
          addedScenarios: drift.addedScenarios,
          removedScenarios: drift.removedScenarios,
          changedScenarios: drift.changedScenarios,
          archivedAfter: archivedSince(input.archived, touch.capability, touch.requirement, baseline.date),
          before: drift.before,
          after: drift.after,
        });
        continue;
      }
      const archivedAfter = archivedSince(input.archived, touch.capability, touch.requirement, change.created);
      if (archivedAfter.length === 0) continue;
      stale.push({
        ...common,
        certainty: 'possible',
        baseline: null,
        since: change.created,
        removedFromMain: false,
        addedScenarios: [],
        removedScenarios: [],
        changedScenarios: [],
        archivedAfter,
        before: null,
        after: null,
      });
    }

    changes[change.name] = {
      created: change.created,
      lastActivity: change.lastActivity,
      forgottenDays: forgottenDays(change.readyToArchive, change.lastActivity, input.now),
      overlaps: own,
      stale,
    };
  }

  return {
    git: input.git,
    generatedAt: input.now,
    overlaps,
    changes,
    archiveOrder: archiveOrder(input.changes.filter((change) => change.readyToArchive)),
  };
}

/** Замечание отчёта на строке файла дельты (строка с 1). */
export interface DriftFinding {
  readonly path: string;
  readonly line: number;
  readonly level: 'warning' | 'info';
  readonly message: string;
}

/**
 * Замечания отчёта по строкам дельт: пересечение и устаревание —
 * предупреждения, «возможно устарела» — сведение. Их показывают и панель
 * «Проблемы», и команда проверки для CI.
 */
export function driftFindings(report: DriftReport): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const drift of Object.values(report.changes)) {
    for (const overlap of drift.overlaps) {
      findings.push({
        path: overlap.path,
        line: overlap.line,
        level: 'warning',
        message:
          `Требование «${overlap.requirement}» (${overlap.capability}) меняет и ` +
          `${overlap.others.map((other) => `«${other.change}» (${other.operation})`).join(', ')}. ` +
          'Change, архивированный вторым, должен учесть правки первого',
      });
    }
    for (const stale of drift.stale) {
      findings.push({ path: stale.path, line: stale.line, level: stale.certainty === 'stale' ? 'warning' : 'info', message: staleMessage(stale) });
    }
  }
  return findings;
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
