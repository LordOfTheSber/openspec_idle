import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ADR_DIR,
  CONTEXT_DIR,
  MODULES_DIR,
  MODULE_INDEX_FILES,
  SPECS_DIR,
  type AdrSource,
  type ContextGroup,
  type ContextMap,
  type KeyLine,
  type ModuleFreshness,
  type ModuleSource,
  buildContextMap,
  codePathPrefix,
  extractReferences,
  firstHeading,
  referenceCandidates,
  specPathOf,
  splitFrontmatter,
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

/** Имя модуля, при желании с группами: `web`, `back/cm`. */
const RE_MODULE_PATH = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** Frontmatter файла метаданных нового модуля. */
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

/** Папка модуля, найденная обходом `openspec/context/`. */
export interface ScannedModule {
  /** Папка относительно `openspec/context/`. */
  readonly folder: string;
  /** Имя файла метаданных; `null` — его нет. */
  readonly index: string | null;
  /** `.md` модуля относительно его папки, кроме файла метаданных. */
  readonly files: readonly string[];
}

/** Раскладка `openspec/context/`: какие файлы чему принадлежат. */
export interface ContextLayout {
  /** Общий контекст — `.md` в корне. */
  readonly general: readonly string[];
  readonly modules: readonly ScannedModule[];
  readonly groups: readonly ContextGroup[];
  /** ADR — `.md` в `adr/` и её подпапках, кроме `README.md`. */
  readonly adrs: readonly string[];
  /** Файлы, которые не входят ни в один набор. */
  readonly unused: readonly string[];
}

interface Folder {
  /** Путь относительно `openspec/context/`; корень — `''`. */
  readonly path: string;
  readonly files: readonly string[];
  readonly folders: readonly Folder[];
}

/** Папка ADR относительно `openspec/context/`. */
const ADR_FOLDER = ADR_DIR.slice(CONTEXT_DIR.length + 1);
const isMarkdown = (name: string): boolean => name.toLowerCase().endsWith('.md');
const indexOf = (folder: Folder): string | null => MODULE_INDEX_FILES.find((name) => folder.files.includes(name)) ?? null;
const hasModuleBelow = (folder: Folder): boolean => folder.folders.some((child) => indexOf(child) !== null || hasModuleBelow(child));
const allFiles = (folder: Folder): string[] => [
  ...folder.files.map((name) => `${folder.path}/${name}`),
  ...folder.folders.flatMap(allFiles),
];

/**
 * Раскладывает `openspec/context/` на общий контекст, модули, группы, ADR и
 * лишнее. Правила не зависят от имён разделов (`modules/`, `functions/`…):
 *
 * - `.md` в корне — общий контекст, `adr/` — решения;
 * - папка с `00-start-here.md` или `index.md` — модуль на любой глубине; его
 *   `.md` — в папке и в подпапках, которые сами не модули;
 * - папка без файла метаданных, под которой есть модули, — группа: её `.md` —
 *   общий контекст модулей под ней;
 * - папка глубже раздела без файла метаданных и без модулей под ней, в которой
 *   есть `.md` или нет ничего, — модуль без файла метаданных (ошибка карты);
 * - всё прочее, в том числе не `.md`, — вне наборов.
 */
export async function scanContext(root: string): Promise<ContextLayout> {
  const read = async (path: string): Promise<Folder> => {
    const entries = await listDir(join(root, ...CONTEXT_DIR.split('/'), ...path.split('/').filter((part) => part !== '')));
    const folders = await Promise.all(
      entries.filter((entry) => entry.isDir).map((entry) => read(path === '' ? entry.name : `${path}/${entry.name}`)),
    );
    return { path, files: entries.filter((entry) => !entry.isDir).map((entry) => entry.name), folders };
  };
  const tree = await read('');
  const full = (path: string): string => `${CONTEXT_DIR}/${path}`;

  const general: string[] = [];
  const modules: { folder: string; index: string | null; files: string[] }[] = [];
  const groups: ContextGroup[] = [];
  const adrs: string[] = [];
  const unused: string[] = [];

  for (const name of tree.files) (isMarkdown(name) ? general : unused).push(full(name));

  const visit = (folder: Folder, owner: { folder: string; files: string[] } | null): void => {
    const index = indexOf(folder);
    if (index !== null) {
      const module = { folder: folder.path, index, files: [] as string[] };
      modules.push(module);
      for (const name of folder.files) {
        if (name === index) continue;
        if (isMarkdown(name)) module.files.push(name);
        else unused.push(full(`${folder.path}/${name}`));
      }
      for (const child of folder.folders) visit(child, module);
      return;
    }
    if (owner !== null) {
      for (const name of folder.files) {
        const path = `${folder.path}/${name}`;
        if (isMarkdown(name)) owner.files.push(path.slice(owner.folder.length + 1));
        else unused.push(full(path));
      }
      for (const child of folder.folders) visit(child, owner);
      return;
    }
    if (hasModuleBelow(folder)) {
      const files = folder.files.filter(isMarkdown).map((name) => full(`${folder.path}/${name}`));
      if (files.length > 0) groups.push({ folder: folder.path, files });
      for (const name of folder.files) if (!isMarkdown(name)) unused.push(full(`${folder.path}/${name}`));
      for (const child of folder.folders) visit(child, null);
      return;
    }
    const nested = folder.path.includes('/');
    const paths = allFiles(folder);
    if (nested && (paths.length === 0 || paths.some(isMarkdown))) {
      const module = { folder: folder.path, index: null, files: [] as string[] };
      modules.push(module);
      for (const path of paths) {
        if (isMarkdown(path)) module.files.push(path.slice(folder.path.length + 1));
        else unused.push(full(path));
      }
      return;
    }
    unused.push(...paths.map(full));
  };

  for (const folder of tree.folders) {
    if (folder.path !== ADR_FOLDER) {
      visit(folder, null);
      continue;
    }
    for (const path of allFiles(folder)) {
      const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
      if (!isMarkdown(name)) unused.push(full(path));
      else if (name !== 'readme.md') adrs.push(full(path));
    }
  }

  return { general: general.sort(), modules, groups, adrs: adrs.sort(), unused: unused.sort() };
}

/** Модуль, прочитанный с диска, вместе с тем, что нужно контролю контекста. */
interface ReadModule {
  readonly source: ModuleSource;
  /** Тексты файла метаданных и файлов модуля по путям от корня. */
  readonly texts: ReadonlyMap<string, string>;
  /** Пути `code_paths` как записаны. */
  readonly codePaths: readonly string[];
}

export class ContextMapService {
  readonly #root: string;
  readonly #git: GitHistory;

  constructor(root: string) {
    this.#root = root;
    this.#git = new GitHistory(root);
  }

  async build(): Promise<ContextMap> {
    const layout = await scanContext(this.#root);
    const [read, adrs, domains] = await Promise.all([this.#modules(layout.modules), this.#adrs(layout.adrs), this.#domains()]);

    const texts = new Map<string, string>();
    const plain = [...layout.general, ...layout.groups.flatMap((group) => group.files)];
    const plainTexts = await Promise.all(plain.map(async (path) => [path, await readText(this.#abs(path))] as const));
    for (const [path, text] of plainTexts) if (text !== null) texts.set(path, text);
    for (const module of read) for (const [path, text] of module.texts) texts.set(path, text);
    for (const adr of adrs) texts.set(adr.source.path, adr.text);
    const specTexts = await Promise.all(domains.map(async (domain) => [specPathOf(domain), await readText(this.#abs(specPathOf(domain)))] as const));
    for (const [path, text] of specTexts) if (text !== null) texts.set(path, text);

    const modules = await Promise.all(
      read.map(async (module) => ({ ...module.source, freshness: await this.#freshness(module) })),
    );
    const existingPaths = await this.#existingReferences(texts, plain, read, adrs.map((adr) => adr.source.path));
    return buildContextMap({
      general: layout.general,
      groups: layout.groups,
      modules,
      adrs: adrs.map((adr) => adr.source),
      domains,
      texts,
      existingPaths,
      unusedFiles: layout.unused,
    });
  }

  /**
   * Заводит папку модуля в `openspec/context/modules/`: имя может включать
   * группы (`back/cm`). Раскладка — как у модулей проекта: если все они на
   * прежнем `index.md`, то `index.md` и `context.md`, иначе `00-start-here.md`
   * и `01-product-context.md`.
   *
   * Существующая папка не трогается: правка описанного модуля — дело
   * редактора, а не заготовки.
   */
  async createModule(name: string): Promise<{ index: string; context: string }> {
    if (!RE_MODULE_PATH.test(name)) {
      throw new ContextModuleError(
        `Имя модуля «${name}» должно быть в kebab-case: строчные латинские буквы, цифры и дефисы, группы — через /, например back/cm`,
        400,
      );
    }
    const id = name.split('/').pop() ?? name;
    const folder = `${MODULES_DIR}/${name}`;
    if (await exists(this.#abs(folder))) throw new ContextModuleError(`Модуль «${name}» уже есть: ${folder}/`, 409);
    const { modules } = await scanContext(this.#root);
    const legacy = modules.length > 0 && modules.every((module) => module.index === 'index.md');
    const [indexName, contextName, title] = legacy
      ? ['index.md', 'context.md', `Контекст модуля ${id}`]
      : ['00-start-here.md', '01-product-context.md', `${id}: продуктовый контекст`];
    await mkdir(this.#abs(folder), { recursive: true });
    const index = `${folder}/${indexName}`;
    const context = `${folder}/${contextName}`;
    await writeFile(this.#abs(index), moduleIndexTemplate(id), { encoding: 'utf8', flag: 'wx' });
    await writeFile(this.#abs(context), `# ${title}\n`, { encoding: 'utf8', flag: 'wx' });
    return { index, context };
  }

  #abs(relative: string): string {
    return join(this.#root, ...relative.split('/'));
  }

  async #modules(scanned: readonly ScannedModule[]): Promise<ReadModule[]> {
    return Promise.all(
      scanned.map(async (module) => {
        const base = `${CONTEXT_DIR}/${module.folder}`;
        const texts = new Map<string, string>();
        const indexPath = module.index === null ? null : `${base}/${module.index}`;
        for (const path of [...(indexPath === null ? [] : [indexPath]), ...module.files.map((file) => `${base}/${file}`)]) {
          const text = await readText(this.#abs(path));
          if (text !== null) texts.set(path, text);
        }
        const index = indexPath === null ? undefined : texts.get(indexPath);
        const parsed = index === undefined ? null : parseFrontmatter(index);
        const codePaths = listField(parsed?.value, 'code_paths');
        const existing = new Set<string>();
        for (const path of codePaths) {
          if (await codePathExists(this.#root, path)) existing.add(path);
        }
        return {
          source: {
            folder: module.folder,
            index: index === undefined ? null : module.index,
            files: module.files,
            frontmatter: parsed?.value ?? null,
            frontmatterError: parsed?.error ?? null,
            lineOf: parsed?.lineOf ?? (() => null),
            existingCodePaths: existing,
          },
          texts,
          codePaths,
        };
      }),
    );
  }

  async #adrs(paths: readonly string[]): Promise<{ source: AdrSource; text: string }[]> {
    return Promise.all(
      paths.map(async (path) => {
        const text = (await readText(this.#abs(path))) ?? '';
        const parsed = parseFrontmatter(text);
        return {
          source: {
            path,
            frontmatter: parsed.value,
            frontmatterError: parsed.error,
            lineOf: parsed.lineOf,
            heading: firstHeading(parsed.body),
          },
          text,
        };
      }),
    );
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
   * Какие пути-кандидаты ссылок из текстов контекста существуют: от файла, от
   * корня и от путей кода модуля. Каждый путь проверяется один раз.
   */
  async #existingReferences(
    texts: ReadonlyMap<string, string>,
    plain: readonly string[],
    modules: readonly ReadModule[],
    adrs: readonly string[],
  ): Promise<Set<string>> {
    const sources: { path: string; codePaths: readonly string[] }[] = [
      ...plain.map((path) => ({ path, codePaths: [] })),
      ...modules.flatMap((module) => [...module.texts.keys()].map((path) => ({ path, codePaths: module.codePaths }))),
      ...adrs.map((path) => ({ path, codePaths: [] })),
    ];
    const candidates = new Set<string>();
    for (const { path, codePaths } of sources) {
      const text = texts.get(path);
      if (text === undefined) continue;
      for (const reference of extractReferences(text)) {
        for (const candidate of referenceCandidates(reference, path, codePaths)) candidates.add(candidate);
      }
    }
    const checked = await Promise.all([...candidates].map(async (path) => [path, await exists(this.#abs(path))] as const));
    return new Set(checked.filter(([, found]) => found).map(([path]) => path));
  }

  /**
   * Свежесть файлов модуля по git: сколько коммитов в путях кода модуля
   * сделано после последнего коммита его файлов контекста. Без git, без файлов
   * или без существующих путей кода — `null`.
   */
  async #freshness(module: ReadModule): Promise<ModuleFreshness | null> {
    const files = [...module.texts.keys()];
    if (files.length === 0) return null;
    const prefixes = module.codePaths
      .filter((path) => module.source.existingCodePaths.has(path))
      .map(codePathPrefix)
      .filter((prefix): prefix is string => prefix !== null);
    if (prefixes.length === 0 || !(await this.#git.available())) return null;
    const [uncommitted, last, codeDate] = await Promise.all([
      this.#git.hasChanges(files),
      this.#git.lastCommit(files),
      this.#git.lastCommitDate(prefixes),
    ]);
    if (uncommitted) return { contextDate: last?.date ?? null, codeDate, commitsAfter: 0, uncommitted: true };
    if (last === null) return null;
    const commitsAfter = await this.#git.commitsAfter(last.commit, prefixes);
    return commitsAfter === null ? null : { contextDate: last.date, codeDate, commitsAfter, uncommitted: false };
  }
}
