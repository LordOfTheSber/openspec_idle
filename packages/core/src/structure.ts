/**
 * Структура папок проекта для контекста и спецификаций: разбор описания из
 * `openspec/structure.yaml` и проверка соответствия.
 *
 * Описание — дерево от корня проекта, где ключ — имя элемента, а значение —
 * правило. Файловой системы здесь нет: проверка получает функцию чтения
 * каталога, поэтому одинаково работает на диске и на таблице в тестах.
 */

/** Путь к описанию структуры относительно корня рабочего пространства. */
export const STRUCTURE_FILE = 'openspec/structure.yaml';

/** Служебные файлы, которые не считаются лишними, если `ignore` не задан. */
export const DEFAULT_STRUCTURE_IGNORE: readonly string[] = ['.DS_Store', 'Thumbs.db', '.gitkeep'];

/** Правило элемента структуры. */
export type StructureRule =
  /** Файл. */
  | { readonly kind: 'file' }
  /** Папка с любым содержимым — граница жёсткости. */
  | { readonly kind: 'free' }
  /** Файл или папка с любым содержимым. */
  | { readonly kind: 'any' }
  /** Папка строго с перечисленным содержимым. */
  | { readonly kind: 'dir'; readonly entries: readonly StructureEntry[] };

/** Элемент описания. */
export interface StructureEntry {
  /** Имя или шаблон имени, как записано в описании (без `?`). */
  readonly name: string;
  /** Шаблон имени со звёздочкой: ноль или больше совпадений. */
  readonly pattern: boolean;
  readonly optional: boolean;
  readonly rule: StructureRule;
  /** Строка ключа в описании, начиная с 1; `null`, если неизвестна. */
  readonly line: number | null;
}

/** Разобранное описание структуры. */
export interface StructureSpec {
  /** Элементы первого уровня от корня проекта. */
  readonly entries: readonly StructureEntry[];
  readonly ignore: readonly string[];
}

/** Ошибка в самом описании. */
export interface StructureSpecError {
  readonly message: string;
  readonly line: number | null;
}

export type StructureSpecResult =
  | { readonly ok: true; readonly spec: StructureSpec }
  | { readonly ok: false; readonly errors: readonly StructureSpecError[] };

/** Строка ключа по пути ключей от корня документа, например `['structure', 'docs']`. */
export type LineOf = (path: readonly string[]) => number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Разбирает описание структуры — значение YAML-документа целиком.
 *
 * Ошибки собираются все сразу, а не до первой: описание правят вручную, и
 * исправлять по одной ошибке за проверку утомительно.
 */
export function parseStructureSpec(document: unknown, lineOf: LineOf = () => null): StructureSpecResult {
  const errors: StructureSpecError[] = [];

  if (!isRecord(document)) {
    return { ok: false, errors: [{ message: 'Описание структуры должно быть YAML-объектом с полем structure', line: 1 }] };
  }

  const version = document['version'];
  if (version !== undefined && version !== 1) {
    errors.push({ message: `Неподдерживаемая версия описания «${String(version)}»: ожидается 1`, line: lineOf(['version']) });
  }

  let ignore: readonly string[] = DEFAULT_STRUCTURE_IGNORE;
  if (document['ignore'] !== undefined) {
    const value = document['ignore'];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
      errors.push({ message: 'Поле ignore должно быть списком имён или шаблонов', line: lineOf(['ignore']) });
    } else {
      ignore = value as string[];
    }
  }

  const structure = document['structure'];
  if (structure === undefined) {
    errors.push({ message: 'Нет поля structure — дерева папок от корня проекта', line: 1 });
  } else if (!isRecord(structure)) {
    errors.push({ message: 'Поле structure должно быть деревом папок: ключ — имя, значение — правило', line: lineOf(['structure']) });
  }

  const entries = isRecord(structure) ? parseEntries(structure, ['structure'], lineOf, errors) : [];
  return errors.length > 0 ? { ok: false, errors } : { ok: true, spec: { entries, ignore } };
}

const RULE_HINT = 'file, "*" (папка с любым содержимым), any или вложенный перечень';

function parseEntries(
  map: Record<string, unknown>,
  path: readonly string[],
  lineOf: LineOf,
  errors: StructureSpecError[],
): StructureEntry[] {
  const entries: StructureEntry[] = [];
  for (const [key, value] of Object.entries(map)) {
    const keyPath = [...path, key];
    const line = lineOf(keyPath);
    const optional = key.endsWith('?');
    const name = optional ? key.slice(0, -1) : key;
    const pattern = name.includes('*');

    if (name === '' || name === '.' || name === '..') {
      errors.push({ message: `Недопустимое имя «${key}»`, line });
      continue;
    }
    if (name.includes('/') || name.includes('\\')) {
      errors.push({
        message: `Имя «${key}» не может содержать «/»: вложите папки друг в друга — каждая строка описания это один уровень`,
        line,
      });
      continue;
    }
    if (pattern && optional) {
      errors.push({ message: `Шаблон «${name}» и так необязателен — уберите «?»`, line });
      continue;
    }

    let rule: StructureRule | null = null;
    if (value === 'file') rule = { kind: 'file' };
    else if (value === '*') rule = { kind: 'free' };
    else if (value === 'any') rule = { kind: 'any' };
    else if (value === null || isRecord(value)) {
      rule = { kind: 'dir', entries: value === null ? [] : parseEntries(value, keyPath, lineOf, errors) };
    } else {
      errors.push({
        message: `Неизвестное правило «${typeof value === 'string' ? value : JSON.stringify(value)}» у «${key}»: ожидается ${RULE_HINT}`,
        line,
      });
      continue;
    }
    entries.push({ name, pattern, optional, rule, line });
  }
  return entries;
}

/** Сопоставление имени с шаблоном: `*` — любая последовательность символов. */
export function matchesName(pattern: string, name: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}

/** Элемент каталога. */
export interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
}

/** Читает каталог по пути относительно корня (`''` — корень); `null` — его нет. */
export type ReadDir = (path: string) => Promise<readonly DirEntry[] | null>;

export type StructureIssueKind = 'missing' | 'unexpected' | 'wrong-type';

/** Нарушение структуры. */
export interface StructureIssue {
  readonly kind: StructureIssueKind;
  /** Путь элемента относительно корня. */
  readonly path: string;
  /** Каким элемент должен быть; у лишнего — `null`. */
  readonly expected: 'file' | 'dir' | null;
  /** Каким элемент есть; у отсутствующего — `null`. */
  readonly actual: 'file' | 'dir' | null;
  /** Строка правила в описании: элемента или, для лишнего, его папки. */
  readonly line: number | null;
  readonly message: string;
}

/** Состояние элемента описания после проверки. */
export type StructureNodeState = 'ok' | 'missing' | 'wrong-type' | 'absent-optional' | 'has-issues';

/** Элемент описания с результатом проверки — для показа дерева. */
export interface StructureNode {
  readonly name: string;
  /** Путь относительно корня; у шаблона — путь папки и шаблон. */
  readonly path: string;
  readonly rule: StructureRule['kind'];
  readonly pattern: boolean;
  readonly optional: boolean;
  readonly line: number | null;
  readonly state: StructureNodeState;
  /** Число совпадений шаблона. */
  readonly matches: number | null;
  readonly children: readonly StructureNode[];
}

/** Итог проверки. */
export interface StructureCheck {
  readonly issues: readonly StructureIssue[];
  readonly tree: readonly StructureNode[];
}

const KIND_WORD: Record<'file' | 'dir', string> = { file: 'файл', dir: 'папка' };

function join(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/**
 * Проверяет рабочее пространство по описанию.
 *
 * Обходится только то, что требует описание: свободные папки не читаются,
 * поэтому большая папка с произвольным содержимым проверку не замедляет.
 */
export async function checkStructure(spec: StructureSpec, readDir: ReadDir): Promise<StructureCheck> {
  const issues: StructureIssue[] = [];
  const ignored = (name: string): boolean => spec.ignore.some((pattern) => matchesName(pattern, name));

  const checkDir = async (
    path: string,
    entries: readonly StructureEntry[],
    strict: boolean,
    line: number | null,
  ): Promise<StructureNode[]> => {
    const listing = ((await readDir(path)) ?? []).filter((entry) => !ignored(entry.name));
    const byName = new Map(listing.map((entry) => [entry.name, entry]));
    const claimed = new Set<string>();
    const nodes: StructureNode[] = [];

    for (const entry of entries.filter((item) => !item.pattern)) {
      const childPath = join(path, entry.name);
      const found = byName.get(entry.name);
      if (found === undefined) {
        if (!entry.optional) {
          const expected = entry.rule.kind === 'file' ? 'file' : entry.rule.kind === 'any' ? null : 'dir';
          issues.push({
            kind: 'missing',
            path: childPath,
            expected,
            actual: null,
            line: entry.line,
            message:
              expected === null
                ? `Нет обязательного элемента ${childPath}`
                : `Нет обязательно${expected === 'file' ? 'го файла' : 'й папки'} ${childPath}`,
          });
        }
        nodes.push(node(entry, childPath, entry.optional ? 'absent-optional' : 'missing', null, []));
        continue;
      }
      claimed.add(found.name);
      nodes.push(await checkEntry(entry, childPath, found));
    }

    for (const entry of entries.filter((item) => item.pattern)) {
      let matches = 0;
      let failed = false;
      const children: StructureNode[] = [];
      for (const found of listing) {
        if (claimed.has(found.name) || !matchesName(entry.name, found.name)) continue;
        claimed.add(found.name);
        matches += 1;
        const checked = await checkEntry(entry, join(path, found.name), found);
        if (checked.state !== 'ok') failed = true;
        children.push(checked);
      }
      nodes.push({
        ...node(entry, join(path, entry.name), failed ? 'has-issues' : 'ok', matches, []),
        // Совпадения шаблона показываются, только если с ними что-то не так.
        children: children.filter((child) => child.state !== 'ok'),
      });
    }

    if (strict) {
      const allowed = entries.map((entry) => `${entry.name}${entry.rule.kind === 'file' ? '' : '/'}`);
      for (const found of listing) {
        if (claimed.has(found.name)) continue;
        const childPath = join(path, found.name);
        issues.push({
          kind: 'unexpected',
          path: childPath,
          expected: null,
          actual: found.isDir ? 'dir' : 'file',
          line,
          message:
            `Лишн${found.isDir ? 'яя папка' : 'ий файл'} ${childPath}: ` +
            (allowed.length === 0
              ? `папка ${path} по описанию должна быть пустой`
              : `в ${path} разрешены только ${allowed.slice(0, 8).join(', ')}${allowed.length > 8 ? ' и др.' : ''}`),
        });
      }
    }
    return nodes;
  };

  const checkEntry = async (entry: StructureEntry, path: string, found: DirEntry): Promise<StructureNode> => {
    const rule = entry.rule;
    const actual = found.isDir ? 'dir' : 'file';
    const expected = rule.kind === 'file' ? 'file' : rule.kind === 'any' ? null : 'dir';
    if (expected !== null && expected !== actual) {
      issues.push({
        kind: 'wrong-type',
        path,
        expected,
        actual,
        line: entry.line,
        message: `${path} должен быть ${expected === 'file' ? 'файлом' : 'папкой'}, а это ${KIND_WORD[actual]}`,
      });
      return node(entry, path, 'wrong-type', null, []);
    }
    if (rule.kind !== 'dir') return node(entry, path, 'ok', null, []);

    const before = issues.length;
    const children = await checkDir(path, rule.entries, true, entry.line);
    return node(entry, path, issues.length > before ? 'has-issues' : 'ok', null, children);
  };

  // Корень проекта не строгий: в нём живёт всё, что к контексту и спекам не относится.
  const tree = await checkDir('', spec.entries, false, null);
  return { issues, tree };
}

function node(
  entry: StructureEntry,
  path: string,
  state: StructureNodeState,
  matches: number | null,
  children: readonly StructureNode[],
): StructureNode {
  return {
    name: entry.name,
    path,
    rule: entry.rule.kind,
    pattern: entry.pattern,
    optional: entry.optional,
    line: entry.line,
    state,
    matches,
    children,
  };
}

/**
 * Папки первого уровня, которые описание требует или допускает, — за ними
 * нужно следить, чтобы замечать изменения вне `openspec/`.
 */
export function topLevelDirs(spec: StructureSpec): string[] {
  return spec.entries
    .filter((entry) => !entry.pattern && (entry.rule.kind === 'dir' || entry.rule.kind === 'free' || entry.rule.kind === 'any'))
    .map((entry) => entry.name);
}
