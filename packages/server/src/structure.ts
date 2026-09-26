import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENSPEC_DIR,
  STRUCTURE_FILE,
  type DirEntry,
  type StructureIssue,
  type StructureNode,
  type StructureSpecError,
  type StructureSpecResult,
  checkStructure,
  parseStructureSpec,
  topLevelDirs,
} from '@openspec-ide/core';
import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';

/** Итог проверки структуры папок. */
export interface StructureReport {
  /** В проекте есть описание структуры. */
  readonly configured: boolean;
  /** Путь описания относительно корня. */
  readonly path: string;
  /** Ошибки самого описания; при них проверка не выполняется. */
  readonly errors: readonly StructureSpecError[];
  readonly issues: readonly StructureIssue[];
  readonly tree: readonly StructureNode[];
  /** Описание корректно и нарушений нет. */
  readonly ok: boolean;
}

/** Описание структуры уже есть — создавать его заново нельзя. */
export class StructureExistsError extends Error {
  constructor() {
    super(`Файл ${STRUCTURE_FILE} уже есть — откройте его и правьте в редакторе`);
    this.name = 'StructureExistsError';
  }
}

/**
 * Разбирает текст описания, запоминая строку каждого ключа, — чтобы нарушение
 * указывало на правило, из-за которого оно возникло.
 */
export function parseStructureYaml(text: string): StructureSpecResult {
  const counter = new LineCounter();
  const document = parseDocument(text, { lineCounter: counter, prettyErrors: false });
  const failure = document.errors[0];
  if (failure !== undefined) {
    return {
      ok: false,
      errors: [
        {
          message: `Описание не разбирается как YAML: ${failure.message.split('\n')[0] ?? failure.message}`,
          line: counter.linePos(failure.pos[0]).line,
        },
      ],
    };
  }

  const lines = new Map<string, number>();
  const walk = (node: unknown, path: readonly string[]): void => {
    if (!isMap(node)) return;
    for (const pair of node.items) {
      if (!isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      const offset = pair.key.range?.[0];
      if (offset !== undefined) lines.set([...path, key].join('\u0000'), counter.linePos(offset).line);
      walk(pair.value, [...path, key]);
    }
  };
  walk(document.contents, []);

  return parseStructureSpec(document.toJS(), (path) => lines.get(path.join('\u0000')) ?? null);
}

/**
 * Папки первого уровня из описания — за ними наблюдатель следит вместе с
 * `openspec/`. Читается синхронно при запуске бэкенда; без описания — пусто.
 */
export function watchedStructureDirs(root: string): string[] {
  try {
    const parsed = parseStructureYaml(readFileSync(join(root, STRUCTURE_FILE), 'utf8'));
    if (!parsed.ok) return [];
    return topLevelDirs(parsed.spec).filter((dir) => dir !== OPENSPEC_DIR && existsSync(join(root, dir)));
  } catch {
    return [];
  }
}

/** Проверяет структуру папок проекта по `openspec/structure.yaml`. */
export class StructureService {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async check(): Promise<StructureReport> {
    let text: string;
    try {
      text = await readFile(join(this.#root, STRUCTURE_FILE), 'utf8');
    } catch {
      return { configured: false, path: STRUCTURE_FILE, errors: [], issues: [], tree: [], ok: true };
    }

    const parsed = parseStructureYaml(text);
    if (!parsed.ok) {
      return { configured: true, path: STRUCTURE_FILE, errors: parsed.errors, issues: [], tree: [], ok: false };
    }
    const result = await checkStructure(parsed.spec, (path) => this.#readDir(path));
    return {
      configured: true,
      path: STRUCTURE_FILE,
      errors: [],
      issues: result.issues,
      tree: result.tree,
      ok: result.issues.length === 0,
    };
  }

  /**
   * Создаёт описание по текущей раскладке `openspec/`: файлы — обязательными,
   * папки — свободными. Такое описание проходит проверку сразу и служит
   * отправной точкой, которую команда ужесточает там, где нужно.
   */
  async init(): Promise<StructureReport> {
    const target = join(this.#root, STRUCTURE_FILE);
    if (existsSync(target)) throw new StructureExistsError();

    const listing = (await this.#readDir(OPENSPEC_DIR)) ?? [];
    const names = new Set(listing.map((entry) => entry.name));
    const lines = listing
      .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'structure.yaml')
      .sort((a, b) => Number(a.isDir) - Number(b.isDir) || a.name.localeCompare(b.name))
      .map((entry) => `    ${yamlKey(entry.name)}: ${entry.isDir ? '"*"' : 'file'}`);
    if (!names.has('schemas')) lines.push('    schemas?: "*"');

    await writeFile(target, structureTemplate(lines), 'utf8');
    return this.check();
  }

  async #readDir(path: string): Promise<readonly DirEntry[] | null> {
    const absolute = path === '' ? this.#root : join(this.#root, ...path.split('/'));
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return null;
    }
    return Promise.all(
      entries.map(async (entry) => {
        if (!entry.isSymbolicLink()) return { name: entry.name, isDir: entry.isDirectory() };
        // Ссылка проверяется по тому, на что она указывает.
        try {
          return { name: entry.name, isDir: (await stat(join(absolute, entry.name))).isDirectory() };
        } catch {
          return { name: entry.name, isDir: false };
        }
      }),
    );
  }
}

function yamlKey(name: string): string {
  return /^[\w.-]+$/.test(name) ? name : JSON.stringify(name);
}

function structureTemplate(openspecLines: readonly string[]): string {
  return `# Структура папок проекта для контекста и спецификаций.
# IDE проверяет её в разделе «Структура», а в VS Code — в панели «Проблемы».
#
#   имя: file       обязательный файл
#   имя:            папка строго с перечисленным ниже содержимым:
#     ...           всё, что в ней не описано, — лишнее
#   имя: "*"        папка, внутри которой допустима любая структура
#   имя: any        файл или папка с любым содержимым
#   имя?: ...       необязательный элемент
#   "*.md": file    шаблон имени: сколько угодно подходящих элементов
#
# Корень проекта не строгий: проверяются только перечисленные ниже элементы.
# Служебные файлы не считаются лишними; список меняется полем ignore.
version: 1
ignore: [".DS_Store", "Thumbs.db", ".gitkeep"]
structure:
  openspec:
    structure.yaml: file
${openspecLines.join('\n')}
  # Пример контекста для людей и агентов — раскомментируйте и поправьте:
  # docs:
  #   context:
  #     README.md: file
  #     glossary.md: file
  #     "*.md": file
  #     adr: "*"
`;
}
