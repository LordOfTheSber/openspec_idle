/**
 * Модули монорепозитория: карта `openspec/modules.yaml`, принадлежность
 * спеков и changes модулям, граф зависимостей и затронутые потребители.
 *
 * Понятия «модуль» у OpenSpec нет. Карта — знание команды о репозитории,
 * которое IDE накладывает на пути capability.
 */

export const MODULE_KINDS = ['service', 'ui', 'library'] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export const MODULE_KIND_LABEL: Readonly<Record<ModuleKind, string>> = {
  service: 'Сервис',
  ui: 'UI',
  library: 'Библиотека',
};

/** Модуль карты после проверки. */
export interface ModuleDef {
  readonly id: string;
  readonly title: string;
  readonly kind: ModuleKind;
  /** Каталог кода относительно корня репозитория; `null` — не задан. */
  readonly path: string | null;
  /** Префикс путей capability модуля. */
  readonly specs: string;
  readonly group: string | null;
  /** Зависимости — только известные модули карты. */
  readonly dependsOn: readonly string[];
}

/** Ошибка карты: модуль (или вся карта) и поле. */
export interface ModuleProblem {
  /** `null` — ошибка карты целиком. */
  readonly module: string | null;
  readonly field: string;
  readonly message: string;
}

export interface ModuleMap {
  readonly modules: readonly ModuleDef[];
  readonly problems: readonly ModuleProblem[];
  /** Циклы зависимостей, каждый — перечень модулей по кругу. */
  readonly cycles: readonly (readonly string[])[];
  /** Шаблоны путей тестовых файлов; `null` — по умолчанию. */
  readonly testPatterns: readonly string[] | null;
}

export const EMPTY_MODULE_MAP: ModuleMap = { modules: [], problems: [], cycles: [], testPatterns: null };

const ID = /^[\w.-]+(?:\/[\w.-]+)*$/;

/**
 * Проверяет разобранный YAML карты. Ошибка одного модуля не ломает
 * остальные: модуль без идентификатора или с повтором пропускается, прочие
 * ошибки исправляются мягко (неизвестная зависимость отбрасывается) и
 * сообщаются.
 */
export function parseModuleMap(plain: unknown): ModuleMap {
  const problems: ModuleProblem[] = [];
  if (plain === null || plain === undefined) return EMPTY_MODULE_MAP;
  if (typeof plain !== 'object' || Array.isArray(plain)) {
    return { ...EMPTY_MODULE_MAP, problems: [{ module: null, field: 'modules', message: 'Карта модулей должна быть объектом с ключом modules' }] };
  }
  const root = plain as Record<string, unknown>;
  const version = root['version'];
  if (version !== undefined && version !== 1) {
    problems.push({ module: null, field: 'version', message: `Неизвестная версия карты: ${String(version)}; ожидается 1` });
  }
  const rawModules = root['modules'];
  if (rawModules !== undefined && !Array.isArray(rawModules)) {
    problems.push({ module: null, field: 'modules', message: 'Ключ modules должен быть списком' });
  }
  const testPatterns = readStringList(root['tests'], null, 'tests', problems);

  const drafts: Array<ModuleDef & { rawDepends: string[] }> = [];
  const seen = new Set<string>();
  (Array.isArray(rawModules) ? rawModules : []).forEach((raw, index) => {
    const where = `modules[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push({ module: null, field: where, message: 'Модуль должен быть объектом' });
      return;
    }
    const entry = raw as Record<string, unknown>;
    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    if (id === '') {
      problems.push({ module: null, field: `${where}.id`, message: 'У модуля не задан id' });
      return;
    }
    if (!ID.test(id)) {
      problems.push({ module: id, field: 'id', message: `Недопустимый id «${id}»: буквы, цифры, «.», «-», «_» и «/» между сегментами` });
      return;
    }
    if (seen.has(id)) {
      problems.push({ module: id, field: 'id', message: `Модуль ${id} описан дважды; второе описание пропущено` });
      return;
    }
    seen.add(id);

    const title = text(entry['title']);
    if (title === null) problems.push({ module: id, field: 'title', message: 'Не задано название' });

    const kindRaw = text(entry['kind']);
    let kind: ModuleKind = 'service';
    if (kindRaw === null) {
      problems.push({ module: id, field: 'kind', message: 'Не задан вид: service, ui или library' });
    } else if ((MODULE_KINDS as readonly string[]).includes(kindRaw)) {
      kind = kindRaw as ModuleKind;
    } else {
      problems.push({ module: id, field: 'kind', message: `Неизвестный вид «${kindRaw}»: ожидается service, ui или library` });
    }

    const path = text(entry['path']);
    if (path === null) problems.push({ module: id, field: 'path', message: 'Не задан каталог кода' });

    const specsRaw = text(entry['specs']);
    const specs = normalizePrefix(specsRaw ?? id);

    const rawDepends = readStringList(entry['dependsOn'], id, 'dependsOn', problems) ?? [];
    drafts.push({
      id,
      title: title ?? id,
      kind,
      path: path === null ? null : path.replace(/\\/g, '/').replace(/\/+$/, ''),
      specs,
      group: text(entry['group']),
      dependsOn: [],
      rawDepends,
    });
  });

  // Совпадающие префиксы: capability досталась бы двум модулям.
  const owners = new Map<string, string>();
  for (const draft of drafts) {
    const owner = owners.get(draft.specs);
    if (owner === undefined) owners.set(draft.specs, draft.id);
    else {
      problems.push({
        module: draft.id,
        field: 'specs',
        message: `Префикс спеков «${draft.specs}» уже занят модулем ${owner}; спеки достаются ${owner}`,
      });
    }
  }

  const modules: ModuleDef[] = drafts.map(({ rawDepends, ...draft }) => {
    const dependsOn: string[] = [];
    for (const dependency of rawDepends) {
      if (dependency === draft.id) {
        problems.push({ module: draft.id, field: 'dependsOn', message: 'Модуль не может зависеть от самого себя' });
      } else if (!seen.has(dependency)) {
        problems.push({ module: draft.id, field: 'dependsOn', message: `Неизвестный модуль ${dependency}` });
      } else if (!dependsOn.includes(dependency)) {
        dependsOn.push(dependency);
      }
    }
    return { ...draft, dependsOn };
  });

  const cycles = findCycles(modules);
  for (const cycle of cycles) {
    problems.push({
      module: cycle[0] ?? null,
      field: 'dependsOn',
      message: `Цикл зависимостей: ${[...cycle, cycle[0]].join(' → ')}`,
    });
  }

  return { modules, problems, cycles, testPatterns };
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readStringList(
  value: unknown,
  module: string | null,
  field: string,
  problems: ModuleProblem[],
): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    problems.push({ module, field, message: `Поле ${field} должно быть списком` });
    return null;
  }
  const list: string[] = [];
  for (const item of value) {
    const entry = text(item);
    if (entry === null) problems.push({ module, field, message: `В ${field} пустой или не строковый элемент` });
    else list.push(entry);
  }
  return list;
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** Capability принадлежит префиксу по целым сегментам пути. */
export function hasPrefix(path: string, prefix: string): boolean {
  if (prefix === '') return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Модуль capability — самый длинный совпавший префикс; `null` — вне модулей. */
export function capabilityModule(capability: string, modules: readonly ModuleDef[]): string | null {
  let best: ModuleDef | null = null;
  for (const module of modules) {
    if (!hasPrefix(capability, module.specs)) continue;
    // При совпадающих префиксах побеждает первый в карте — как в сообщении об ошибке.
    if (best === null || module.specs.length > best.specs.length) best = module;
  }
  return best?.id ?? null;
}

/**
 * Модули change: модули его дельт и явно перечисленные в `.openspec.yaml`.
 * Порядок — порядок модулей в карте.
 */
export function changeModules(
  deltaCapabilities: readonly string[],
  declared: readonly string[],
  modules: readonly ModuleDef[],
): string[] {
  const ids = new Set<string>();
  for (const capability of deltaCapabilities) {
    const owner = capabilityModule(capability, modules);
    if (owner !== null) ids.add(owner);
  }
  const known = new Set(modules.map((module) => module.id));
  for (const id of declared) if (known.has(id)) ids.add(id);
  return modules.filter((module) => ids.has(module.id)).map((module) => module.id);
}

/** Циклы в графе зависимостей — каждый один раз, начиная с меньшего по порядку карты. */
export function findCycles(modules: readonly ModuleDef[]): string[][] {
  const order = new Map(modules.map((module, index) => [module.id, index]));
  const edges = new Map(modules.map((module) => [module.id, module.dependsOn]));
  const cycles: string[][] = [];
  const keys = new Set<string>();
  const state = new Map<string, 'active' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    state.set(id, 'active');
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const mark = state.get(next);
      if (mark === 'active') {
        const cycle = stack.slice(stack.indexOf(next));
        // Нормализация: начинать с модуля, раньше всех стоящего в карте.
        const start = cycle.reduce((best, candidate, index) =>
          (order.get(candidate) ?? 0) < (order.get(cycle[best]!) ?? 0) ? index : best, 0);
        const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
        const key = rotated.join('\u0000');
        if (!keys.has(key)) {
          keys.add(key);
          cycles.push(rotated);
        }
      } else if (mark === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const module of modules) if (!state.has(module.id)) visit(module.id);
  return cycles;
}

/** Потребитель модуля: кто от него зависит и через сколько шагов. */
export interface Consumer {
  readonly id: string;
  /** 1 — прямой потребитель, больше — транзитивный. */
  readonly depth: number;
  /** Модуль, от которого потребитель зависит на этом пути: для прямого — сам источник. */
  readonly via: string;
}

/**
 * Затронутые потребители — модули, достижимые обратными рёбрами
 * зависимостей. Обход в ширину: глубина — кратчайшая цепочка. Цикл не
 * зацикливает обход, а сами исходные модули в результат не попадают.
 */
export function affectedConsumers(sources: readonly string[], modules: readonly ModuleDef[]): Consumer[] {
  const reverse = new Map<string, string[]>();
  for (const module of modules) {
    for (const dependency of module.dependsOn) {
      const list = reverse.get(dependency) ?? [];
      list.push(module.id);
      reverse.set(dependency, list);
    }
  }
  const seen = new Set(sources);
  const result: Consumer[] = [];
  let frontier = [...sources];
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const consumer of reverse.get(id) ?? []) {
        if (seen.has(consumer)) continue;
        seen.add(consumer);
        result.push({ id: consumer, depth, via: id });
        next.push(consumer);
      }
    }
    frontier = next;
  }
  const order = new Map(modules.map((module, index) => [module.id, index]));
  return result.sort((a, b) => a.depth - b.depth || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Прямые зависимости и прямые потребители модуля. */
export function moduleNeighbours(
  id: string,
  modules: readonly ModuleDef[],
): { readonly dependsOn: readonly string[]; readonly consumers: readonly string[] } {
  const module = modules.find((entry) => entry.id === id);
  return {
    dependsOn: module?.dependsOn ?? [],
    consumers: modules.filter((entry) => entry.dependsOn.includes(id)).map((entry) => entry.id),
  };
}

/** Группы модулей для списка: по группе карты, без группы — по виду. */
export function groupModules(modules: readonly ModuleDef[]): { readonly title: string; readonly modules: readonly ModuleDef[] }[] {
  const groups = new Map<string, ModuleDef[]>();
  for (const module of modules) {
    const title = module.group ?? KIND_GROUP[module.kind];
    const list = groups.get(title) ?? [];
    list.push(module);
    groups.set(title, list);
  }
  return [...groups].map(([title, list]) => ({ title, modules: list }));
}

const KIND_GROUP: Readonly<Record<ModuleKind, string>> = {
  service: 'Сервисы',
  ui: 'UI',
  library: 'Библиотеки',
};

/** Модули, которым принадлежат выбранные — для фильтра: change подходит, если пересекается. */
export function matchesModuleFilter(owned: readonly string[], filter: readonly string[]): boolean {
  return filter.length === 0 || owned.some((id) => filter.includes(id));
}

/** Какие модули у changes и capability рабочего пространства. */
export interface ModuleOverlay {
  /** Модули change; сквозной — больше одного. */
  readonly changes: Readonly<Record<string, readonly string[]>>;
  /** Модуль capability; `null` — вне модулей. */
  readonly capabilities: Readonly<Record<string, string | null>>;
}

/** Накладывает карту модулей на дерево. */
export function moduleOverlay(
  tree: {
    readonly changes: readonly { readonly name: string; readonly deltaCapabilities: readonly string[]; readonly declaredModules: readonly string[] }[];
    readonly capabilities: readonly CapabilityNodeLike[];
  },
  modules: readonly ModuleDef[],
): ModuleOverlay {
  const changes: Record<string, readonly string[]> = {};
  for (const change of tree.changes) {
    changes[change.name] = changeModules(change.deltaCapabilities, change.declaredModules, modules);
  }
  const capabilities: Record<string, string | null> = {};
  const walk = (nodes: readonly CapabilityNodeLike[]): void => {
    for (const node of nodes) {
      if (node.isSpec) capabilities[node.path] = capabilityModule(node.path, modules);
      walk(node.children);
    }
  };
  walk(tree.capabilities);
  return { changes, capabilities };
}

interface CapabilityNodeLike {
  readonly path: string;
  readonly isSpec: boolean;
  readonly children: readonly CapabilityNodeLike[];
}

/** Сводка метрик по changes выбранных модулей. */
export interface ModuleMetricsSummary {
  readonly changes: readonly string[];
  readonly total: number;
  readonly complete: number;
  readonly doneShare: number | null;
  /** `null` — ни по одному change нет данных о расходе. */
  readonly tokensTotal: number | null;
  readonly agentTimeMs: number;
  readonly runs: number;
  readonly failedRuns: number;
}

/** Складывает сводки changes: пункты, токены, время агента, запуски. */
export function aggregateSummaries(
  summaries: readonly {
    readonly change: string;
    readonly total: number;
    readonly complete: number;
    readonly tokensTotal: number | null;
    readonly agentTimeMs: number;
    readonly runs: number;
    readonly failedRuns: number;
  }[],
): ModuleMetricsSummary {
  const total = summaries.reduce((sum, entry) => sum + entry.total, 0);
  const complete = summaries.reduce((sum, entry) => sum + entry.complete, 0);
  const tokens = summaries.map((entry) => entry.tokensTotal).filter((value): value is number => value !== null);
  return {
    changes: summaries.map((entry) => entry.change),
    total,
    complete,
    doneShare: total === 0 ? null : complete / total,
    tokensTotal: tokens.length === 0 ? null : tokens.reduce((sum, value) => sum + value, 0),
    agentTimeMs: summaries.reduce((sum, entry) => sum + entry.agentTimeMs, 0),
    runs: summaries.reduce((sum, entry) => sum + entry.runs, 0),
    failedRuns: summaries.reduce((sum, entry) => sum + entry.failedRuns, 0),
  };
}
