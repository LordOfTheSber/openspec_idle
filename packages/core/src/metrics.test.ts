import { describe, expect, it } from 'vitest';
import {
  type CurrentItem,
  type MetricEvent,
  type MetricsState,
  applyEvent,
  emptyState,
  foldEvents,
  itemMetrics,
  reconcile,
  sortByTokens,
  summarize,
  textSimilarity,
} from './metrics.js';

const CHANGE = 'add-export';

/** Прогоняет сопоставление и сразу применяет его события к состоянию. */
function observe(state: MetricsState, items: CurrentItem[], now: string): MetricEvent[] {
  const events = reconcile(state, CHANGE, items, now);
  for (const event of events) applyEvent(state, event);
  return events;
}

function item(key: string, text: string, done = false): CurrentItem {
  return { key, text, done };
}

function metricsOf(state: MetricsState, key: string, now = '2026-03-01T12:00:00.000Z') {
  const record = state.changes.get(CHANGE)?.items.get(key);
  if (record === undefined) throw new Error(`нет записи ${key}`);
  return itemMetrics(CHANGE, record, now);
}

function run(
  itemKey: string | null,
  at: string,
  overrides: Partial<Extract<MetricEvent, { type: 'run-finished' }>> = {},
): MetricEvent {
  return {
    type: 'run-finished',
    at,
    change: CHANGE,
    item: itemKey,
    runId: `run-${at}`,
    outcome: 'success',
    startedAt: at,
    durationMs: 60_000,
    tokensIn: 1000,
    tokensOut: 500,
    toolCalls: 7,
    files: ['src/a.ts'],
    ...overrides,
  };
}

const PLAN = [
  item('1.1', 'Реализовать сборку CSV и проверить тестом на кавычки', true),
  item('1.2', 'Добавить эндпоинт выгрузки и проверить тестом на код ответа'),
  item('2.1', 'Прогнать сквозной сценарий и убедиться, что файл открывается'),
];

describe('первое наблюдение change', () => {
  it('фиксирует отметки, стоявшие до начала учёта, без выдуманного времени', () => {
    const state = emptyState();
    const events = observe(state, PLAN, '2026-03-01T10:00:00.000Z');

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('baseline');

    const done = metricsOf(state, '1.1');
    expect(done.state).toBe('done');
    expect(done.completedAt).toBeNull();
    expect(done.doneBeforeTracking).toBe(true);
  });

  it('незапускавшаяся задача — «не начата», числовые метрики нулевые, отметок времени нет', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    const metrics = metricsOf(state, '1.2');

    expect(metrics.state).toBe('not-started');
    expect(metrics.runs.total).toBe(0);
    expect(metrics.tokens).toBe(0);
    expect(metrics.modelTimeMs).toBe(0);
    expect(metrics.firstStartedAt).toBeNull();
    expect(metrics.completedAt).toBeNull();
    expect(metrics.timeInWorkMs).toBeNull();
  });
});

describe('жизненный цикл пункта', () => {
  it('завершение фиксирует момент и время цикла от первого взятия в работу', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, {
      type: 'item-started',
      at: '2026-03-01T10:00:00.000Z',
      change: CHANGE,
      item: '1.2',
      text: PLAN[1]?.text ?? '',
    });

    observe(
      state,
      [PLAN[0]!, item('1.2', PLAN[1]!.text, true), PLAN[2]!],
      '2026-03-01T11:30:00.000Z',
    );
    const metrics = metricsOf(state, '1.2', '2026-03-01T15:00:00.000Z');

    expect(metrics.state).toBe('done');
    expect(metrics.completedAt).toBe('2026-03-01T11:30:00.000Z');
    expect(metrics.cycleTimeMs).toBe(90 * 60_000);
    // После завершения время в работе перестаёт расти.
    expect(metrics.timeInWorkMs).toBe(90 * 60_000);
  });

  it('возврат в работу сбрасывает момент завершения и сохраняет расход', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z'));
    observe(
      state,
      [PLAN[0]!, item('1.2', PLAN[1]!.text, true), PLAN[2]!],
      '2026-03-01T11:00:00.000Z',
    );

    observe(state, PLAN, '2026-03-01T12:00:00.000Z');
    const metrics = metricsOf(state, '1.2');

    expect(metrics.state).toBe('in-progress');
    expect(metrics.completedAt).toBeNull();
    expect(metrics.reopenCount).toBe(1);
    expect(metrics.runs.total).toBe(1);
    expect(metrics.tokens).toBe(1500);
  });

  it('запуск агента берёт пункт в работу и копит расход', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z'));
    applyEvent(
      state,
      run('1.2', '2026-03-01T10:30:00.000Z', { outcome: 'budget-time', files: ['src/b.ts'] }),
    );
    const metrics = metricsOf(state, '1.2');

    expect(metrics.state).toBe('in-progress');
    expect(metrics.firstStartedAt).toBe('2026-03-01T10:05:00.000Z');
    expect(metrics.runs).toMatchObject({ total: 2, success: 1, budgetExceeded: 1 });
    expect(metrics.tokens).toBe(3000);
    expect(metrics.toolCalls).toBe(14);
    expect(metrics.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('запуск, не сообщивший расход, даёт «нет данных», а не ноль', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(
      state,
      run('1.2', '2026-03-01T10:05:00.000Z', { tokensIn: null, tokensOut: null, toolCalls: null }),
    );
    const metrics = metricsOf(state, '1.2');

    expect(metrics.runs.total).toBe(1);
    expect(metrics.tokens).toBeNull();
    expect(metrics.toolCalls).toBeNull();
  });
});

describe('устойчивость идентификатора', () => {
  it('переформулировка на том же номере сохраняет метрики', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z'));

    observe(
      state,
      [PLAN[0]!, item('1.2', 'Сделать совершенно другое по сути и сдать заказчику'), PLAN[2]!],
      '2026-03-01T11:00:00.000Z',
    );
    const metrics = metricsOf(state, '1.2');

    expect(metrics.runs.total).toBe(1);
    expect(metrics.text).toBe('Сделать совершенно другое по сути и сдать заказчику');
  });

  it('вставка задачи в начало группы переносит метрики вслед за формулировками', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z'));

    const events = observe(
      state,
      [
        item('1.1', 'Новая задача, вставленная первой, и проверить её'),
        item('1.2', PLAN[0]!.text, true),
        item('1.3', PLAN[1]!.text),
        PLAN[2]!,
      ],
      '2026-03-01T11:00:00.000Z',
    );

    // Расход пункта «эндпоинт» уехал вместе с ним на 1.3, а не остался на 1.2.
    expect(metricsOf(state, '1.3').runs.total).toBe(1);
    expect(metricsOf(state, '1.2').runs.total).toBe(0);
    expect(metricsOf(state, '1.2').text).toBe(PLAN[0]!.text);
    expect(events.some((event) => event.type === 'item-renumbered')).toBe(true);
  });

  it('перенумерация с лёгкой правкой текста переносит метрики и пишет перенос в журнал', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z'));

    const events = observe(
      state,
      [
        PLAN[0]!,
        PLAN[2] === undefined ? item('1.2', '') : item('1.2', PLAN[2].text),
        item('2.1', 'Добавить эндпоинт выгрузки и проверить тестом на код ответа сервера'),
      ],
      '2026-03-01T11:00:00.000Z',
    );

    expect(metricsOf(state, '2.1').runs.total).toBe(1);
    const renumbered = events.filter((event) => event.type === 'item-renumbered');
    expect(renumbered.length).toBeGreaterThan(0);
  });

  it('удалённая задача сохраняет метрики, помечается удалённой и не входит в сводку', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z'));

    const events = observe(state, [PLAN[0]!, PLAN[2]!], '2026-03-01T11:00:00.000Z');
    expect(events.some((event) => event.type === 'item-removed')).toBe(true);

    const record = [...(state.changes.get(CHANGE)?.items.values() ?? [])].find((entry) =>
      entry.text.includes('эндпоинт'),
    );
    expect(record?.removed).toBe(true);
    expect(record?.runs).toHaveLength(1);

    const items = [...(state.changes.get(CHANGE)?.items.values() ?? [])].map((entry) =>
      itemMetrics(CHANGE, entry, '2026-03-01T12:00:00.000Z'),
    );
    const summary = summarize(CHANGE, items, [], { schema: 'spec-driven', lastModified: null });
    expect(summary.total).toBe(2);
    expect(summary.removed).toBe(1);
    expect(summary.tokensTotal).toBeNull();
  });

  it('удаление и занятие номера другой задачей не теряют метрик удалённой', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z'));
    applyEvent(state, run('2.1', '2026-03-01T10:10:00.000Z', { tokensIn: 5000 }));

    // 1.2 удалена, а 2.1 переехала на её номер.
    observe(state, [PLAN[0]!, item('1.2', PLAN[2]!.text)], '2026-03-01T11:00:00.000Z');

    const all = [...(state.changes.get(CHANGE)?.items.values() ?? [])];
    const removed = all.find((entry) => entry.removed);
    expect(removed?.text).toContain('эндпоинт');
    expect(removed?.runs).toHaveLength(1);
    expect(metricsOf(state, '1.2').text).toBe(PLAN[2]!.text);
    expect(metricsOf(state, '1.2').tokensIn).toBe(5000);
  });

  it('вернувшаяся задача получает свои метрики обратно', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z'));
    observe(state, [PLAN[0]!, PLAN[2]!], '2026-03-01T11:00:00.000Z');

    observe(state, PLAN, '2026-03-01T12:00:00.000Z');

    const metrics = metricsOf(state, '1.2');
    expect(metrics.state).not.toBe('removed');
    expect(metrics.runs.total).toBe(1);
  });

  it('схожесть формулировок считается по общим словам', () => {
    expect(textSimilarity('Добавить эндпоинт выгрузки', 'Добавить эндпоинт выгрузки')).toBe(1);
    expect(textSimilarity('Добавить эндпоинт выгрузки', 'Совсем другое дело')).toBe(0);
    expect(
      textSimilarity('Добавить эндпоинт выгрузки', 'Добавить эндпоинт выгрузки данных'),
    ).toBeGreaterThan(0.6);
  });
});

describe('приёмка', () => {
  it('критерий извлекается из формулировки', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');

    expect(metricsOf(state, '1.2').acceptance.criterion).toBe('проверить тестом на код ответа');
    expect(metricsOf(state, '1.2').work).toBe('Добавить эндпоинт выгрузки');
  });

  it('пункт без критерия приёмки помечается и попадает в сводку', () => {
    const state = emptyState();
    observe(state, [item('1.1', 'Панель проверок по выводу validate')], '2026-03-01T10:00:00.000Z');
    const metrics = metricsOf(state, '1.1');
    const summary = summarize(CHANGE, [metrics], [], { schema: null, lastModified: null });

    expect(metrics.acceptance.criterion).toBeNull();
    expect(summary.withoutCriterion).toBe(1);
  });

  it('ненулевой код проверки — приёмка не пройдена', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, {
      type: 'acceptance-checked',
      at: '2026-03-01T10:10:00.000Z',
      change: CHANGE,
      item: '1.2',
      command: 'npm test',
      exitCode: 1,
      durationMs: 4200,
    });

    expect(metricsOf(state, '1.2').acceptance.passed).toBe(false);
    expect(metricsOf(state, '1.2').acceptance.lastCheck?.durationMs).toBe(4200);
  });

  it('отметка выполнения при красной приёмке выполняется, но помечается расхождением', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, {
      type: 'acceptance-checked',
      at: '2026-03-01T10:10:00.000Z',
      change: CHANGE,
      item: '1.2',
      command: 'npm test',
      exitCode: 1,
      durationMs: 100,
    });
    observe(
      state,
      [PLAN[0]!, item('1.2', PLAN[1]!.text, true), PLAN[2]!],
      '2026-03-01T11:00:00.000Z',
    );

    const metrics = metricsOf(state, '1.2');
    expect(metrics.state).toBe('done');
    expect(metrics.acceptanceMismatch).toBe(true);
  });
});

describe('сводка и сортировка', () => {
  function stateWithRuns(): MetricsState {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run('1.2', '2026-03-01T10:05:00.000Z', { tokensIn: 3000, tokensOut: 1000 }));
    applyEvent(state, run('2.1', '2026-03-01T10:10:00.000Z', { tokensIn: 500, tokensOut: 500 }));
    return state;
  }

  it('считает долю выполненных, расход и число пунктов с данными', () => {
    const state = stateWithRuns();
    const items = [...(state.changes.get(CHANGE)?.items.values() ?? [])].map((entry) =>
      itemMetrics(CHANGE, entry, '2026-03-01T12:00:00.000Z'),
    );
    const summary = summarize(CHANGE, items, [], {
      schema: 'spec-driven',
      lastModified: '2026-03-01T11:00:00.000Z',
    });

    expect(summary.doneShare).toBeCloseTo(1 / 3);
    expect(summary.tokensTotal).toBe(5000);
    expect(summary.tokensAverage).toBe(2500);
    expect(summary.itemsWithTokenData).toBe(2);
    expect(summary.schema).toBe('spec-driven');
  });

  it('без данных о расходе показатели расхода — null, а доля выполненных считается', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    const items = [...(state.changes.get(CHANGE)?.items.values() ?? [])].map((entry) =>
      itemMetrics(CHANGE, entry, '2026-03-01T12:00:00.000Z'),
    );
    const summary = summarize(CHANGE, items, [], { schema: null, lastModified: null });

    expect(summary.tokensTotal).toBeNull();
    expect(summary.tokensAverage).toBeNull();
    expect(summary.doneShare).toBeCloseTo(1 / 3);
  });

  it('запуск без привязки к пункту учитывается в сводке change, но не в пунктах', () => {
    const state = emptyState();
    observe(state, PLAN, '2026-03-01T10:00:00.000Z');
    applyEvent(state, run(null, '2026-03-01T10:05:00.000Z'));
    const record = state.changes.get(CHANGE);
    const items = [...(record?.items.values() ?? [])].map((entry) =>
      itemMetrics(CHANGE, entry, '2026-03-01T12:00:00.000Z'),
    );
    const summary = summarize(CHANGE, items, record?.unassignedRuns ?? [], {
      schema: null,
      lastModified: null,
    });

    expect(items.every((entry) => entry.runs.total === 0)).toBe(true);
    expect(summary.runs).toBe(1);
    expect(summary.tokensTotal).toBe(1500);
  });

  it('сортировка по расходу ставит пункты без данных в конец', () => {
    const state = stateWithRuns();
    applyEvent(
      state,
      run('1.1', '2026-03-01T10:20:00.000Z', { tokensIn: null, tokensOut: null }),
    );
    const items = [...(state.changes.get(CHANGE)?.items.values() ?? [])].map((entry) =>
      itemMetrics(CHANGE, entry, '2026-03-01T12:00:00.000Z'),
    );

    const sorted = sortByTokens(items);
    expect(sorted.map((entry) => entry.key)).toEqual(['1.2', '2.1', '1.1']);
    expect(sorted.at(-1)?.tokens).toBeNull();
  });
});

describe('свёртка журнала', () => {
  it('повторная свёртка тех же событий даёт то же состояние', () => {
    const events: MetricEvent[] = [];
    const state = emptyState();
    events.push(...observe(state, PLAN, '2026-03-01T10:00:00.000Z'));
    const runEvent = run('1.2', '2026-03-01T10:05:00.000Z');
    applyEvent(state, runEvent);
    events.push(runEvent);
    events.push(
      ...observe(
        state,
        [item('1.1', 'Вставка', false), item('1.2', PLAN[0]!.text, true), item('1.3', PLAN[1]!.text), PLAN[2]!],
        '2026-03-01T11:00:00.000Z',
      ),
    );

    const rebuilt = foldEvents(events);
    const original = state.changes.get(CHANGE);
    const again = rebuilt.changes.get(CHANGE);

    expect([...(again?.items.keys() ?? [])].sort()).toEqual([...(original?.items.keys() ?? [])].sort());
    expect(again?.items.get('1.3')?.runs).toHaveLength(1);
  });
});
