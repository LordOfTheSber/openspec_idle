/**
 * Карта контекста проекта: модули, домены (спеки) и ADR и связи между ними.
 *
 * Модуль — папка `openspec/context/modules/<папка>/` с файлами `index.md`
 * (frontmatter с метаданными) и `context.md` (сам контекст). Домен — спека
 * `openspec/specs/<путь>/spec.md`. Модуль перечисляет свои домены в поле
 * `domains`, поэтому связь многие-ко-многим: у модуля несколько доменов, домен
 * встречается у нескольких модулей. ADR — файл `openspec/context/adr/*.md`,
 * который в своём frontmatter ссылается на модули и домены.
 *
 * Файловой системы и разбора YAML здесь нет: сервер читает файлы, разбирает
 * frontmatter и передаёт сюда обычные значения с функцией «ключ → строка».
 *
 * Кроме связей карта контролирует сам контекст (`contextControl.ts`): объём
 * файлов и наборов, лишнее (повторы, пустые и неиспользуемые файлы) и связь с
 * реальностью (пути в тексте, отставание контекста от кода), а также
 * антипаттерны по токенам (`contextAntipatterns.ts`).
 */

import {
  type TokenAntipattern,
  type TokenAntipatternKind,
  antipatternMessage,
  antipatternSavings,
  findTokenAntipatterns,
} from './contextAntipatterns.js';

import {
  type ContextDuplicate,
  type ContextUsefulness,
  LARGE_FILE_TOKENS,
  LOW_USEFULNESS,
  USEFULNESS_MIN_TOKENS,
  countLines,
  estimateTokens,
  findDuplicates,
  isActiveAdrStatus,
  isEmptyContext,
  measureUsefulness,
  textReferenceCandidates,
} from './contextControl.js';

/** Папка контекста относительно корня рабочего пространства. */
export const CONTEXT_DIR = 'openspec/context';
/** Папка модулей: в ней одна подпапка на модуль. */
export const MODULES_DIR = `${CONTEXT_DIR}/modules`;
/** Папка ADR. */
export const ADR_DIR = `${CONTEXT_DIR}/adr`;
/** Папка доменов — спеков OpenSpec. */
export const SPECS_DIR = 'openspec/specs';
/** Файл метаданных модуля. */
export const MODULE_INDEX_FILE = 'index.md';
/** Файл контекста модуля. */
export const MODULE_CONTEXT_FILE = 'context.md';

/** Frontmatter, отделённый от тела markdown-файла. */
export interface Frontmatter {
  /** Текст YAML между `---`; `null`, если frontmatter нет. */
  readonly yaml: string | null;
  /** Строка файла, с которой начинается YAML (с 1). */
  readonly firstLine: number;
  /** Тело файла после frontmatter. */
  readonly body: string;
}

/**
 * Отделяет frontmatter `---` … `---` в начале файла. Незакрытый блок
 * считается отсутствующим frontmatter: это обычный markdown с чертой.
 */
export function splitFrontmatter(text: string): Frontmatter {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { yaml: null, firstLine: 1, body: source };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === '---' || line === '...') {
      return { yaml: lines.slice(1, index).join('\n'), firstLine: 2, body: lines.slice(index + 1).join('\n') };
    }
  }
  return { yaml: null, firstLine: 1, body: source };
}

/** Заголовок первого уровня из markdown, если он есть. */
export function firstHeading(markdown: string): string | null {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return match?.[1] ?? null;
}

/** Строка ключа frontmatter в файле (с 1); `null`, если неизвестна. */
export type KeyLine = (key: string) => number | null;

/** Модуль, как его прочитал сервер. */
export interface ModuleSource {
  /** Имя папки модуля. */
  readonly folder: string;
  /** Есть ли `index.md`. */
  readonly hasIndex: boolean;
  /** Есть ли `context.md`. */
  readonly hasContext: boolean;
  /**
   * Значение frontmatter `index.md` после разбора YAML; `null` — frontmatter
   * нет или файла нет.
   */
  readonly frontmatter: unknown;
  /** Ошибка разбора YAML с её строкой. */
  readonly frontmatterError: { readonly message: string; readonly line: number | null } | null;
  readonly lineOf: KeyLine;
  /** Какие из путей `code_paths` существуют. */
  readonly existingCodePaths: ReadonlySet<string>;
  /** Свежесть `context.md` относительно кода по git; `null` — не известна. */
  readonly freshness?: ModuleFreshness | null;
}

/** Насколько `context.md` модуля отстаёт от его кода по истории git. */
export interface ModuleFreshness {
  /** Дата последнего коммита `context.md`; `null` — файл ещё не в git. */
  readonly contextDate: string | null;
  /** Дата последнего коммита в путях кода модуля. */
  readonly codeDate: string | null;
  /** Коммитов в путях кода после последнего коммита `context.md`. */
  readonly commitsAfter: number;
  /** В `context.md` есть незакоммиченные правки — контекст считается свежим. */
  readonly uncommitted: boolean;
}

/** ADR, как его прочитал сервер. */
export interface AdrSource {
  /** Путь файла относительно корня. */
  readonly path: string;
  readonly frontmatter: unknown;
  readonly frontmatterError: { readonly message: string; readonly line: number | null } | null;
  readonly lineOf: KeyLine;
  /** Заголовок `# …` из тела. */
  readonly heading: string | null;
}

/** Всё, из чего строится карта. */
export interface ContextMapInput {
  readonly modules: readonly ModuleSource[];
  /** Пути доменов относительно `openspec/specs/`, у которых есть `spec.md`. */
  readonly domains: readonly string[];
  readonly adrs: readonly AdrSource[];
  /** Общие файлы контекста — `openspec/context/*.md`. */
  readonly general: readonly string[];
  /**
   * Тексты файлов контекста по путям: общий контекст, `context.md`, ADR,
   * спеки доменов. Без текста файл не оценивается по объёму и не проверяется.
   */
  readonly texts?: ReadonlyMap<string, string>;
  /**
   * Какие из путей-кандидатов ссылок ({@link referenceCandidates}) существуют.
   * Без набора ссылки не проверяются.
   */
  readonly existingPaths?: ReadonlySet<string>;
  /** Файлы в `openspec/context/`, которые не входят ни в один набор. */
  readonly unusedFiles?: readonly string[];
}

/** Путь кода модуля и есть ли он в рабочем пространстве. */
export interface CodePath {
  readonly path: string;
  readonly exists: boolean;
}

export interface ContextModule {
  /** Идентификатор из поля `module`, иначе имя папки. */
  readonly id: string;
  readonly folder: string;
  readonly description: string | null;
  /** `openspec/context/modules/<папка>/index.md`. */
  readonly indexPath: string;
  /** Есть ли `index.md`: без него связи модуля неизвестны. */
  readonly hasIndex: boolean;
  /** Путь `context.md`; `null`, если файла нет. */
  readonly contextPath: string | null;
  readonly domains: readonly string[];
  readonly dependsOn: readonly string[];
  readonly codePaths: readonly CodePath[];
  /** Какие модули зависят от этого. */
  readonly dependents: readonly string[];
  /** ADR, которые ссылаются на модуль. */
  readonly adrs: readonly string[];
  /** Бюджет набора модуля в токенах из поля `max_tokens`. */
  readonly maxTokens: number | null;
  /** Оценка токенов набора модуля (с зависимостями, спеками и ADR). */
  readonly bundleTokens: number;
  /** Полезные токены набора модуля — по коэффициентам полезности файлов. */
  readonly bundleUsefulTokens: number;
  readonly freshness: ModuleFreshness | null;
}

export interface ContextDomain {
  /** Путь спеки относительно `openspec/specs/`. */
  readonly id: string;
  /** `openspec/specs/<id>/spec.md`; `null` — на домен ссылаются, но спеки нет. */
  readonly specPath: string | null;
  /** Модули, у которых домен в поле `domains`. */
  readonly modules: readonly string[];
  readonly adrs: readonly string[];
}

export interface ContextAdr {
  /** Путь файла — он же идентификатор. */
  readonly path: string;
  /** Имя файла без `.md`. */
  readonly id: string;
  readonly title: string;
  readonly status: string | null;
  /** Решение действует: статус не `superseded`, `deprecated` и т. п. */
  readonly active: boolean;
  readonly modules: readonly string[];
  readonly domains: readonly string[];
}

/** Файл контекста с оценкой объёма. */
export interface ContextFile {
  readonly path: string;
  readonly kind: 'general' | 'module' | 'spec' | 'adr';
  /** Модуль — для `context.md`, домен — для спеки. */
  readonly owner: string | null;
  readonly lines: number;
  /** Оценка числа токенов. */
  readonly tokens: number;
  /** Коэффициент полезности и из чего он сложился. */
  readonly usefulness: ContextUsefulness;
  /** Антипаттерны по токенам; у недействующего ADR не ищутся. */
  readonly antipatterns: readonly TokenAntipattern[];
  /** Сколько токенов можно сэкономить, исправив антипаттерны, — не больше `tokens`. */
  readonly savableTokens: number;
}

/** Ссылка из текста контекста на путь в проекте. */
export interface ContextReference {
  /** Файл, в котором ссылка. */
  readonly path: string;
  readonly line: number;
  readonly target: string;
  readonly kind: 'link' | 'code';
  /** Путь найден от файла, от корня или от путей кода модуля. */
  readonly resolved: boolean;
}

/** Связь модуля с доменом. */
export interface ModuleDomainLink {
  readonly module: string;
  readonly domain: string;
  /** Спека домена существует. */
  readonly resolved: boolean;
}

/** Зависимость модуля от модуля. */
export interface ModuleDependency {
  readonly from: string;
  readonly to: string;
  /** Модуль-цель описан. */
  readonly resolved: boolean;
  /** Ребро входит в цикл зависимостей. */
  readonly cyclic: boolean;
}

/** Ссылка ADR на модуль или домен. */
export interface AdrLink {
  readonly adr: string;
  readonly target: string;
  readonly kind: 'module' | 'domain';
  readonly resolved: boolean;
}

export type ContextIssueKind =
  | 'missing-index'
  | 'missing-context'
  | 'bad-frontmatter'
  | 'bad-field'
  | 'duplicate-module'
  | 'unknown-domain'
  | 'unknown-module'
  | 'self-dependency'
  | 'dependency-cycle'
  | 'missing-code-path'
  | 'uncovered-domain'
  | 'large-file'
  | 'over-budget'
  | 'empty-context'
  | 'duplicate-text'
  | 'unused-file'
  | 'broken-reference'
  | 'stale-context'
  | 'no-code-paths'
  | 'low-usefulness'
  | TokenAntipatternKind;

/** Замечание к контексту. */
export interface ContextIssue {
  readonly kind: ContextIssueKind;
  /** `info` — сведение: не ошибка, но стоит знать. */
  readonly severity: 'error' | 'warning' | 'info';
  /** Файл, к которому относится замечание. */
  readonly path: string;
  /** Строка в файле (с 1); `null` — весь файл. */
  readonly line: number | null;
  readonly message: string;
  readonly module?: string;
  readonly domain?: string;
}

export interface ContextMap {
  /** Есть ли папка модулей или ADR — иначе контекст не заведён. */
  readonly configured: boolean;
  readonly general: readonly string[];
  readonly modules: readonly ContextModule[];
  readonly domains: readonly ContextDomain[];
  readonly adrs: readonly ContextAdr[];
  readonly links: readonly ModuleDomainLink[];
  readonly dependencies: readonly ModuleDependency[];
  readonly adrLinks: readonly AdrLink[];
  readonly issues: readonly ContextIssue[];
  /** Файлы контекста с оценкой объёма — те, чей текст прочитан. */
  readonly files: readonly ContextFile[];
  /** Оценка токенов всех файлов контекста. */
  readonly totalTokens: number;
  /** Полезные токены всех файлов контекста. */
  readonly usefulTokens: number;
  /** Токены, которые можно сэкономить, исправив антипаттерны во всех файлах. */
  readonly savableTokens: number;
  /** Абзацы, повторяющиеся в общем контексте, `context.md` и ADR. */
  readonly duplicates: readonly ContextDuplicate[];
  /** Пути, на которые ссылаются тексты контекста. */
  readonly references: readonly ContextReference[];
  /** Файлы в `openspec/context/`, которые не входят ни в один набор. */
  readonly unusedFiles: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Путь спеки домена. */
export function specPathOf(domain: string): string {
  return `${SPECS_DIR}/${domain}/spec.md`;
}

/** Путь файла модуля. */
export function modulePath(folder: string, file: string): string {
  return `${MODULES_DIR}/${folder}/${file}`;
}

/**
 * Список строк из поля frontmatter: YAML-список или одна строка. Пустые и
 * повторяющиеся значения отбрасываются.
 */
function readList(
  value: unknown,
  field: string,
  path: string,
  line: number | null,
  issues: ContextIssue[],
  extra: Pick<ContextIssue, 'module'>,
): string[] {
  if (value === undefined || value === null) return [];
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (items === null || !items.every((item) => typeof item === 'string' || typeof item === 'number')) {
    issues.push({
      kind: 'bad-field',
      severity: 'error',
      path,
      line,
      message: `Поле ${field} должно быть списком строк, например ${field}: [a, b]`,
      ...extra,
    });
    return [];
  }
  return [...new Set(items.map((item) => String(item).trim()).filter((item) => item !== ''))];
}

function readText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

/** Путь домена из ссылки: без `openspec/specs/`, `/spec.md` и крайних `/`. */
export function normalizeDomain(reference: string): string {
  let domain = reference.trim().replace(/\\/g, '/');
  if (domain.startsWith(`${SPECS_DIR}/`)) domain = domain.slice(SPECS_DIR.length + 1);
  if (domain.startsWith('specs/')) domain = domain.slice('specs/'.length);
  if (domain.endsWith('/spec.md')) domain = domain.slice(0, -'/spec.md'.length);
  return domain.replace(/^\/+|\/+$/g, '');
}

interface ParsedModule {
  readonly id: string;
  readonly folder: string;
  readonly description: string | null;
  readonly domains: readonly string[];
  readonly dependsOn: readonly string[];
  readonly codePaths: readonly CodePath[];
  readonly hasIndex: boolean;
  readonly hasContext: boolean;
  readonly lineOf: KeyLine;
  readonly indexPath: string;
  readonly maxTokens: number | null;
  readonly freshness: ModuleFreshness | null;
  /** Frontmatter `index.md` разобран: поля модуля известны. */
  readonly described: boolean;
}

/** Бюджет из `max_tokens`: положительное целое, в том числе строкой `20 000`. */
function readBudget(value: unknown): number | null | 'bad' {
  if (value === undefined || value === null) return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d[\d\s_]*$/.test(value.trim()) ? Number(value.replace(/[\s_]/g, '')) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? number : 'bad';
}

function parseModule(source: ModuleSource, issues: ContextIssue[]): ParsedModule {
  const indexPath = modulePath(source.folder, MODULE_INDEX_FILE);
  const fallback: ParsedModule = {
    id: source.folder,
    folder: source.folder,
    description: null,
    domains: [],
    dependsOn: [],
    codePaths: [],
    hasIndex: source.hasIndex,
    hasContext: source.hasContext,
    lineOf: source.lineOf,
    indexPath,
    maxTokens: null,
    freshness: source.freshness ?? null,
    described: false,
  };

  if (!source.hasIndex) {
    issues.push({
      kind: 'missing-index',
      severity: 'error',
      path: `${MODULES_DIR}/${source.folder}`,
      line: null,
      message: `У модуля ${source.folder} нет ${MODULE_INDEX_FILE} — связи модуля неизвестны`,
      module: source.folder,
    });
    return fallback;
  }
  if (source.frontmatterError !== null) {
    issues.push({
      kind: 'bad-frontmatter',
      severity: 'error',
      path: indexPath,
      line: source.frontmatterError.line,
      message: `Frontmatter не разбирается как YAML: ${source.frontmatterError.message}`,
      module: source.folder,
    });
    return fallback;
  }
  if (!isRecord(source.frontmatter)) {
    issues.push({
      kind: 'bad-frontmatter',
      severity: 'error',
      path: indexPath,
      line: 1,
      message: 'Нет frontmatter: в начале index.md нужен блок --- с полями module, description, domains, depends_on',
      module: source.folder,
    });
    return fallback;
  }

  const meta = source.frontmatter;
  const id = readText(meta['module']) ?? source.folder;
  const extra = { module: id };
  const domains = readList(meta['domains'], 'domains', indexPath, source.lineOf('domains'), issues, extra).map(
    normalizeDomain,
  );
  const dependsOn = readList(
    meta['depends_on'],
    'depends_on',
    indexPath,
    source.lineOf('depends_on'),
    issues,
    extra,
  );
  const codePaths = readList(meta['code_paths'], 'code_paths', indexPath, source.lineOf('code_paths'), issues, extra).map(
    (path) => ({ path, exists: source.existingCodePaths.has(path) }),
  );
  let maxTokens = readBudget(meta['max_tokens']);
  if (maxTokens === 'bad') {
    issues.push({
      kind: 'bad-field',
      severity: 'error',
      path: indexPath,
      line: source.lineOf('max_tokens'),
      message: 'Поле max_tokens должно быть положительным целым числом — бюджетом набора модуля в токенах, например max_tokens: 20000',
      module: id,
    });
    maxTokens = null;
  }

  return {
    id,
    folder: source.folder,
    description: readText(meta['description']),
    domains: [...new Set(domains.filter((domain) => domain !== ''))],
    dependsOn,
    codePaths,
    hasIndex: true,
    hasContext: source.hasContext,
    lineOf: source.lineOf,
    indexPath,
    maxTokens,
    freshness: source.freshness ?? null,
    described: true,
  };
}

/** Рёбра, входящие в циклы зависимостей (алгоритм Тарьяна). */
function cyclicEdges(nodes: readonly string[], edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const component = new Map<string, number>();
  let components = 0;

  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) === index.get(node)) {
      for (;;) {
        const top = stack.pop();
        if (top === undefined) break;
        onStack.delete(top);
        component.set(top, components);
        if (top === node) break;
      }
      components += 1;
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);

  const sizes = new Map<number, number>();
  for (const id of component.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
  const cyclic = new Set<string>();
  for (const [from, targets] of edges) {
    for (const to of targets) {
      const a = component.get(from);
      if (a !== undefined && a === component.get(to) && (sizes.get(a) ?? 0) > 1) cyclic.add(`${from}\u0000${to}`);
    }
  }
  return cyclic;
}

const byName = (a: string, b: string): number => a.localeCompare(b);

/** Строит карту контекста и собирает замечания. */
export function buildContextMap(input: ContextMapInput): ContextMap {
  const issues: ContextIssue[] = [];
  const knownDomains = new Set(input.domains);

  // Модули.
  const parsed = [...input.modules]
    .sort((a, b) => byName(a.folder, b.folder))
    .map((source) => parseModule(source, issues));
  const modules = new Map<string, ParsedModule>();
  for (const module of parsed) {
    const previous = modules.get(module.id);
    if (previous !== undefined) {
      issues.push({
        kind: 'duplicate-module',
        severity: 'error',
        path: module.indexPath,
        line: module.lineOf('module'),
        message: `Модуль ${module.id} уже описан в ${previous.indexPath} — идентификаторы модулей должны быть уникальны`,
        module: module.id,
      });
      continue;
    }
    modules.set(module.id, module);
  }

  // Связи модуль → домен и модуль → модуль.
  const links: ModuleDomainLink[] = [];
  const edges = new Map<string, string[]>();
  for (const module of modules.values()) {
    if (module.hasIndex && !module.hasContext) {
      issues.push({
        kind: 'missing-context',
        severity: 'warning',
        path: module.indexPath,
        line: null,
        message: `У модуля ${module.id} нет ${MODULE_CONTEXT_FILE} — загружать в контекст нечего`,
        module: module.id,
      });
    }
    for (const domain of module.domains) {
      const resolved = knownDomains.has(domain);
      links.push({ module: module.id, domain, resolved });
      if (!resolved) {
        issues.push({
          kind: 'unknown-domain',
          severity: 'error',
          path: module.indexPath,
          line: module.lineOf('domains'),
          message: `Домен ${domain} модуля ${module.id} не найден: нет ${specPathOf(domain)}`,
          module: module.id,
          domain,
        });
      }
    }
    const targets: string[] = [];
    for (const target of module.dependsOn) {
      if (target === module.id) {
        issues.push({
          kind: 'self-dependency',
          severity: 'error',
          path: module.indexPath,
          line: module.lineOf('depends_on'),
          message: `Модуль ${module.id} зависит сам от себя`,
          module: module.id,
        });
        continue;
      }
      targets.push(target);
      if (!modules.has(target)) {
        issues.push({
          kind: 'unknown-module',
          severity: 'error',
          path: module.indexPath,
          line: module.lineOf('depends_on'),
          message: `Модуль ${target} из depends_on модуля ${module.id} не описан в ${MODULES_DIR}/`,
          module: module.id,
        });
      }
    }
    edges.set(module.id, targets);
    for (const codePath of module.codePaths) {
      if (codePath.exists) continue;
      issues.push({
        kind: 'missing-code-path',
        severity: 'warning',
        path: module.indexPath,
        line: module.lineOf('code_paths'),
        message: `Путь кода ${codePath.path} модуля ${module.id} не найден в рабочем пространстве`,
        module: module.id,
      });
    }
  }

  const cyclic = cyclicEdges([...modules.keys()], edges);
  const dependencies: ModuleDependency[] = [];
  const reportedCycle = new Set<string>();
  for (const [from, targets] of edges) {
    for (const to of targets) {
      const isCyclic = cyclic.has(`${from}\u0000${to}`);
      dependencies.push({ from, to, resolved: modules.has(to), cyclic: isCyclic });
      if (isCyclic && !reportedCycle.has(from)) {
        reportedCycle.add(from);
        const module = modules.get(from);
        issues.push({
          kind: 'dependency-cycle',
          severity: 'error',
          path: module?.indexPath ?? MODULES_DIR,
          line: module?.lineOf('depends_on') ?? null,
          message: `Модуль ${from} входит в цикл зависимостей (через ${to})`,
          module: from,
        });
      }
    }
  }

  // ADR.
  const adrs: ContextAdr[] = [];
  const adrLinks: AdrLink[] = [];
  for (const source of [...input.adrs].sort((a, b) => byName(a.path, b.path))) {
    const id = (source.path.split('/').pop() ?? source.path).replace(/\.md$/i, '');
    if (source.frontmatterError !== null) {
      issues.push({
        kind: 'bad-frontmatter',
        severity: 'error',
        path: source.path,
        line: source.frontmatterError.line,
        message: `Frontmatter ADR не разбирается как YAML: ${source.frontmatterError.message}`,
      });
    }
    const meta = isRecord(source.frontmatter) ? source.frontmatter : {};
    const moduleRefs = readList(meta['modules'], 'modules', source.path, source.lineOf('modules'), issues, {});
    const domainRefs = readList(meta['domains'], 'domains', source.path, source.lineOf('domains'), issues, {})
      .map(normalizeDomain)
      .filter((domain) => domain !== '');
    for (const target of moduleRefs) {
      const resolved = modules.has(target);
      adrLinks.push({ adr: source.path, target, kind: 'module', resolved });
      if (!resolved) {
        issues.push({
          kind: 'unknown-module',
          severity: 'error',
          path: source.path,
          line: source.lineOf('modules'),
          message: `ADR ${id} ссылается на неописанный модуль ${target}`,
        });
      }
    }
    for (const target of domainRefs) {
      const resolved = knownDomains.has(target);
      adrLinks.push({ adr: source.path, target, kind: 'domain', resolved });
      if (!resolved) {
        issues.push({
          kind: 'unknown-domain',
          severity: 'error',
          path: source.path,
          line: source.lineOf('domains'),
          message: `ADR ${id} ссылается на домен ${target}, а ${specPathOf(target)} нет`,
          domain: target,
        });
      }
    }
    adrs.push({
      path: source.path,
      id,
      title: readText(meta['title']) ?? source.heading ?? id,
      status: readText(meta['status']),
      active: isActiveAdrStatus(readText(meta['status'])),
      modules: moduleRefs,
      domains: domainRefs,
    });
  }

  // Домены: все спеки и те, на которые ссылаются, но спеки нет.
  const domainIds = new Set<string>([
    ...input.domains,
    ...links.map((link) => link.domain),
    ...adrLinks.filter((link) => link.kind === 'domain').map((link) => link.target),
  ]);
  const domains: ContextDomain[] = [...domainIds].sort(byName).map((id) => ({
    id,
    specPath: knownDomains.has(id) ? specPathOf(id) : null,
    modules: links.filter((link) => link.domain === id).map((link) => link.module).sort(byName),
    adrs: adrLinks.filter((link) => link.kind === 'domain' && link.target === id).map((link) => link.adr),
  }));

  const configured = input.modules.length > 0 || input.adrs.length > 0;
  if (configured && modules.size > 0) {
    for (const domain of domains) {
      if (domain.specPath === null || domain.modules.length > 0) continue;
      issues.push({
        kind: 'uncovered-domain',
        severity: 'warning',
        path: domain.specPath,
        line: null,
        message: `Домен ${domain.id} не относится ни к одному модулю: добавьте его в domains нужного index.md`,
        domain: domain.id,
      });
    }
  }

  const sizes = contextFiles(input, modules, domains, adrs);
  const control = controlIssues(input, modules, adrs, sizes, issues);
  const files = withAntipatterns(input, adrs, withUsefulness(input, modules, sizes, control, issues), issues);

  const contextModules: ContextModule[] = [...modules.values()].map((module) => ({
    id: module.id,
    folder: module.folder,
    description: module.description,
    indexPath: module.indexPath,
    hasIndex: module.hasIndex,
    contextPath: module.hasContext ? modulePath(module.folder, MODULE_CONTEXT_FILE) : null,
    domains: module.domains,
    dependsOn: module.dependsOn.filter((target) => target !== module.id),
    codePaths: module.codePaths,
    dependents: dependencies.filter((edge) => edge.to === module.id).map((edge) => edge.from).sort(byName),
    adrs: adrLinks.filter((link) => link.kind === 'module' && link.target === module.id).map((link) => link.adr),
    maxTokens: module.maxTokens,
    bundleTokens: 0,
    bundleUsefulTokens: 0,
    freshness: module.freshness,
  }));

  const map: ContextMap = {
    configured,
    general: [...input.general].sort(byName),
    modules: contextModules,
    domains,
    adrs,
    links,
    dependencies,
    adrLinks,
    issues,
    files,
    totalTokens: files.reduce((sum, file) => sum + file.tokens, 0),
    usefulTokens: files.reduce((sum, file) => sum + file.usefulness.usefulTokens, 0),
    savableTokens: files.reduce((sum, file) => sum + file.savableTokens, 0),
    duplicates: control.duplicates,
    references: control.references,
    unusedFiles: [...(input.unusedFiles ?? [])].sort(byName),
  };
  return withBudgets(map, (id) => modules.get(id)?.lineOf('max_tokens') ?? null);
}

/** Файл контекста с оценкой объёма, но ещё без оценки полезности и антипаттернов. */
type SizedFile = Omit<ContextFile, 'usefulness' | 'antipatterns' | 'savableTokens'>;

/** Файл с оценкой полезности, но ещё без антипаттернов. */
type MeasuredFile = Omit<ContextFile, 'antipatterns' | 'savableTokens'>;

/** Файлы контекста, чей текст прочитан, с оценкой объёма — в порядке набора. */
function contextFiles(
  input: ContextMapInput,
  modules: ReadonlyMap<string, ParsedModule>,
  domains: readonly ContextDomain[],
  adrs: readonly ContextAdr[],
): SizedFile[] {
  const texts = input.texts;
  if (texts === undefined) return [];
  const files: SizedFile[] = [];
  const add = (path: string, kind: ContextFile['kind'], owner: string | null): void => {
    const text = texts.get(path);
    if (text === undefined || files.some((file) => file.path === path)) return;
    files.push({ path, kind, owner, lines: countLines(text), tokens: estimateTokens(text) });
  };
  for (const path of [...input.general].sort(byName)) add(path, 'general', null);
  for (const module of modules.values()) {
    if (module.hasContext) add(modulePath(module.folder, MODULE_CONTEXT_FILE), 'module', module.id);
  }
  for (const domain of domains) if (domain.specPath !== null) add(domain.specPath, 'spec', domain.id);
  for (const adr of adrs) add(adr.path, 'adr', null);
  return files;
}

/**
 * Замечания контроля контекста: объём, лишнее и связь с реальностью.
 * Добавляются в `issues` после замечаний о связях.
 */
function controlIssues(
  input: ContextMapInput,
  modules: ReadonlyMap<string, ParsedModule>,
  adrs: readonly ContextAdr[],
  files: readonly SizedFile[],
  issues: ContextIssue[],
): { duplicates: ContextDuplicate[]; references: ContextReference[] } {
  const texts = input.texts ?? new Map<string, string>();
  const moduleOf = new Map<string, ParsedModule>();
  for (const module of modules.values()) {
    if (module.hasContext) moduleOf.set(modulePath(module.folder, MODULE_CONTEXT_FILE), module);
  }
  const owner = (path: string): Pick<ContextIssue, 'module'> => {
    const id = moduleOf.get(path)?.id;
    return id === undefined ? {} : { module: id };
  };

  // Объём.
  for (const file of files) {
    if (file.tokens <= LARGE_FILE_TOKENS) continue;
    issues.push({
      kind: 'large-file',
      severity: 'warning',
      path: file.path,
      line: null,
      message: `Файл контекста ≈ ${file.tokens} токенов — больше ${LARGE_FILE_TOKENS}: разделите его или вынесите подробности туда, где их прочитают по необходимости`,
      ...owner(file.path),
      ...(file.kind === 'spec' && file.owner !== null ? { domain: file.owner } : {}),
    });
  }

  // Лишнее: пустой контекст, повторы, файлы вне наборов.
  for (const [path, module] of moduleOf) {
    const text = texts.get(path);
    if (text === undefined || !isEmptyContext(text)) continue;
    issues.push({
      kind: 'empty-context',
      severity: 'warning',
      path,
      line: null,
      message: `${MODULE_CONTEXT_FILE} модуля ${module.id} пуст — кроме заголовков, в набор нечего положить`,
      module: module.id,
    });
  }

  // Тексты, которые пишут люди, — в порядке набора: общий контекст, модули, ADR.
  const prose = [
    ...[...input.general].sort(byName),
    ...moduleOf.keys(),
    ...adrs.map((adr) => adr.path),
  ].flatMap((path) => {
    const text = texts.get(path);
    return text === undefined ? [] : [{ path, text }];
  });

  const duplicates = findDuplicates(prose);
  for (const duplicate of duplicates) {
    const [first, ...repeats] = duplicate.occurrences;
    if (first === undefined) continue;
    for (const repeat of repeats) {
      issues.push({
        kind: 'duplicate-text',
        severity: 'warning',
        path: repeat.path,
        line: repeat.line,
        message: `Абзац повторяет ${first.path}:${first.line} — в наборе он займёт ≈ ${duplicate.tokens} токенов лишний раз, а копии со временем разойдутся`,
        ...owner(repeat.path),
      });
    }
  }

  for (const path of [...(input.unusedFiles ?? [])].sort(byName)) {
    issues.push({
      kind: 'unused-file',
      severity: 'warning',
      path,
      line: null,
      message: `Файл не входит ни в один набор контекста — агент его не увидит. Перенесите нужное в ${MODULE_CONTEXT_FILE} или общий контекст ${CONTEXT_DIR}/*.md, лишнее удалите`,
    });
  }

  // Связь с реальностью: пути в тексте, отставание от кода, модули без кода.
  const references: ContextReference[] = [];
  const existing = input.existingPaths;
  if (existing !== undefined) {
    // Недействующий ADR — история: пути в нём и должны были исчезнуть.
    const inactive = new Set(adrs.filter((adr) => !adr.active).map((adr) => adr.path));
    for (const { path, text } of prose) {
      if (inactive.has(path)) continue;
      const codePaths = moduleOf.get(path)?.codePaths.map((code) => code.path) ?? [];
      for (const { reference, candidates } of textReferenceCandidates(text, path, codePaths)) {
        const resolved = candidates.some((candidate) => existing.has(candidate));
        references.push({ path, line: reference.line, target: reference.target, kind: reference.kind, resolved });
        if (resolved) continue;
        issues.push({
          kind: 'broken-reference',
          severity: 'warning',
          path,
          line: reference.line,
          message: `Путь ${reference.target} не найден ни от файла, ни от корня проекта${codePaths.length > 0 ? ', ни от путей кода модуля' : ''} — контекст описывает то, чего уже нет`,
          ...owner(path),
        });
      }
    }
  }

  for (const module of modules.values()) {
    const freshness = module.freshness;
    if (freshness !== null && module.hasContext && freshness.commitsAfter > 0) {
      issues.push({
        kind: 'stale-context',
        severity: 'info',
        path: modulePath(module.folder, MODULE_CONTEXT_FILE),
        line: null,
        message:
          `Контекст модуля ${module.id} отстаёт от кода: после последней правки ${MODULE_CONTEXT_FILE}` +
          `${freshness.contextDate === null ? '' : ` (${freshness.contextDate.slice(0, 10)})`} в путях кода ` +
          `${freshness.commitsAfter} ${commitsWord(freshness.commitsAfter)} — проверьте, что описание актуально`,
        module: module.id,
      });
    }
    if (module.described && module.codePaths.length === 0) {
      issues.push({
        kind: 'no-code-paths',
        severity: 'info',
        path: module.indexPath,
        line: module.lineOf('code_paths'),
        message: `Модуль ${module.id} не привязан к коду: без code_paths не проверить ни пути в контексте, ни его отставание от кода`,
        module: module.id,
      });
    }
  }

  return { duplicates, references };
}

/**
 * Коэффициент полезности каждого файла — по повторам и битым путям, которые
 * нашёл контроль, и по свежести модуля; сведение о низкой полезности.
 */
function withUsefulness(
  input: ContextMapInput,
  modules: ReadonlyMap<string, ParsedModule>,
  files: readonly SizedFile[],
  control: { readonly duplicates: readonly ContextDuplicate[]; readonly references: readonly ContextReference[] },
  issues: ContextIssue[],
): MeasuredFile[] {
  const texts = input.texts ?? new Map<string, string>();
  const linesOf = (map: Map<string, Set<number>>, path: string, line: number): void => {
    const set = map.get(path) ?? new Set<number>();
    set.add(line);
    map.set(path, set);
  };
  const repeats = new Map<string, Set<number>>();
  for (const duplicate of control.duplicates) {
    for (const place of duplicate.occurrences.slice(1)) linesOf(repeats, place.path, place.line);
  }
  const broken = new Map<string, Set<number>>();
  for (const reference of control.references) if (!reference.resolved) linesOf(broken, reference.path, reference.line);
  const moduleOf = new Map<string, ParsedModule>();
  for (const module of modules.values()) {
    if (module.hasContext) moduleOf.set(modulePath(module.folder, MODULE_CONTEXT_FILE), module);
  }

  return files.map((file) => {
    const module = file.kind === 'module' ? moduleOf.get(file.path) : undefined;
    const freshness = module?.freshness ?? null;
    const usefulness = measureUsefulness(texts.get(file.path) ?? '', {
      duplicateLines: repeats.get(file.path) ?? new Set(),
      brokenLines: broken.get(file.path) ?? new Set(),
      grounding: file.kind === 'module',
      commitsAfter: freshness === null ? null : freshness.uncommitted ? 0 : freshness.commitsAfter,
    });
    if (usefulness.tokens >= USEFULNESS_MIN_TOKENS && usefulness.ballast.empty === 0 && usefulness.score < LOW_USEFULNESS) {
      issues.push({
        kind: 'low-usefulness',
        severity: 'info',
        path: file.path,
        line: null,
        message: usefulnessMessage(usefulness),
        ...(module === undefined ? {} : { module: module.id }),
        ...(file.kind === 'spec' && file.owner !== null ? { domain: file.owner } : {}),
      });
    }
    return { ...file, usefulness };
  });
}

/**
 * Антипаттерны по токенам в каждом файле, кроме недействующих ADR: они не
 * входят в набор, и токенов агента не тратят. Каждая находка — сведение.
 */
function withAntipatterns(
  input: ContextMapInput,
  adrs: readonly ContextAdr[],
  files: readonly MeasuredFile[],
  issues: ContextIssue[],
): ContextFile[] {
  const texts = input.texts ?? new Map<string, string>();
  const inactive = new Set(adrs.filter((adr) => !adr.active).map((adr) => adr.path));
  return files.map((file) => {
    const antipatterns = inactive.has(file.path) ? [] : findTokenAntipatterns(texts.get(file.path) ?? '');
    for (const found of antipatterns) {
      issues.push({
        kind: found.kind,
        severity: 'info',
        path: file.path,
        line: found.line,
        message: antipatternMessage(found, file.tokens),
        ...(file.kind === 'module' && file.owner !== null ? { module: file.owner } : {}),
        ...(file.kind === 'spec' && file.owner !== null ? { domain: file.owner } : {}),
      });
    }
    return { ...file, antipatterns, savableTokens: antipatternSavings(antipatterns, file.tokens) };
  });
}

/** Процент для сообщений: `0.427` → `43 %`. */
function percent(value: number): string {
  return `${Math.round(value * 100)} %`;
}

/** Сведение о низкой полезности: коэффициент и то, что его снизило. */
function usefulnessMessage(usefulness: ContextUsefulness): string {
  const { ballast } = usefulness;
  const parts = [
    ballast.duplicate > 0 ? `повторы ≈ ${ballast.duplicate}` : null,
    ballast.placeholder > 0 ? `заготовки ≈ ${ballast.placeholder}` : null,
    ballast.broken > 0 ? `абзацы с ненайденными путями ≈ ${ballast.broken}` : null,
  ].filter((part): part is string => part !== null);
  const reasons = [
    parts.length > 0 ? `балласт: ${parts.join(', ')} токенов` : null,
    usefulness.grounding !== null && usefulness.grounding < 0.5 ? `привязка к коду ${percent(usefulness.grounding)}` : null,
    usefulness.freshness !== null && usefulness.freshness < 1 ? `отставание от кода — множитель ${usefulness.freshness.toFixed(2).replace('.', ',')}` : null,
  ].filter((part): part is string => part !== null);
  return (
    `Полезная доля файла ≈ ${percent(usefulness.score)} из ≈ ${usefulness.tokens} токенов` +
    (reasons.length > 0 ? ` — ${reasons.join('; ')}` : '') +
    ': уберите повторы и заготовки, исправьте пути, привяжите описание к коду'
  );
}

function commitsWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return 'коммитов';
  if (ones === 1) return 'коммит';
  if (ones >= 2 && ones <= 4) return 'коммита';
  return 'коммитов';
}

/** Оценка набора каждого модуля и предупреждения о превышении бюджета. */
function withBudgets(map: ContextMap, budgetLine: (module: string) => number | null): ContextMap {
  const issues = [...map.issues];
  const modules = map.modules.map((module) => {
    const { tokens: bundleTokens, usefulTokens: bundleUsefulTokens } = contextBundle(map, { modules: [module.id] });
    if (module.maxTokens !== null && bundleTokens > module.maxTokens) {
      issues.push({
        kind: 'over-budget',
        severity: 'warning',
        path: module.indexPath,
        line: budgetLine(module.id),
        message: `Набор контекста модуля ${module.id} ≈ ${bundleTokens} токенов — больше бюджета max_tokens: ${module.maxTokens}`,
        module: module.id,
      });
    }
    return { ...module, bundleTokens, bundleUsefulTokens };
  });
  return { ...map, modules, issues };
}

/** Что выбрано для набора контекста: модули, домены и ADR по идентификаторам. */
export interface ContextSelection {
  readonly modules?: readonly string[];
  readonly domains?: readonly string[];
  /** Пути ADR — они же их идентификаторы на карте. */
  readonly adrs?: readonly string[];
}

/** Что добавлять к выбранному при сборке набора. */
export interface ContextBundleOptions {
  /** Транзитивные зависимости выбранных модулей по `depends_on`; по умолчанию — да. */
  readonly dependencies?: boolean;
  /** Спеки доменов модулей набора; по умолчанию — да. */
  readonly moduleDomains?: boolean;
  /**
   * Недействующие ADR (`superseded`, `deprecated`…) модулей и доменов набора;
   * по умолчанию — нет. Явно выбранный ADR входит в набор всегда.
   */
  readonly inactiveAdrs?: boolean;
}

/** Набор файлов контекста для работы над модулями и доменами. */
export interface ContextBundle {
  /** Модули набора: выбранные и их зависимости по `depends_on`, в порядке обхода. */
  readonly modules: readonly string[];
  /** Домены набора: домены модулей, затем выбранные. */
  readonly domains: readonly string[];
  /** ADR набора — пути файлов. */
  readonly adrs: readonly string[];
  /** Файлы в порядке загрузки: общий контекст, модули, спеки доменов, ADR. */
  readonly files: readonly string[];
  /** Недействующие ADR, которые относятся к набору, но в него не вошли. */
  readonly skippedAdrs: readonly string[];
  /** Оценка токенов набора — по файлам, чей объём известен карте. */
  readonly tokens: number;
  /** Полезные токены набора — по коэффициентам полезности файлов. */
  readonly usefulTokens: number;
}

/**
 * Собирает контекст по выбору: модули (и транзитивно их зависимости), спеки
 * их доменов и выбранных доменов, ADR, которые ссылаются на модули набора или
 * на выбранные домены, и выбранные ADR. Циклы и неописанные модули не
 * мешают: каждый модуль берётся один раз, неизвестные пропускаются; каждый
 * файл входит в набор один раз.
 */
export function contextBundle(
  map: ContextMap,
  selection: ContextSelection,
  options: ContextBundleOptions = {},
): ContextBundle {
  const withDependencies = options.dependencies ?? true;
  const withModuleDomains = options.moduleDomains ?? true;
  const withInactiveAdrs = options.inactiveAdrs ?? false;
  const byId = new Map(map.modules.map((module) => [module.id, module]));

  const order: string[] = [];
  const queue = [...(selection.modules ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const module = byId.get(id);
    if (module === undefined) continue;
    order.push(id);
    if (withDependencies) queue.push(...module.dependsOn);
  }

  const specs = new Map(map.domains.map((domain) => [domain.id, domain.specPath]));
  const domains: string[] = [];
  const addDomain = (id: string): void => {
    if (specs.has(id) && !domains.includes(id)) domains.push(id);
  };
  if (withModuleDomains) {
    for (const id of order) for (const domain of byId.get(id)?.domains ?? []) addDomain(domain);
  }
  const chosenDomains = new Set(selection.domains ?? []);
  for (const id of chosenDomains) addDomain(id);

  const chosenAdrs = new Set(selection.adrs ?? []);
  const inOrder = new Set(order);
  const related = map.adrs.filter(
    (adr) =>
      chosenAdrs.has(adr.path) || adr.modules.some((id) => inOrder.has(id)) || adr.domains.some((id) => chosenDomains.has(id)),
  );
  // Карта, собранная до появления статусов, их не знает — такие ADR действуют.
  const takes = (adr: ContextAdr): boolean => withInactiveAdrs || adr.active !== false || chosenAdrs.has(adr.path);
  const adrs = related.filter(takes).map((adr) => adr.path);
  const skippedAdrs = related.filter((adr) => !takes(adr)).map((adr) => adr.path);

  const files: string[] = [...map.general];
  const add = (path: string | null | undefined): void => {
    if (path !== null && path !== undefined && !files.includes(path)) files.push(path);
  };
  for (const id of order) add(byId.get(id)?.contextPath);
  for (const id of domains) add(specs.get(id));
  for (const path of adrs) add(path);
  const known = new Map((map.files ?? []).map((file) => [file.path, file]));
  const tokens = files.reduce((sum, path) => sum + (known.get(path)?.tokens ?? 0), 0);
  // Карта старше оценки полезности её не знает — тогда полезным считается весь объём.
  const usefulTokens = files.reduce((sum, path) => {
    const file = known.get(path);
    return sum + (file === undefined ? 0 : ((file.usefulness as ContextUsefulness | undefined)?.usefulTokens ?? file.tokens));
  }, 0);
  return { modules: order, domains, adrs, files, skippedAdrs, tokens, usefulTokens };
}
