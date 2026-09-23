import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import {
  DEFAULT_TEST_PATTERNS,
  extractNameMentions,
  isTestPath,
  parseSpecTag,
  type ModuleDef,
  type NameMention,
} from '@openspec-ide/core';
import { IDE_DIR } from '../config.js';
import { SKIPPED_DIRECTORIES } from '../modules/discovery.js';
import { GitIgnore } from '../modules/gitignore.js';

export const CODE_INDEX_FILE = 'code-index.json';
const CACHE_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
/** Сколько файлов читать подряд, прежде чем отдать управление другим запросам. */
const BATCH = 64;
/** Каталоги зависимостей и сборки; `bin` в коде бывает исходниками (скрипты npm) — его обходим. */
const CODE_SKIPPED = new Set([...SKIPPED_DIRECTORIES].filter((name) => name !== 'bin'));

/** Метка `@spec` в файле. */
export interface IndexedTag {
  readonly line: number;
  readonly module: string;
  readonly requirement: string;
}

/** Файл в индексе. */
export interface IndexedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly test: boolean;
  readonly tags: readonly IndexedTag[];
  /** Имена тестов — только у тестовых файлов. */
  readonly mentions: readonly NameMention[];
}

export interface CodeIndexStatus {
  readonly state: 'idle' | 'indexing' | 'ready';
  readonly files: number;
  /** Сколько файлов обработано в текущем проходе. */
  readonly processed: number;
  readonly indexedAt: string | null;
  /** Итог последнего прохода: прочитано заново и взято из кэша. */
  readonly lastRun: { readonly read: number; readonly reused: number } | null;
  readonly error: string | null;
}

interface CacheFile {
  readonly version: number;
  readonly patterns: readonly string[];
  readonly files: Record<string, IndexedFile>;
}

/**
 * Индекс меток `@spec` и имён тестов по каталогам кода модулей. Строится в
 * фоне порциями, не блокируя запросы; спеки доступны сразу, покрытие — по
 * мере готовности. Повторное открытие перечитывает только изменённые файлы,
 * во время работы изменения подхватывает наблюдатель.
 */
export class CodeIndex {
  readonly #root: string;
  readonly #onChange: () => void;
  #modules: readonly ModuleDef[] = [];
  #patterns: readonly string[] = DEFAULT_TEST_PATTERNS;
  #files = new Map<string, IndexedFile>();
  #status: CodeIndexStatus = { state: 'idle', files: 0, processed: 0, indexedAt: null, lastRun: null, error: null };
  #run: Promise<void> | null = null;
  #generation = 0;
  #watcher: FSWatcher | null = null;
  #saveTimer: NodeJS.Timeout | null = null;
  #ignore: GitIgnore = new GitIgnore('');
  readonly #watch: boolean;

  constructor(options: { root: string; watch?: boolean; onChange?: () => void }) {
    this.#root = options.root;
    this.#watch = options.watch ?? true;
    this.#onChange = options.onChange ?? (() => undefined);
  }

  get status(): CodeIndexStatus {
    return this.#status;
  }

  get files(): ReadonlyMap<string, IndexedFile> {
    return this.#files;
  }

  /** Каталоги кода модулей, в которых ищутся метки. */
  directories(): string[] {
    const paths = [...new Set(this.#modules.map((module) => module.path).filter((path): path is string => path !== null))]
      .map((path) => (path === '.' ? '' : path.replace(/\/+$/, '')))
      .sort((a, b) => a.length - b.length);
    // Вложенный каталог уже покрыт родительским.
    return paths.filter((path, index) => !paths.slice(0, index).some((parent) => parent === '' || path.startsWith(`${parent}/`)));
  }

  /**
   * Запускает построение для текущей карты модулей. Повторный вызов с той же
   * картой и шаблонами возвращает идущий проход.
   */
  configure(modules: readonly ModuleDef[], patterns: readonly string[] | null): Promise<void> {
    const nextPatterns = patterns ?? DEFAULT_TEST_PATTERNS;
    const same =
      this.#run !== null &&
      JSON.stringify(modules.map((module) => [module.id, module.path])) ===
        JSON.stringify(this.#modules.map((module) => [module.id, module.path])) &&
      JSON.stringify(nextPatterns) === JSON.stringify(this.#patterns);
    if (same) return this.#run!;
    this.#modules = modules;
    this.#patterns = nextPatterns;
    this.#generation += 1;
    this.#run = this.#build(this.#generation);
    return this.#run;
  }

  /** Дожидается текущего прохода. */
  async ready(): Promise<void> {
    await this.#run;
  }

  /** Модуль, которому принадлежит файл: самый длинный совпавший каталог кода. */
  ownerOf(path: string): ModuleDef | null {
    let best: ModuleDef | null = null;
    for (const module of this.#modules) {
      if (module.path === null) continue;
      const dir = module.path === '.' ? '' : module.path;
      if (dir !== '' && path !== dir && !path.startsWith(`${dir}/`)) continue;
      if (best === null || dir.length > (best.path === '.' ? 0 : (best.path ?? '').length)) best = module;
    }
    return best;
  }

  async close(): Promise<void> {
    this.#generation += 1;
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    await this.#watcher?.close();
    this.#watcher = null;
  }

  async #build(generation: number): Promise<void> {
    this.#status = { ...this.#status, state: 'indexing', processed: 0, error: null };
    try {
      this.#ignore = await GitIgnore.load(this.#root);
      const cache = await this.#loadCache();
      const paths: string[] = [];
      for (const dir of this.directories()) await this.#walk(dir, paths);
      if (generation !== this.#generation) return;

      const next = new Map<string, IndexedFile>();
      let read = 0;
      let reused = 0;
      for (let index = 0; index < paths.length; index += 1) {
        const path = paths[index]!;
        const entry = await this.#indexFile(path, cache.get(path));
        if (entry === 'reused') {
          next.set(path, cache.get(path)!);
          reused += 1;
        } else if (entry !== null) {
          next.set(path, entry);
          read += 1;
        }
        if (index % BATCH === BATCH - 1) {
          if (generation !== this.#generation) return;
          this.#status = { ...this.#status, processed: index + 1, files: paths.length };
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      if (generation !== this.#generation) return;
      this.#files = next;
      this.#status = {
        state: 'ready',
        files: next.size,
        processed: paths.length,
        indexedAt: new Date().toISOString(),
        lastRun: { read, reused },
        error: null,
      };
      await this.#saveCache();
      if (this.#watch) await this.#startWatcher();
      this.#onChange();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#status = { ...this.#status, state: 'ready', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #walk(dir: string, into: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(this.#root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (this.#skipDirectory(entry.name, path)) continue;
        await this.#walk(path, into);
      } else if (entry.isFile() && !this.#ignore.ignores(path, false)) {
        into.push(path);
      }
    }
  }

  #skipDirectory(name: string, path: string): boolean {
    return CODE_SKIPPED.has(name) || name.startsWith('.') || this.#ignore.ignores(path, true);
  }

  /** `reused` — файл не менялся с прошлого прохода; `null` — не индексируется. */
  async #indexFile(path: string, cached: IndexedFile | undefined): Promise<IndexedFile | 'reused' | null> {
    let info;
    try {
      info = await stat(join(this.#root, path));
    } catch {
      return null;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const test = isTestPath(path, this.#patterns);
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.test === test) {
      return 'reused';
    }
    const text = await readTextFile(join(this.#root, path));
    if (text === null) return null;
    const tags: IndexedTag[] = [];
    text.split('\n').forEach((line, index) => {
      if (!line.includes('@spec')) return;
      const tag = parseSpecTag(line);
      if (tag !== null) tags.push({ line: index + 1, ...tag });
    });
    return { size: info.size, mtimeMs: info.mtimeMs, test, tags, mentions: test ? extractNameMentions(text) : [] };
  }

  async #startWatcher(): Promise<void> {
    await this.#watcher?.close();
    const dirs = this.directories();
    if (dirs.length === 0) return;
    const toRelative = (absolute: string): string =>
      absolute.slice(this.#root.length + 1).split('\\').join('/');
    this.#watcher = watch(
      dirs.map((dir) => join(this.#root, dir)),
      {
        ignoreInitial: true,
        ignored: (absolute: string, stats) => {
          if (absolute === this.#root) return false;
          const path = toRelative(absolute);
          const name = path.slice(path.lastIndexOf('/') + 1);
          if (stats?.isDirectory() === true) return this.#skipDirectory(name, path);
          return this.#ignore.ignores(path, false);
        },
      },
    );
    const update = (absolute: string): void => void this.#refresh(toRelative(absolute));
    this.#watcher.on('add', update).on('change', update).on('unlink', (absolute) => {
      if (this.#files.delete(toRelative(absolute))) this.#changed();
    });
    await new Promise<void>((resolve) => this.#watcher!.once('ready', () => resolve()));
  }

  /** Переиндексирует один файл — без полного прохода. */
  async #refresh(path: string): Promise<void> {
    const entry = await this.#indexFile(path, undefined);
    if (entry === null || entry === 'reused') this.#files.delete(path);
    else this.#files.set(path, entry);
    this.#status = { ...this.#status, files: this.#files.size, indexedAt: new Date().toISOString() };
    this.#changed();
  }

  #changed(): void {
    this.#onChange();
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.#saveCache(), 1000);
  }

  async #loadCache(): Promise<Map<string, IndexedFile>> {
    try {
      const cache = JSON.parse(await readFile(this.#cachePath(), 'utf8')) as CacheFile;
      if (cache.version !== CACHE_VERSION) return new Map();
      return new Map(Object.entries(cache.files));
    } catch {
      return new Map();
    }
  }

  async #saveCache(): Promise<void> {
    const cache: CacheFile = { version: CACHE_VERSION, patterns: this.#patterns, files: Object.fromEntries(this.#files) };
    try {
      await mkdir(join(this.#root, IDE_DIR), { recursive: true });
      // Каталог данных IDE локален для разработчика и в git не попадает.
      const ignore = join(this.#root, IDE_DIR, '.gitignore');
      if (!(await exists(ignore))) await writeFile(ignore, '*\n', 'utf8');
      const temporary = `${this.#cachePath()}.tmp-${process.pid}`;
      await writeFile(temporary, JSON.stringify(cache));
      await rename(temporary, this.#cachePath());
    } catch (error) {
      console.error(`[индекс кода] кэш не сохранён: ${String(error)}`);
    }
  }

  #cachePath(): string {
    return join(this.#root, IDE_DIR, CODE_INDEX_FILE);
  }
}

/** Текст файла; `null` — двоичный (нулевой байт в начале). */
async function readTextFile(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (head.subarray(0, bytesRead).includes(0)) return null;
  } finally {
    await handle.close();
  }
  return readFile(path, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
