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
 */

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
  readonly modules: readonly string[];
  readonly domains: readonly string[];
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
  | 'uncovered-domain';

/** Замечание к контексту. */
export interface ContextIssue {
  readonly kind: ContextIssueKind;
  readonly severity: 'error' | 'warning';
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
  }));

  return {
    configured,
    general: [...input.general].sort(byName),
    modules: contextModules,
    domains,
    adrs,
    links,
    dependencies,
    adrLinks,
    issues,
  };
}

/** Набор файлов контекста для работы над модулем. */
export interface ContextBundle {
  /** Модуль и все его зависимости по `depends_on`, в порядке обхода. */
  readonly modules: readonly string[];
  /** Файлы в порядке загрузки: общий контекст, модули, спеки доменов, ADR. */
  readonly files: readonly string[];
}

/**
 * Собирает контекст модуля: сам модуль, транзитивно его зависимости,
 * спеки их доменов и относящиеся к ним ADR. Циклы и неописанные модули не
 * мешают: каждый модуль берётся один раз, неизвестные пропускаются.
 */
export function contextBundle(map: ContextMap, moduleId: string): ContextBundle {
  const byId = new Map(map.modules.map((module) => [module.id, module]));
  const order: string[] = [];
  const queue = [moduleId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const module = byId.get(id);
    if (module === undefined) continue;
    order.push(id);
    queue.push(...module.dependsOn);
  }

  const files: string[] = [...map.general];
  const add = (path: string | null): void => {
    if (path !== null && !files.includes(path)) files.push(path);
  };
  const specs = new Map(map.domains.map((domain) => [domain.id, domain.specPath]));
  for (const id of order) {
    const module = byId.get(id);
    add(module?.contextPath ?? null);
  }
  for (const id of order) {
    for (const domain of byId.get(id)?.domains ?? []) add(specs.get(domain) ?? null);
  }
  for (const adr of map.adrs) {
    if (adr.modules.some((id) => seen.has(id) && byId.has(id))) add(adr.path);
  }
  return { modules: order, files };
}
