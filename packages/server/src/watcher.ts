import { OPENSPEC_DIR } from '@openspec-ide/core';
import chokidar, { type FSWatcher } from 'chokidar';
import { join } from 'node:path';
import { toPosixPath } from './process/platform.js';

/** Сводка одного объединённого обновления файлов. */
export interface FileChangeBatch {
  /** Пути изменённых файлов относительно корня рабочего пространства. */
  readonly paths: readonly string[];
  /** Число событий, попавших в объединение. */
  readonly count: number;
}

/** Настройки наблюдателя. */
export interface WatcherOptions {
  readonly root: string;
  /** Окно объединения событий, мс. */
  readonly debounceMs?: number;
  /** Дополнительные каталоги внутри корня, за которыми нужно следить. */
  readonly extraDirs?: readonly string[];
}

const DEFAULT_DEBOUNCE_MS = 150;

/**
 * Следит за каталогом `openspec/` и объединяет изменения в одно обновление.
 *
 * Объединение обязательно: архивация меняет десятки файлов разом, и отдельное
 * обновление на каждый файл дало бы шквал перерисовок и лавину вызовов CLI.
 */
export class WorkspaceWatcher {
  readonly #options: WatcherOptions;
  readonly #onBatch: (batch: FileChangeBatch) => void;
  #watcher: FSWatcher | null = null;
  #pending = new Set<string>();
  #count = 0;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: WatcherOptions, onBatch: (batch: FileChangeBatch) => void) {
    this.#options = options;
    this.#onBatch = onBatch;
  }

  async start(): Promise<void> {
    if (this.#watcher !== null) return;

    const targets = [
      join(this.#options.root, OPENSPEC_DIR),
      ...(this.#options.extraDirs ?? []).map((dir) => join(this.#options.root, dir)),
    ];

    this.#watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
    });

    for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
      this.#watcher.on(event, (path: string) => this.#record(path));
    }

    await new Promise<void>((resolve) => {
      this.#watcher?.once('ready', () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#watcher?.close();
    this.#watcher = null;
    this.#pending.clear();
    this.#count = 0;
  }

  #record(path: string): void {
    const relative = path.startsWith(this.#options.root)
      ? path.slice(this.#options.root.length + 1)
      : path;
    this.#pending.add(toPosixPath(relative));
    this.#count += 1;

    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#flush(), this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  #flush(): void {
    this.#timer = null;
    if (this.#pending.size === 0) return;
    const batch: FileChangeBatch = { paths: [...this.#pending].sort(), count: this.#count };
    this.#pending = new Set();
    this.#count = 0;
    this.#onBatch(batch);
  }
}
