import { statSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ADR_DIR,
  CONTEXT_DIR,
  MODULES_DIR,
  MODULE_CONTEXT_FILE,
  MODULE_INDEX_FILE,
  SPECS_DIR,
  type AdrSource,
  type ContextMap,
  type KeyLine,
  type ModuleFreshness,
  type ModuleSource,
  buildContextMap,
  codePathPrefix,
  firstHeading,
  specPathOf,
  splitFrontmatter,
  textReferenceCandidates,
} from '@openspec-ide/core';
import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';
import { GitHistory } from './git.js';

/** Разобранный frontmatter markdown-файла. */
export interface ParsedFrontmatter {
  readonly value: unknown;
  readonly error: { readonly message: string; readonly line: number | null } | null;
  /** Строка ключа верхнего уровня в файле (с 1). */
  readonly lineOf: KeyLine;
  readonly body: string;
}

/** Разбирает frontmatter файла, запоминая строки ключей верхнего уровня. */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const split = splitFrontmatter(text);
  if (split.yaml === null) return { value: null, error: null, lineOf: () => null, body: split.body };

  const offset = split.firstLine - 1;
  const counter = new LineCounter();
  const document = parseDocument(split.yaml, { lineCounter: counter, prettyErrors: false });
  const failure = document.errors[0];
  if (failure !== undefined) {
    return {
      value: null,
      error: {
        message: failure.message.split('\n')[0] ?? failure.message,
        line: counter.linePos(failure.pos[0]).line + offset,
      },
      lineOf: () => null,
      body: split.body,
    };
  }

  const lines = new Map<string, number>();
  if (isMap(document.contents)) {
    for (const pair of document.contents.items) {
      const start = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
      if (isScalar(pair.key) && start !== undefined) {
        lines.set(String(pair.key.value), counter.linePos(start).line + offset);
      }
    }
  }
  return { value: document.toJS(), error: null, lineOf: (key) => lines.get(key) ?? null, body: split.body };
}

async function listDir(path: string): Promise<{ name: string; isDir: boolean }[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }));
  } catch {
    return [];
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Сколько путей проверяется подряд, не уступая цикл событий. */
const EXISTS_BATCH = 500;

/** Путь существует (как `stat`: по симлинку — его цель). */
function existsNow(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    // ENOTDIR (путь внутри файла), нет доступа — пути нет.
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Путь кода из `code_paths` существует. Шаблон проверяется по части до первого
 * сегмента со звёздочкой или многоточием: `src/main/java/**` — это `src/main/java`.
 * Путь за пределами корня не существует.
 */
export async function codePathExists(root: string, path: string): Promise<boolean> {
  const posix = path.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return false;
  const first = posix.split('/').find((segment) => segment !== '');
  if (first === undefined) return false;
  // Шаблон с самого начала (`**/*.java`) проверить нечем — он не считается ошибкой.
  if (first.includes('*') || first === '...' || first === '…') return true;
  // Путь выше корня неизменяемой части не имеет — его нет.
  const prefix = codePathPrefix(posix);
  return prefix === null ? false : exists(join(root, prefix));
}

/** Строки поля frontmatter: список или одно значение. */
function listField(value: unknown, key: string): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const field = (value as Record<string, unknown>)[key];
  const items = Array.isArray(field) ? field : [field];
  return items.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
}

/** Строит карту контекста проекта по файлам `openspec/context/` и `openspec/specs/`. */
/** Модуль с таким именем уже описан или имя недопустимо. */
export class ContextModuleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
    this.name = 'ContextModuleError';
  }
}

const RE_MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Заготовка `index.md` нового модуля. */
export function moduleIndexTemplate(id: string): string {
  return [
    '---',
    `module: ${id}`,
    'description: ""',
    'domains: []',
    'code_paths: []',
    'depends_on: []',
    '---',
    '',
    `# ${id}`,
    '',
  ].join('\n');
}

/** Модуль, прочитанный с диска, вместе с тем, что нужно контролю контекста. */
interface ReadModule {
  readonly source: ModuleSource;
  /** Текст `context.md`; `null` — файла нет. */
  readonly context: string | null;
  /** Пути `code_paths` как записаны. */
  readonly codePaths: readonly string[];
}

/**
 * Свежесть `context.md` модулей под одним снимком состояния git. Ключ модуля —
 * путь `context.md`, префиксы путей кода и текст `context.md`; в записи —
 * обещание, поэтому одновременные сборки карты ждут один расчёт.
 */
interface FreshnessCache {
  readonly snapshot: string;
  readonly entries: Map<string, { readonly inputs: string; readonly result: Promise<ModuleFreshness | null> }>;
}

export class ContextMapService {
  readonly #root: string;
  readonly #git: GitHistory;
  #freshnessCache: FreshnessCache | null = null;

  constructor(root: string) {
    this.#root = root;
    this.#git = new GitHistory(root);
  }

  async build(): Promise<ContextMap> {
    const [general, read, adrs, domains, unusedFiles] = await Promise.all([
      this.#general(),
      this.#modules(),
      this.#adrs(),
      this.#domains(),
      this.#unusedFiles(),
    ]);

    const texts = new Map<string, string>();
    const generalTexts = await Promise.all(general.map(async (path) => [path, await readText(this.#abs(path))] as const));
    for (const [path, text] of generalTexts) if (text !== null) texts.set(path, text);
    for (const module of read) {
      if (module.context !== null) texts.set(`${MODULES_DIR}/${module.source.folder}/${MODULE_CONTEXT_FILE}`, module.context);
    }
    for (const adr of adrs) texts.set(adr.source.path, adr.text);
    const specTexts = await Promise.all(domains.map(async (domain) => [specPathOf(domain), await readText(this.#abs(specPathOf(domain)))] as const));
    for (const [path, text] of specTexts) if (text !== null) texts.set(path, text);

    // Снимок git — один на сборку и только если свежесть кому-то нужна.
    let snapshot: Promise<string | null> | null = null;
    const snapshotOf = (): Promise<string | null> => (snapshot ??= this.#git.snapshot());
    const modules = await Promise.all(
      read.map(async (module) => ({ ...module.source, freshness: await this.#freshness(module, snapshotOf) })),
    );
    const existingPaths = await this.#existingReferences(texts, general, read, adrs.map((adr) => adr.source.path));
    return buildContextMap({
      general,
      modules,
      adrs: adrs.map((adr) => adr.source),
      domains,
      texts,
      existingPaths,
      unusedFiles,
    });
  }

  /**
   * Заводит папку модуля с `index.md` и пустым `context.md`.
   *
   * Существующая папка не трогается: правка описанного модуля — дело
   * редактора, а не заготовки.
   */
  async createModule(id: string): Promise<{ index: string; context: string }> {
    if (!RE_MODULE_ID.test(id)) {
      throw new ContextModuleError(`Имя модуля «${id}» должно быть в kebab-case: строчные латинские буквы, цифры и дефисы`, 400);
    }
    const folder = `${MODULES_DIR}/${id}`;
    const exists = await stat(this.#abs(folder)).then(
      () => true,
      () => false,
    );
    if (exists) throw new ContextModuleError(`Модуль «${id}» уже есть: ${folder}/`, 409);
    await mkdir(this.#abs(folder), { recursive: true });
    const index = `${folder}/${MODULE_INDEX_FILE}`;
    const context = `${folder}/${MODULE_CONTEXT_FILE}`;
    await writeFile(this.#abs(index), moduleIndexTemplate(id), { encoding: 'utf8', flag: 'wx' });
    await writeFile(this.#abs(context), `# Контекст модуля ${id}\n`, { encoding: 'utf8', flag: 'wx' });
    return { index, context };
  }

  #abs(relative: string): string {
    return join(this.#root, ...relative.split('/'));
  }

  async #general(): Promise<string[]> {
    const entries = await listDir(this.#abs(CONTEXT_DIR));
    return entries
      .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => `${CONTEXT_DIR}/${entry.name}`);
  }

  async #modules(): Promise<ReadModule[]> {
    const folders = (await listDir(this.#abs(MODULES_DIR))).filter((entry) => entry.isDir);
    return Promise.all(
      folders.map(async ({ name }) => {
        const index = await readText(this.#abs(`${MODULES_DIR}/${name}/${MODULE_INDEX_FILE}`));
        const context = await readText(this.#abs(`${MODULES_DIR}/${name}/${MODULE_CONTEXT_FILE}`));
        const parsed = index === null ? null : parseFrontmatter(index);
        const codePaths = listField(parsed?.value, 'code_paths');
        const existing = new Set<string>();
        for (const path of codePaths) {
          if (await codePathExists(this.#root, path)) existing.add(path);
        }
        return {
          source: {
            folder: name,
            hasIndex: index !== null,
            hasContext: context !== null,
            frontmatter: parsed?.value ?? null,
            frontmatterError: parsed?.error ?? null,
            lineOf: parsed?.lineOf ?? (() => null),
            existingCodePaths: existing,
          },
          context,
          codePaths,
        };
      }),
    );
  }

  async #adrs(): Promise<{ source: AdrSource; text: string }[]> {
    const found: { source: AdrSource; text: string }[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await listDir(this.#abs(relative))) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDir) {
          await walk(child);
          continue;
        }
        if (!entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue;
        const text = (await readText(this.#abs(child))) ?? '';
        const parsed = parseFrontmatter(text);
        found.push({
          source: {
            path: child,
            frontmatter: parsed.value,
            frontmatterError: parsed.error,
            lineOf: parsed.lineOf,
            heading: firstHeading(parsed.body),
          },
          text,
        });
      }
    };
    await walk(ADR_DIR);
    return found;
  }

  async #domains(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const entries = await listDir(this.#abs(`${SPECS_DIR}${relative === '' ? '' : `/${relative}`}`));
      if (relative !== '' && entries.some((entry) => !entry.isDir && entry.name === 'spec.md')) found.push(relative);
      for (const entry of entries) {
        if (entry.isDir) await walk(relative === '' ? entry.name : `${relative}/${entry.name}`);
      }
    };
    await walk('');
    return found.sort();
  }

  /**
   * Файлы в `openspec/context/`, которые не входят ни в один набор: всё, кроме
   * общих `*.md`, `index.md` и `context.md` модулей и `.md` в папке ADR.
   * Скрытые файлы (`.gitkeep` и т. п.) не считаются.
   */
  async #unusedFiles(): Promise<string[]> {
    const found: string[] = [];
    const used = (parts: readonly string[]): boolean => {
      const name = (parts.at(-1) ?? '').toLowerCase();
      if (parts.length === 1) return name.endsWith('.md');
      if (parts[0] === 'modules') return parts.length === 3 && (name === MODULE_INDEX_FILE || name === MODULE_CONTEXT_FILE);
      if (parts[0] === 'adr') return name.endsWith('.md');
      return false;
    };
    const walk = async (parts: readonly string[]): Promise<void> => {
      for (const entry of await listDir(this.#abs([CONTEXT_DIR, ...parts].join('/')))) {
        const child = [...parts, entry.name];
        if (entry.isDir) await walk(child);
        else if (!used(child)) found.push([CONTEXT_DIR, ...child].join('/'));
      }
    };
    await walk([]);
    return found.sort();
  }

  /**
   * Какие пути-кандидаты ссылок из текстов контекста существуют: от файла, от
   * корня и от путей кода модуля. Каждый путь проверяется один раз.
   */
  async #existingReferences(
    texts: ReadonlyMap<string, string>,
    general: readonly string[],
    modules: readonly ReadModule[],
    adrs: readonly string[],
  ): Promise<Set<string>> {
    const sources: { path: string; codePaths: readonly string[] }[] = [
      ...general.map((path) => ({ path, codePaths: [] })),
      ...modules.map((module) => ({ path: `${MODULES_DIR}/${module.source.folder}/${MODULE_CONTEXT_FILE}`, codePaths: module.codePaths })),
      ...adrs.map((path) => ({ path, codePaths: [] })),
    ];
    const candidates = new Set<string>();
    for (const { path, codePaths } of sources) {
      const text = texts.get(path);
      if (text === undefined) continue;
      for (const found of textReferenceCandidates(text, path, codePaths)) {
        for (const candidate of found.candidates) candidates.add(candidate);
      }
    }
    // Проверка пачками синхронного `stat` без исключения на ненайденный путь:
    // асинхронный `stat` тратит время на ошибку ENOENT, а в контексте большинство
    // кандидатов не существует (ссылка ищется от файла, корня и путей кода).
    // Между пачками цикл событий свободен.
    const existing = new Set<string>();
    const list = [...candidates];
    for (let start = 0; start < list.length; start += EXISTS_BATCH) {
      if (start > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      for (const path of list.slice(start, start + EXISTS_BATCH)) if (existsNow(this.#abs(path))) existing.add(path);
    }
    return existing;
  }

  /**
   * Свежесть `context.md` по git: сколько коммитов в путях кода модуля сделано
   * после последнего коммита контекста. Без git, без `context.md` или без
   * существующих путей кода — `null`.
   *
   * Расчёт переиспользуется, пока не изменились снимок git (коммит `HEAD` и
   * индекс), текст `context.md` и префиксы путей кода: от них и только от них
   * зависит результат. Без снимка (нет коммитов, сбой git) — расчёт без кэша.
   */
  async #freshness(module: ReadModule, snapshotOf: () => Promise<string | null>): Promise<ModuleFreshness | null> {
    if (module.context === null) return null;
    const prefixes = module.codePaths
      .filter((path) => module.source.existingCodePaths.has(path))
      .map(codePathPrefix)
      .filter((prefix): prefix is string => prefix !== null);
    if (prefixes.length === 0 || !(await this.#git.available())) return null;
    const contextPath = `${MODULES_DIR}/${module.source.folder}/${MODULE_CONTEXT_FILE}`;
    const snapshot = await snapshotOf();
    if (snapshot === null) return this.#gitFreshness(contextPath, prefixes);

    if (this.#freshnessCache?.snapshot !== snapshot) this.#freshnessCache = { snapshot, entries: new Map() };
    const entries = this.#freshnessCache.entries;
    const inputs = JSON.stringify([[...new Set(prefixes)].sort(), module.context]);
    const cached = entries.get(contextPath);
    if (cached?.inputs === inputs) return cached.result;

    const result = this.#gitFreshness(contextPath, prefixes);
    const entry = { inputs, result };
    entries.set(contextPath, entry);
    // `null` после запросов git — сбой или таймаут: следующая сборка попробует снова.
    void result.then((value) => {
      if (value === null && entries.get(contextPath) === entry) entries.delete(contextPath);
    });
    return result;
  }

  /** Свежесть `context.md` по истории git — четыре запроса. */
  async #gitFreshness(contextPath: string, prefixes: readonly string[]): Promise<ModuleFreshness | null> {
    const [uncommitted, last, codeDate] = await Promise.all([
      this.#git.hasChanges(contextPath),
      this.#git.lastCommit(contextPath),
      this.#git.lastCommitDate(prefixes),
    ]);
    if (uncommitted) return { contextDate: last?.date ?? null, codeDate, commitsAfter: 0, uncommitted: true };
    if (last === null) return null;
    const commitsAfter = await this.#git.commitsAfter(last.commit, prefixes);
    return commitsAfter === null ? null : { contextDate: last.date, codeDate, commitsAfter, uncommitted: false };
  }
}
