import { existsSync, statSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from 'yaml';
import {
  EMPTY_MODULE_MAP,
  OPENSPEC_DIR,
  parseModuleMap,
  type ModuleKind,
  type ModuleMap,
  type ModuleProblem,
} from '@openspec-ide/core';

export const MODULES_FILE = 'modules.yaml';

/** Карта модулей в том виде, в каком её отдаёт API. */
export interface ModuleMapView extends ModuleMap {
  /** Файл карты есть — иначе IDE работает без модулей и предлагает обнаружение. */
  readonly exists: boolean;
  /** Путь файла от корня репозитория. */
  readonly file: string;
}

/** Модуль для записи в карту. */
export interface ModuleInput {
  readonly id: string;
  readonly title: string;
  readonly kind: ModuleKind;
  readonly path: string;
  readonly specs: string;
  readonly group: string | null;
  readonly dependsOn: readonly string[];
}

/** Файл карты не разобрался как YAML. */
export class ModuleMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleMapError';
  }
}

/**
 * Читает и пишет `openspec/modules.yaml`. CLI OpenSpec этот файл не читает,
 * поэтому формат карты не зависит от его версии.
 */
export class ModuleMapStore {
  readonly #root: string;
  #cache: { readonly mtimeMs: number; readonly view: ModuleMapView } | null = null;

  constructor(root: string) {
    this.#root = root;
  }

  get path(): string {
    return join(this.#root, OPENSPEC_DIR, MODULES_FILE);
  }

  /** Читает карту; каталоги кода проверяются на существование. */
  async read(): Promise<ModuleMapView> {
    const file = `${OPENSPEC_DIR}/${MODULES_FILE}`;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      this.#cache = null;
      return { ...EMPTY_MODULE_MAP, exists: false, file };
    }
    if (this.#cache?.mtimeMs === mtimeMs) return this.#cache.view;

    const text = await readFile(this.path, 'utf8');
    const document = parseDocument(text, { prettyErrors: false });
    let view: ModuleMapView;
    if (document.errors.length > 0) {
      const [error] = document.errors;
      view = {
        ...EMPTY_MODULE_MAP,
        exists: true,
        file,
        problems: [{ module: null, field: 'yaml', message: `Карта не разбирается как YAML: ${error?.message ?? ''}` }],
      };
    } else {
      const map = parseModuleMap(document.toJS());
      const missing: ModuleProblem[] = map.modules
        .filter((module) => module.path !== null && !isDirectory(join(this.#root, module.path)))
        .map((module) => ({
          module: module.id,
          field: 'path',
          message: `Каталог кода ${module.path} не существует`,
        }));
      view = { ...map, problems: [...map.problems, ...missing], exists: true, file };
    }
    this.#cache = { mtimeMs, view };
    return view;
  }

  /**
   * Записывает модули. Неизвестные ключи карты и модулей, комментарии и
   * порядок сохраняются: карту правят и руками в пулл-реквестах.
   */
  async write(modules: readonly ModuleInput[]): Promise<ModuleMapView> {
    const text = existsSync(this.path) ? await readFile(this.path, 'utf8') : null;
    const document = text === null ? parseDocument('version: 1\nmodules: []\n') : parseDocument(text);
    if (document.errors.length > 0) {
      throw new ModuleMapError(
        `Файл ${OPENSPEC_DIR}/${MODULES_FILE} не разбирается как YAML — исправьте его вручную: ${document.errors[0]?.message ?? ''}`,
      );
    }
    applyModules(document, modules);
    await writeAtomically(this.path, document.toString({ lineWidth: 0, flowCollectionPadding: false }));
    this.#cache = null;
    return this.read();
  }
}

function applyModules(document: Document, modules: readonly ModuleInput[]): void {
  if (!isMap(document.contents)) document.contents = document.createNode({}) as YAMLMap;
  if (!document.has('version')) document.set('version', 1);
  const current = document.get('modules');
  const list = isSeq(current) ? current : document.createNode([]);
  if (!isSeq(current)) document.set('modules', list);
  if (!isSeq(list)) return;
  list.flow = false;

  const existing = new Map<string, YAMLMap>();
  for (const item of list.items) {
    if (isMap(item)) {
      const id = item.get('id');
      if (typeof id === 'string') existing.set(id, item);
    }
  }
  list.items = modules.map((module) => {
    const node = existing.get(module.id) ?? (document.createNode({}) as YAMLMap);
    node.set('id', module.id);
    node.set('title', module.title);
    node.set('kind', module.kind);
    node.set('path', module.path);
    node.set('specs', module.specs);
    if (module.group === null) node.delete('group');
    else node.set('group', module.group);
    if (module.dependsOn.length === 0) node.delete('dependsOn');
    else {
      const depends = document.createNode([...module.dependsOn]);
      depends.flow = true;
      node.set('dependsOn', depends);
    }
    return node;
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}
