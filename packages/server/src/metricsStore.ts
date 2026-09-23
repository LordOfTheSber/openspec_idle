import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  METRICS_SCHEMA_VERSION,
  type ChangeRecord,
  type ItemRecord,
  type MetricEvent,
  type MetricsState,
  type RunRecord,
  applyEvent,
  emptyState,
} from '@openspec-ide/core';
import { IDE_DIR } from './config.js';

/** Имя журнала событий внутри каталога IDE. */
export const JOURNAL_FILE = 'runs.jsonl';

/** Имя снимка состояния внутри каталога IDE. */
export const SNAPSHOT_FILE = 'metrics.json';

/** Итог загрузки хранилища. */
export interface StoreLoad {
  readonly state: MetricsState;
  /** Снимок отсутствовал или был повреждён и пересобран из журнала. */
  readonly recovered: boolean;
  /** Строки журнала, которые не удалось разобрать и пришлось пропустить. */
  readonly skippedLines: number;
}

interface SnapshotFile {
  readonly schemaVersion: number;
  /** Сколько строк журнала уже учтено в снимке. */
  readonly journalLines: number;
  readonly changes: Record<
    string,
    { readonly items: readonly ItemRecord[]; readonly unassignedRuns: readonly RunRecord[] }
  >;
}

/**
 * Хранилище метрик: журнал событий, в который только дописывают, и
 * производный снимок.
 *
 * Журнал устойчив к обрыву: битая последняя строка отбрасывается, остальное
 * применяется. Снимок — только ускорение, его потеря не теряет данных.
 * Все операции выполняются последовательно: параллельная дозапись и
 * пересборка снимка перемешали бы строки.
 */
export class MetricsStore {
  readonly #dir: string;
  readonly #log: (message: string) => void;
  #queue: Promise<unknown> = Promise.resolve();
  #state: MetricsState | null = null;
  #journalLines = 0;
  #lastLoad: StoreLoad | null = null;

  constructor(root: string, log: (message: string) => void = () => undefined) {
    this.#dir = join(root, IDE_DIR);
    this.#log = log;
  }

  get journalPath(): string {
    return join(this.#dir, JOURNAL_FILE);
  }

  get snapshotPath(): string {
    return join(this.#dir, SNAPSHOT_FILE);
  }

  /** Итог последней загрузки — сообщает о восстановлении и пропущенных строках. */
  get lastLoad(): StoreLoad | null {
    return this.#lastLoad;
  }

  /** Выполняет действие строго после предыдущих. */
  #serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(action, action);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Отдаёт текущее состояние, загружая его при первом обращении. */
  state(): Promise<MetricsState> {
    return this.#serial(async () => (await this.#ensureLoaded()).state);
  }

  /** Перечитывает хранилище с диска — например, после внешней правки журнала. */
  reload(): Promise<StoreLoad> {
    return this.#serial(async () => {
      this.#state = null;
      return this.#ensureLoaded();
    });
  }

  /** Дописывает события в журнал и применяет их к состоянию. */
  append(events: readonly MetricEvent[]): Promise<MetricsState> {
    return this.transact((state) => ({ events, result: state }));
  }

  /**
   * Выполняет действие, которому нужно состояние и возможность дописать
   * события, атомарно относительно остальных операций хранилища.
   *
   * Сначала журнал, потом снимок: при сбое между ними снимок отстанет, но
   * при следующей загрузке догонится по журналу.
   */
  transact<T>(
    action: (state: MetricsState) => { events: readonly MetricEvent[]; result: T },
  ): Promise<T> {
    return this.#serial(async () => {
      const { state } = await this.#ensureLoaded();
      const { events, result } = action(state);
      if (events.length > 0) {
        await this.#ensureDir();
        await appendFile(
          this.journalPath,
          events.map((event) => `${JSON.stringify(event)}\n`).join(''),
          'utf8',
        );
        for (const event of events) applyEvent(state, event);
        this.#journalLines += events.length;
        await this.#writeSnapshot(state);
      }
      return result;
    });
  }

  async #ensureLoaded(): Promise<StoreLoad> {
    if (this.#state !== null && this.#lastLoad !== null) {
      return { ...this.#lastLoad, state: this.#state };
    }

    const lines = await this.#readJournalLines();
    const snapshot = await this.#readSnapshot();

    let state: MetricsState;
    let startFrom: number;
    let recovered = false;

    if (snapshot !== null && snapshot.journalLines <= lines.length) {
      state = deserialize(snapshot);
      startFrom = snapshot.journalLines;
    } else {
      state = emptyState();
      startFrom = 0;
      // Журнал есть, а снимка нет или он не сходится с журналом — это
      // восстановление, и пользователю нужно о нём сказать.
      recovered = lines.length > 0;
    }

    let skipped = 0;
    for (let index = startFrom; index < lines.length; index += 1) {
      const event = parseEvent(lines[index] ?? '');
      if (event === null) {
        skipped += 1;
        this.#log(`Журнал метрик: строка ${index + 1} не разбирается и пропущена`);
        continue;
      }
      applyEvent(state, event);
    }

    this.#state = state;
    this.#journalLines = lines.length;
    if (recovered || startFrom < lines.length) await this.#writeSnapshot(state);

    this.#lastLoad = { state, recovered, skippedLines: skipped };
    return this.#lastLoad;
  }

  async #readJournalLines(): Promise<string[]> {
    try {
      const text = await readFile(this.journalPath, 'utf8');
      // Последняя строка без перевода строки — это оборванная запись; она
      // разбирается как обычная и, если битая, пропускается.
      return text.split('\n').filter((line) => line.trim() !== '');
    } catch {
      return [];
    }
  }

  async #readSnapshot(): Promise<SnapshotFile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.snapshotPath, 'utf8')) as SnapshotFile;
      if (parsed.schemaVersion !== METRICS_SCHEMA_VERSION) return null;
      if (typeof parsed.journalLines !== 'number' || typeof parsed.changes !== 'object') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async #writeSnapshot(state: MetricsState): Promise<void> {
    await this.#ensureDir();
    const payload: SnapshotFile = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      journalLines: this.#journalLines,
      changes: Object.fromEntries(
        [...state.changes.entries()].map(([change, record]) => [
          change,
          { items: [...record.items.values()], unassignedRuns: record.unassignedRuns },
        ]),
      ),
    };
    const temporary = `${this.snapshotPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(payload)}\n`, 'utf8');
    await rename(temporary, this.snapshotPath);
  }

  /**
   * Создаёт каталог IDE и сразу исключает его из системы контроля версий:
   * метрики и журналы — локальные данные разработчика, а не часть проекта.
   */
  async #ensureDir(): Promise<void> {
    let existed = true;
    try {
      await stat(this.#dir);
    } catch {
      existed = false;
    }
    await mkdir(this.#dir, { recursive: true });
    if (!existed) {
      await writeFile(join(this.#dir, '.gitignore'), '*\n', 'utf8');
      this.#log(`Создан каталог ${IDE_DIR}/ для метрик; он исключён из системы контроля версий`);
    }
  }
}

function deserialize(snapshot: SnapshotFile): MetricsState {
  const state = emptyState();
  for (const [change, record] of Object.entries(snapshot.changes)) {
    const changeRecord: ChangeRecord = {
      items: new Map(record.items.map((item) => [item.key, structuredClone(item)])),
      unassignedRuns: [...record.unassignedRuns],
    };
    state.changes.set(change, changeRecord);
  }
  return state;
}

function parseEvent(line: string): MetricEvent | null {
  try {
    const parsed = JSON.parse(line) as { type?: unknown; change?: unknown; at?: unknown };
    if (typeof parsed.type !== 'string' || typeof parsed.change !== 'string') return null;
    if (typeof parsed.at !== 'string') return null;
    return parsed as MetricEvent;
  } catch {
    return null;
  }
}
