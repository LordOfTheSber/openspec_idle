import { killTree, spawnShell } from './process/platform.js';
import {
  METRICS_SCHEMA_VERSION,
  type ChangeSummary,
  type CurrentItem,
  type ItemMetrics,
  type MetricEvent,
  type MetricsExport,
  type MetricsState,
  itemMetrics,
  reconcile,
  sortByTokens,
  summarize,
} from '@openspec-ide/core';
import type { BoardService } from './board.js';
import type { MetricsStore } from './metricsStore.js';
import type { WorkspaceReader } from './workspace.js';

/** Метрики change, как их видит интерфейс. */
export type ChangeMetricsView =
  | {
      readonly change: string;
      readonly tracked: true;
      readonly trackedPath: string;
      readonly summary: ChangeSummary;
      /** Действующие пункты, отсортированные по расходу. */
      readonly items: readonly ItemMetrics[];
      /** Удалённые пункты с сохранёнными метриками. */
      readonly removed: readonly ItemMetrics[];
      /** Снимок пересобирался из журнала при загрузке. */
      readonly recovered: boolean;
    }
  | {
      readonly change: string;
      readonly tracked: false;
      /** Почему метрики пунктов для этого change не ведутся. */
      readonly reason: string;
    };

/** Результат прогона проверки приёмки. */
export interface AcceptanceRunResult {
  readonly exitCode: number;
  readonly durationMs: number;
  /** Хвост вывода команды — для показа, в журнал не пишется. */
  readonly output: string;
  readonly timedOut: boolean;
}

/** Пункт с таким ключом отсутствует. */
export class UnknownItemError extends Error {
  constructor(
    readonly change: string,
    readonly key: string,
  ) {
    super(`В изменении «${change}» нет пункта ${key}`);
    this.name = 'UnknownItemError';
  }
}

interface MetricsServiceOptions {
  readonly root: string;
  readonly board: BoardService;
  readonly workspace: WorkspaceReader;
  readonly store: MetricsStore;
  /** Источник времени; подменяется в тестах. */
  readonly now?: () => Date;
  /** Предел времени проверки приёмки, мс. */
  readonly acceptanceTimeoutMs?: number;
}

const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 8_000;

/**
 * Метрики пунктов плана.
 *
 * Перед каждым чтением пункты файла сопоставляются с накопленными метриками:
 * отметки, поставленные в обход IDE — агентом или в редакторе, — тоже
 * попадают в журнал.
 */
export class MetricsService {
  readonly #options: MetricsServiceOptions;

  constructor(options: MetricsServiceOptions) {
    this.#options = options;
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }

  /** Сопоставляет пункты файла с журналом и отдаёт метрики change. */
  async view(change: string): Promise<ChangeMetricsView> {
    const tracked = await this.#options.board.readTrackedItems(change);
    if (tracked.path === null) {
      return {
        change,
        tracked: false,
        reason:
          'Схема этого изменения не объявила отслеживаемый артефакт (apply.tracks), ' +
          'поэтому процесс не сказал, по чему измерять прогресс. Метрики пунктов не ведутся.',
      };
    }

    const current: CurrentItem[] = tracked.items.map((item) => ({
      key: `${item.group}.${item.index}`,
      text: item.text,
      done: item.done,
    }));

    const now = this.#now();
    const state = await this.#options.store.transact((snapshot) => ({
      events: reconcile(snapshot, change, current, now),
      result: snapshot,
    }));

    const { tree } = await this.#options.workspace.readTree();
    const node = tree.changes.find((item) => item.name === change);

    return {
      change,
      tracked: true,
      trackedPath: tracked.path,
      ...this.#compute(state, change, now, {
        schema: node?.schema ?? null,
        lastModified: node?.lastModified ?? null,
      }),
      recovered: this.#options.store.lastLoad?.recovered ?? false,
    };
  }

  /** Сопоставляет все активные changes — после внешних правок файлов. */
  async reconcileAll(): Promise<void> {
    const { tree } = await this.#options.workspace.readTree();
    for (const change of tree.changes) {
      await this.view(change.name);
    }
  }

  /** Явно берёт пункт в работу. */
  async start(change: string, key: string): Promise<void> {
    const text = await this.#requireItemText(change, key);
    await this.#options.store.append([
      { type: 'item-started', at: this.#now(), change, item: key, text },
    ]);
  }

  /** Привязывает к пункту команду проверки приёмки. */
  async bindAcceptance(change: string, key: string, command: string): Promise<void> {
    await this.#requireItemText(change, key);
    await this.#options.store.append([
      { type: 'acceptance-bound', at: this.#now(), change, item: key, command },
    ]);
  }

  /**
   * Запускает привязанную команду проверки приёмки.
   *
   * Сохраняются код возврата, длительность и момент запуска; вывод только
   * показывается, чтобы журнал не разрастался.
   */
  async runAcceptance(change: string, key: string): Promise<AcceptanceRunResult> {
    await this.#requireItemText(change, key);
    const state = await this.#options.store.state();
    const command = state.changes.get(change)?.items.get(key)?.acceptanceCommand ?? null;
    if (command === null) {
      throw new Error(`К пункту ${key} не привязана команда проверки приёмки`);
    }

    const startedAt = this.#now();
    const result = await runShell(
      command,
      this.#options.root,
      this.#options.acceptanceTimeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
    );

    await this.#options.store.append([
      {
        type: 'acceptance-checked',
        at: startedAt,
        change,
        item: key,
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      },
    ]);
    return result;
  }

  /** Записывает завершённый запуск агента — источник показателей расхода. */
  async recordRun(event: Extract<MetricEvent, { type: 'run-finished' }>): Promise<void> {
    await this.#options.store.append([event]);
  }

  /**
   * Выгружает метрики с версией схемы данных.
   *
   * Changes, которых уже нет среди активных, помечаются архивными: их события
   * остались в журнале после архивации.
   */
  async export(change?: string): Promise<MetricsExport> {
    const { tree } = await this.#options.workspace.readTree();
    const active = new Set(tree.changes.map((item) => item.name));

    // Активные changes перед выгрузкой сопоставляются с файлами.
    for (const name of active) {
      if (change === undefined || name === change) await this.view(name);
    }

    const state = await this.#options.store.state();
    const now = this.#now();
    const names =
      change === undefined ? [...state.changes.keys()].sort() : [change].filter((name) => state.changes.has(name));

    return {
      schemaVersion: METRICS_SCHEMA_VERSION,
      generatedAt: now,
      changes: names.map((name) => {
        const node = tree.changes.find((item) => item.name === name);
        const computed = this.#compute(state, name, now, {
          schema: node?.schema ?? null,
          lastModified: node?.lastModified ?? null,
        });
        return {
          change: name,
          archived: !active.has(name),
          summary: computed.summary,
          items: [...computed.items, ...computed.removed],
        };
      }),
    };
  }

  #compute(
    state: MetricsState,
    change: string,
    now: string,
    context: { schema: string | null; lastModified: string | null },
  ): { summary: ChangeSummary; items: ItemMetrics[]; removed: ItemMetrics[] } {
    const record = state.changes.get(change);
    const all = [...(record?.items.values() ?? [])].map((item) => itemMetrics(change, item, now));
    const active = all.filter((item) => item.state !== 'removed');
    const removed = all.filter((item) => item.state === 'removed');

    return {
      summary: summarize(change, all, record?.unassignedRuns ?? [], context),
      items: sortByTokens(active),
      removed,
    };
  }

  async #requireItemText(change: string, key: string): Promise<string> {
    const tracked = await this.#options.board.readTrackedItems(change);
    const item = tracked.items.find((entry) => `${entry.group}.${entry.index}` === key);
    if (item === undefined) throw new UnknownItemError(change, key);
    return item.text;
  }
}

/** Запускает команду оболочки в корне рабочего пространства. */
function runShell(command: string, cwd: string, timeoutMs: number): Promise<AcceptanceRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    // Отдельная группа процессов: команда проверки обычно порождает свои
    // процессы (тест-раннер, воркеры), и сигнал одному `sh` их не остановит —
    // они продолжат держать канал вывода, и проверка не завершится никогда.
    // Оболочка платформы: `sh` на POSIX, `cmd.exe` на Windows.
    const child = spawnShell(command, { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' } });
    const killGroup = (signal: NodeJS.Signals): void => killTree(child, signal === 'SIGKILL');

    let output = '';
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        // Прерванная по времени проверка — непройденная, а не «без результата».
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Date.now() - started,
        output,
        timedOut,
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, durationMs: Date.now() - started, output: error.message, timedOut });
    });
  });
}
