/**
 * Метрики пунктов плана: события, свёртка и сопоставление с файлом.
 *
 * Хранилище — журнал событий, в который только дописывают, и производный от
 * него снимок. Состав плана при этом всегда берётся из файла: метрики к нему
 * только присоединяются и никогда не решают, какие пункты существуют.
 */

import { splitAcceptance } from './acceptance.js';

/** Версия формата журнала, снимка и экспорта. */
export const METRICS_SCHEMA_VERSION = 1;

/** Исход запуска агента. */
export type RunOutcome = 'success' | 'failure' | 'aborted' | 'budget-time' | 'budget-tools';

interface EventBase {
  readonly at: string;
  readonly change: string;
}

/** Событие журнала метрик. */
export type MetricEvent =
  | (EventBase & {
      /** Первое наблюдение change: отметки, стоявшие до начала учёта. */
      readonly type: 'baseline';
      readonly items: readonly { readonly key: string; readonly text: string; readonly done: boolean }[];
    })
  | (EventBase & { readonly type: 'item-started'; readonly item: string; readonly text: string })
  | (EventBase & { readonly type: 'item-completed'; readonly item: string; readonly text: string })
  | (EventBase & { readonly type: 'item-reopened'; readonly item: string; readonly text: string })
  | (EventBase & { readonly type: 'item-reworded'; readonly item: string; readonly text: string })
  | (EventBase & {
      readonly type: 'item-renumbered';
      readonly from: string;
      readonly to: string;
      readonly text: string;
      readonly similarity: number;
    })
  | (EventBase & { readonly type: 'item-removed'; readonly item: string; readonly text: string })
  | (EventBase & {
      readonly type: 'run-finished';
      /** Пункт плана; `null` — запуск по артефакту, а не по задаче. */
      readonly item: string | null;
      readonly runId: string;
      readonly outcome: RunOutcome;
      readonly startedAt: string;
      readonly durationMs: number;
      /** `null` — агент не сообщил значение. Это не то же самое, что ноль. */
      readonly tokensIn: number | null;
      readonly tokensOut: number | null;
      readonly toolCalls: number | null;
      readonly files: readonly string[];
    })
  | (EventBase & {
      readonly type: 'acceptance-bound';
      readonly item: string;
      readonly command: string;
    })
  | (EventBase & {
      readonly type: 'acceptance-checked';
      readonly item: string;
      readonly command: string;
      readonly exitCode: number;
      readonly durationMs: number;
    });

/** Запуск агента в состоянии метрик. */
export interface RunRecord {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly toolCalls: number | null;
  readonly files: readonly string[];
}

/** Накопленное по одному пункту. */
export interface ItemRecord {
  key: string;
  text: string;
  done: boolean;
  /** Отметка стояла до начала учёта — время её постановки неизвестно. */
  doneBeforeTracking: boolean;
  firstStartedAt: string | null;
  completedAt: string | null;
  /** Интервалы работы; у текущего открытого `end === null`. */
  intervals: { start: string; end: string | null }[];
  reopenCount: number;
  runs: RunRecord[];
  acceptanceCommand: string | null;
  lastCheck: { command: string; exitCode: number; durationMs: number; at: string } | null;
  removed: boolean;
}

/** Накопленное по change. */
export interface ChangeRecord {
  items: Map<string, ItemRecord>;
  /** Запуски без привязки к пункту — учитываются только в сводке change. */
  unassignedRuns: RunRecord[];
}

/** Состояние метрик, свёрнутое из журнала. */
export interface MetricsState {
  changes: Map<string, ChangeRecord>;
}

export function emptyState(): MetricsState {
  return { changes: new Map() };
}

function changeRecord(state: MetricsState, change: string): ChangeRecord {
  let record = state.changes.get(change);
  if (record === undefined) {
    record = { items: new Map(), unassignedRuns: [] };
    state.changes.set(change, record);
  }
  return record;
}

function itemRecord(change: ChangeRecord, key: string, text: string): ItemRecord {
  let record = change.items.get(key);
  if (record === undefined) {
    record = {
      key,
      text,
      done: false,
      doneBeforeTracking: false,
      firstStartedAt: null,
      completedAt: null,
      intervals: [],
      reopenCount: 0,
      runs: [],
      acceptanceCommand: null,
      lastCheck: null,
      removed: false,
    };
    change.items.set(key, record);
  }
  return record;
}

/** Ключ, под которым хранится удалённый пункт. */
export function removedKey(key: string, at: string): string {
  return `-${key}@${at}`;
}

function openInterval(record: ItemRecord, at: string): void {
  if (record.firstStartedAt === null) record.firstStartedAt = at;
  const last = record.intervals.at(-1);
  if (last === undefined || last.end !== null) record.intervals.push({ start: at, end: null });
}

function closeInterval(record: ItemRecord, at: string): void {
  const last = record.intervals.at(-1);
  if (last !== undefined && last.end === null) last.end = at;
}

/** Применяет одно событие к состоянию. */
export function applyEvent(state: MetricsState, event: MetricEvent): void {
  const change = changeRecord(state, event.change);

  switch (event.type) {
    case 'baseline': {
      for (const item of event.items) {
        const record = itemRecord(change, item.key, item.text);
        record.done = item.done;
        record.doneBeforeTracking = item.done;
      }
      return;
    }
    case 'item-started': {
      const record = itemRecord(change, event.item, event.text);
      if (!record.done) openInterval(record, event.at);
      return;
    }
    case 'item-completed': {
      const record = itemRecord(change, event.item, event.text);
      // Отметка без взятия в работу: время работы неизвестно, но момент
      // завершения — известен, и цикл начинается с него же.
      if (record.firstStartedAt === null) record.firstStartedAt = event.at;
      closeInterval(record, event.at);
      record.done = true;
      record.doneBeforeTracking = false;
      record.completedAt = event.at;
      return;
    }
    case 'item-reopened': {
      const record = itemRecord(change, event.item, event.text);
      record.done = false;
      record.completedAt = null;
      record.reopenCount += 1;
      openInterval(record, event.at);
      return;
    }
    case 'item-reworded': {
      itemRecord(change, event.item, event.text).text = event.text;
      return;
    }
    case 'item-renumbered': {
      const moving = change.items.get(event.from);
      if (moving === undefined) return;
      change.items.delete(event.from);
      moving.key = event.to;
      moving.text = event.text;
      moving.removed = false;
      change.items.set(event.to, moving);
      return;
    }
    case 'item-removed': {
      const record = change.items.get(event.item);
      if (record === undefined) return;
      // Удалённый пункт уходит на отдельный ключ: его номер может тут же занять
      // перенумерованная задача, и без этого перенос затёр бы сохранённые
      // метрики удалённой.
      change.items.delete(event.item);
      record.key = removedKey(event.item, event.at);
      record.removed = true;
      change.items.set(record.key, record);
      return;
    }
    case 'run-finished': {
      const run: RunRecord = {
        runId: event.runId,
        outcome: event.outcome,
        startedAt: event.startedAt,
        finishedAt: event.at,
        durationMs: event.durationMs,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        toolCalls: event.toolCalls,
        files: event.files,
      };
      if (event.item === null) {
        change.unassignedRuns.push(run);
        return;
      }
      const record = change.items.get(event.item);
      if (record === undefined) {
        change.unassignedRuns.push(run);
        return;
      }
      if (!record.done) openInterval(record, event.startedAt);
      record.runs.push(run);
      return;
    }
    case 'acceptance-bound': {
      const record = change.items.get(event.item);
      if (record !== undefined) record.acceptanceCommand = event.command;
      return;
    }
    case 'acceptance-checked': {
      const record = change.items.get(event.item);
      if (record === undefined) return;
      record.acceptanceCommand = event.command;
      record.lastCheck = {
        command: event.command,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        at: event.at,
      };
      return;
    }
  }
}

/** Сворачивает журнал в состояние. */
export function foldEvents(events: readonly MetricEvent[]): MetricsState {
  const state = emptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}

/** Пункт плана, как он лежит в файле сейчас. */
export interface CurrentItem {
  /** Ключ пункта внутри change: `<группа>.<номер в группе>`. */
  readonly key: string;
  readonly text: string;
  readonly done: boolean;
}

/** Порог схожести формулировок для переноса метрик при перенумерации. */
export const RENUMBER_SIMILARITY_THRESHOLD = 0.6;

/**
 * Схожесть двух формулировок: доля общих слов (мера Жаккара).
 *
 * Слова короче трёх букв отбрасываются: предлоги и союзы делают почти любые
 * две фразы похожими.
 */
export function textSimilarity(left: string, right: string): number {
  const words = (value: string): Set<string> =>
    new Set(
      value
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 3),
    );
  const a = words(left);
  const b = words(right);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Сопоставляет пункты файла с накопленными метриками и возвращает события,
 * которые нужно дописать в журнал.
 *
 * Порядок сопоставления важен:
 *
 * 1. Точное совпадение формулировки — где бы пункт ни оказался. Так вставка
 *    новой задачи в начало группы не приписывает её метрики соседям.
 * 2. Похожая формулировка выше порога. Порог консервативный: ложный перенос
 *    хуже потери метрик, потому что молча приписывает задаче чужой расход.
 * 3. Тот же номер при сильно изменённой формулировке — переформулировка
 *    сохраняет метрики, как требует спецификация.
 *
 * Всё, что не сопоставилось, помечается удалённым, но не стирается.
 */
export function reconcile(
  state: MetricsState,
  change: string,
  current: readonly CurrentItem[],
  now: string,
): MetricEvent[] {
  const record = state.changes.get(change);

  // Первое наблюдение: отметки, стоявшие до начала учёта, фиксируются как
  // есть, без выдуманного времени завершения.
  if (record === undefined) {
    return [
      {
        type: 'baseline',
        at: now,
        change,
        items: current.map((item) => ({ key: item.key, text: item.text, done: item.done })),
      },
    ];
  }

  const events: MetricEvent[] = [];
  const known = [...record.items.values()];
  const currentByKey = new Map(current.map((item) => [item.key, item]));
  const claimed = new Set<string>();
  const mapping = new Map<string, string>(); // известный ключ → текущий ключ

  // 1. Точное совпадение формулировки — и среди удалённых тоже: вернувшаяся
  //    задача получает свои метрики обратно.
  for (const item of known) {
    const match = current.find(
      (candidate) =>
        !claimed.has(candidate.key) && normalize(candidate.text) === normalize(item.text),
    );
    if (match !== undefined) {
      mapping.set(item.key, match.key);
      claimed.add(match.key);
    }
  }

  // 2. Похожая формулировка выше порога — только для действующих пунктов.
  for (const item of known) {
    if (mapping.has(item.key) || item.removed) continue;
    let best: { key: string; score: number } | null = null;
    for (const candidate of current) {
      if (claimed.has(candidate.key)) continue;
      const score = textSimilarity(item.text, candidate.text);
      if (score >= RENUMBER_SIMILARITY_THRESHOLD && (best === null || score > best.score)) {
        best = { key: candidate.key, score };
      }
    }
    if (best !== null) {
      mapping.set(item.key, best.key);
      claimed.add(best.key);
    }
  }

  // 3. Тот же номер — переформулировка.
  for (const item of known) {
    if (mapping.has(item.key) || item.removed) continue;
    if (currentByKey.has(item.key) && !claimed.has(item.key)) {
      mapping.set(item.key, item.key);
      claimed.add(item.key);
    }
  }

  // Сначала удаления: удалённый пункт освобождает свой номер, который может
  // тут же понадобиться перенумерованной задаче.
  for (const item of known) {
    if (!mapping.has(item.key) && !item.removed) {
      events.push({ type: 'item-removed', at: now, change, item: item.key, text: item.text });
    }
  }

  // Переносы выполняются через временные ключи в два прохода: иначе перенос
  // 1.1→1.2 затёр бы ещё не перенесённый 1.2→1.3.
  const moves = [...mapping.entries()].filter(([from, to]) => from !== to);
  for (const [from, to] of moves) {
    const item = record.items.get(from);
    const target = currentByKey.get(to);
    if (item === undefined || target === undefined) continue;
    events.push({
      type: 'item-renumbered',
      at: now,
      change,
      from,
      to: `~${to}`,
      text: target.text,
      similarity: Number(textSimilarity(item.text, target.text).toFixed(3)),
    });
  }
  for (const [, to] of moves) {
    const target = currentByKey.get(to);
    if (target === undefined) continue;
    events.push({
      type: 'item-renumbered',
      at: now,
      change,
      from: `~${to}`,
      to,
      text: target.text,
      similarity: 1,
    });
  }

  // Переходы отметок и изменения формулировок — по итоговому сопоставлению.
  const byCurrentKey = new Map<string, ItemRecord>();
  for (const [from, to] of mapping) {
    const item = record.items.get(from);
    if (item !== undefined) byCurrentKey.set(to, item);
  }

  for (const item of current) {
    const previous = byCurrentKey.get(item.key);
    const wasDone = previous?.done ?? false;

    if (previous !== undefined && normalize(previous.text) !== normalize(item.text)) {
      events.push({ type: 'item-reworded', at: now, change, item: item.key, text: item.text });
    }
    if (item.done && !wasDone) {
      events.push({ type: 'item-completed', at: now, change, item: item.key, text: item.text });
    } else if (!item.done && wasDone) {
      events.push({ type: 'item-reopened', at: now, change, item: item.key, text: item.text });
    }
  }

  return events;
}

/** Состояние пункта для отображения. */
export type ItemState = 'not-started' | 'in-progress' | 'done' | 'removed';

/** Метрики одного пункта плана. */
export interface ItemMetrics {
  /** Полный идентификатор: `<change>/<группа>.<номер>`. */
  readonly id: string;
  readonly key: string;
  readonly text: string;
  readonly work: string;
  readonly state: ItemState;
  readonly firstStartedAt: string | null;
  readonly completedAt: string | null;
  /** Суммарное время в работе; `null`, если пункт в работу не брался. */
  readonly timeInWorkMs: number | null;
  /** От первого взятия в работу до завершения; `null`, пока не завершён. */
  readonly cycleTimeMs: number | null;
  readonly reopenCount: number;
  readonly runs: {
    readonly total: number;
    readonly success: number;
    readonly failed: number;
    readonly budgetExceeded: number;
    readonly aborted: number;
  };
  /** `null` — запуски были, но расход ни один не сообщил. */
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly tokens: number | null;
  readonly modelTimeMs: number;
  readonly toolCalls: number | null;
  readonly files: readonly string[];
  readonly acceptance: {
    readonly criterion: string | null;
    readonly command: string | null;
    readonly lastCheck: {
      readonly exitCode: number;
      readonly durationMs: number;
      readonly at: string;
    } | null;
    readonly passed: boolean | null;
  };
  /** Пункт отмечен выполненным, а последняя проверка приёмки красная. */
  readonly acceptanceMismatch: boolean;
  /** Отметка стояла до начала учёта — её время неизвестно. */
  readonly doneBeforeTracking: boolean;
}

function sumReported(values: readonly (number | null)[], runsCount: number): number | null {
  // Нет запусков — расход действительно ноль. Запуски были, но ни один не
  // сообщил значения — это «нет данных», и подменять его нулём нельзя.
  if (runsCount === 0) return 0;
  const reported = values.filter((value): value is number => value !== null);
  return reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0);
}

function msBetween(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

/** Считает метрики пункта на момент `now`. */
export function itemMetrics(change: string, record: ItemRecord, now: string): ItemMetrics {
  const runs = record.runs;
  const split = splitAcceptance(record.text);
  const tokensIn = sumReported(runs.map((run) => run.tokensIn), runs.length);
  const tokensOut = sumReported(runs.map((run) => run.tokensOut), runs.length);

  const timeInWorkMs =
    record.intervals.length === 0
      ? null
      : record.intervals.reduce(
          (sum, interval) => sum + msBetween(interval.start, interval.end ?? now),
          0,
        );

  const state: ItemState = record.removed
    ? 'removed'
    : record.done
      ? 'done'
      : record.firstStartedAt !== null || runs.length > 0
        ? 'in-progress'
        : 'not-started';

  const passed = record.lastCheck === null ? null : record.lastCheck.exitCode === 0;

  return {
    id: `${change}/${record.key}`,
    key: record.key,
    text: record.text,
    work: split.work,
    state,
    firstStartedAt: record.firstStartedAt,
    completedAt: record.completedAt,
    timeInWorkMs,
    cycleTimeMs:
      record.completedAt !== null && record.firstStartedAt !== null
        ? msBetween(record.firstStartedAt, record.completedAt)
        : null,
    reopenCount: record.reopenCount,
    runs: {
      total: runs.length,
      success: runs.filter((run) => run.outcome === 'success').length,
      failed: runs.filter((run) => run.outcome === 'failure').length,
      budgetExceeded: runs.filter(
        (run) => run.outcome === 'budget-time' || run.outcome === 'budget-tools',
      ).length,
      aborted: runs.filter((run) => run.outcome === 'aborted').length,
    },
    tokensIn,
    tokensOut,
    tokens: tokensIn === null && tokensOut === null ? null : (tokensIn ?? 0) + (tokensOut ?? 0),
    modelTimeMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    toolCalls: sumReported(runs.map((run) => run.toolCalls), runs.length),
    files: [...new Set(runs.flatMap((run) => run.files))].sort(),
    acceptance: {
      criterion: split.criterion,
      command: record.acceptanceCommand,
      lastCheck:
        record.lastCheck === null
          ? null
          : {
              exitCode: record.lastCheck.exitCode,
              durationMs: record.lastCheck.durationMs,
              at: record.lastCheck.at,
            },
      passed,
    },
    acceptanceMismatch: record.done && passed === false,
    doneBeforeTracking: record.doneBeforeTracking,
  };
}

/** Сводные метрики change. */
export interface ChangeSummary {
  readonly change: string;
  readonly schema: string | null;
  readonly total: number;
  readonly complete: number;
  /** Доля выполненных; `null`, если пунктов нет. */
  readonly doneShare: number | null;
  /** `null` — ни по одному пункту нет данных о расходе. */
  readonly tokensTotal: number | null;
  readonly tokensAverage: number | null;
  readonly tokensMedian: number | null;
  /** Число пунктов, на которых посчитаны показатели расхода. */
  readonly itemsWithTokenData: number;
  readonly agentTimeMs: number;
  readonly runs: number;
  readonly failedRuns: number;
  readonly withoutCriterion: number;
  readonly acceptanceMismatches: number;
  readonly lastModified: string | null;
  /** Удалённые пункты, метрики которых сохранены, но в сводку не входят. */
  readonly removed: number;
}

/** Сводит метрики пунктов change. */
export function summarize(
  change: string,
  items: readonly ItemMetrics[],
  unassignedRuns: readonly RunRecord[],
  context: { readonly schema: string | null; readonly lastModified: string | null },
): ChangeSummary {
  const active = items.filter((item) => item.state !== 'removed');
  const complete = active.filter((item) => item.state === 'done').length;

  const withData = active
    .map((item) => item.tokens)
    .filter((value): value is number => value !== null && value > 0);

  const unassignedTokens = unassignedRuns
    .map((run) =>
      run.tokensIn === null && run.tokensOut === null ? null : (run.tokensIn ?? 0) + (run.tokensOut ?? 0),
    )
    .filter((value): value is number => value !== null);

  const allTokens = [...withData, ...unassignedTokens];
  const sorted = [...withData].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return {
    change,
    schema: context.schema,
    total: active.length,
    complete,
    doneShare: active.length === 0 ? null : complete / active.length,
    tokensTotal: allTokens.length === 0 ? null : allTokens.reduce((sum, value) => sum + value, 0),
    tokensAverage:
      withData.length === 0 ? null : withData.reduce((sum, value) => sum + value, 0) / withData.length,
    tokensMedian:
      sorted.length === 0
        ? null
        : sorted.length % 2 === 1
          ? (sorted[middle] ?? null)
          : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2,
    itemsWithTokenData: withData.length,
    agentTimeMs:
      active.reduce((sum, item) => sum + item.modelTimeMs, 0) +
      unassignedRuns.reduce((sum, run) => sum + run.durationMs, 0),
    runs: active.reduce((sum, item) => sum + item.runs.total, 0) + unassignedRuns.length,
    failedRuns:
      active.reduce((sum, item) => sum + item.runs.failed, 0) +
      unassignedRuns.filter((run) => run.outcome === 'failure').length,
    withoutCriterion: active.filter((item) => item.acceptance.criterion === null).length,
    acceptanceMismatches: active.filter((item) => item.acceptanceMismatch).length,
    lastModified: context.lastModified,
    removed: items.length - active.length,
  };
}

/**
 * Сортирует пункты по расходу токенов, от большего к меньшему.
 *
 * Пункты без данных уходят в конец, а не встают между нулями: «нет данных»
 * не то же самое, что «ничего не потрачено».
 */
export function sortByTokens(items: readonly ItemMetrics[]): ItemMetrics[] {
  return [...items].sort((a, b) => {
    if (a.tokens === null && b.tokens === null) return 0;
    if (a.tokens === null) return 1;
    if (b.tokens === null) return -1;
    return b.tokens - a.tokens;
  });
}

/** Выгрузка метрик в машиночитаемом виде. */
export interface MetricsExport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly changes: readonly {
    readonly change: string;
    readonly archived: boolean;
    readonly summary: ChangeSummary;
    readonly items: readonly ItemMetrics[];
  }[];
}
