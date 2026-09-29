import { type Trace, appendPlanItem, buildTrace } from '@openspec-ide/core';
import type { BoardService } from './board.js';
import { ChangeOperationError } from './board.js';
import type { DeltaReader } from './deltas.js';
import type { MetricsService } from './metrics.js';

/** Приёмка и файлы пункта плана — из метрик. */
export interface TraceItemMetrics {
  readonly passed: boolean | null;
  readonly command: string | null;
  readonly criterion: string | null;
  readonly files: readonly string[];
}

/** Трассировка change, как её отдаёт сервер. */
export interface TraceView {
  readonly change: string;
  /** Отслеживаемый артефакт; `null`, если схема его не объявила. */
  readonly planPath: string | null;
  readonly trace: Trace;
  /** Метрики пунктов по ключу `<группа>.<номер>`. */
  readonly metrics: Readonly<Record<string, TraceItemMetrics>>;
}

/** Связь сценариев дельт change с пунктами его плана. */
export class TraceService {
  readonly #deltas: DeltaReader;
  readonly #board: BoardService;
  readonly #metrics: MetricsService | null;

  constructor(deltas: DeltaReader, board: BoardService, metrics: MetricsService | null) {
    this.#deltas = deltas;
    this.#board = board;
    this.#metrics = metrics;
  }

  async view(change: string): Promise<TraceView> {
    const [deltas, plan] = await Promise.all([this.#deltas.readChangeDeltas(change), this.#board.readTrackedText(change)]);
    const trace = buildTrace(deltas.views, plan?.text ?? (plan === null ? null : ''));

    const metrics: Record<string, TraceItemMetrics> = {};
    if (this.#metrics !== null && plan !== null) {
      const view = await this.#metrics.view(change);
      if (view.tracked) {
        for (const item of view.items) {
          metrics[item.key] = {
            passed: item.acceptance.passed,
            command: item.acceptance.command,
            criterion: item.acceptance.criterion,
            files: item.files,
          };
        }
      }
    }

    return { change, planPath: plan?.path ?? null, trace, metrics };
  }

  /** Дописывает в план пункт со ссылкой на сценарий. */
  async addItem(change: string, target: { capability: string; requirement: string; scenario: string }): Promise<TraceView> {
    const plan = await this.#board.readTrackedText(change);
    if (plan === null) {
      throw new ChangeOperationError(`Схема изменения «${change}» не объявила отслеживаемый артефакт — пункт некуда добавить`, '');
    }
    const { trace } = await this.view(change);
    const scenario = trace.scenarios.find(
      (item) =>
        item.capability === target.capability && item.requirement === target.requirement && item.name === target.scenario,
    );
    if (scenario === undefined) {
      throw new ChangeOperationError(
        `В дельтах изменения «${change}» нет сценария «${target.scenario}» в ${target.capability}`,
        '',
      );
    }
    const next = appendPlanItem(plan.text ?? '', {
      capability: scenario.capability,
      target: scenario.name,
      title: scenario.name,
    });
    await this.#board.writeTrackedText(change, next.text);
    return this.view(change);
  }
}
