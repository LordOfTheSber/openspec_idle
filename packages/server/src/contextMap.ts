import { readFile, readdir, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
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
  type ModuleSource,
  buildContextMap,
  firstHeading,
  splitFrontmatter,
} from '@openspec-ide/core';
import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';

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
  const segments = posix.split('/');
  const cut = segments.findIndex((segment) => segment.includes('*') || segment === '...' || segment === '…');
  const prefix = (cut === -1 ? segments : segments.slice(0, cut)).filter((segment) => segment !== '').join('/');
  // Шаблон с самого начала (`**/*.java`) проверить нечем — он не считается ошибкой.
  if (prefix === '') return cut === 0;
  const relative = normalize(prefix);
  if (relative.startsWith('..')) return false;
  return exists(join(root, relative));
}

/** Строки поля frontmatter: список или одно значение. */
function listField(value: unknown, key: string): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const field = (value as Record<string, unknown>)[key];
  const items = Array.isArray(field) ? field : [field];
  return items.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
}

/** Строит карту контекста проекта по файлам `openspec/context/` и `openspec/specs/`. */
export class ContextMapService {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async build(): Promise<ContextMap> {
    const [general, modules, adrs, domains] = await Promise.all([
      this.#general(),
      this.#modules(),
      this.#adrs(),
      this.#domains(),
    ]);
    return buildContextMap({ general, modules, adrs, domains });
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

  async #modules(): Promise<ModuleSource[]> {
    const folders = (await listDir(this.#abs(MODULES_DIR))).filter((entry) => entry.isDir);
    return Promise.all(
      folders.map(async ({ name }) => {
        const index = await readText(this.#abs(`${MODULES_DIR}/${name}/${MODULE_INDEX_FILE}`));
        const hasContext = await exists(this.#abs(`${MODULES_DIR}/${name}/${MODULE_CONTEXT_FILE}`));
        const parsed = index === null ? null : parseFrontmatter(index);
        const codePaths = listField(parsed?.value, 'code_paths');
        const existing = new Set<string>();
        for (const path of codePaths) {
          if (await codePathExists(this.#root, path)) existing.add(path);
        }
        return {
          folder: name,
          hasIndex: index !== null,
          hasContext,
          frontmatter: parsed?.value ?? null,
          frontmatterError: parsed?.error ?? null,
          lineOf: parsed?.lineOf ?? (() => null),
          existingCodePaths: existing,
        };
      }),
    );
  }

  async #adrs(): Promise<AdrSource[]> {
    const found: AdrSource[] = [];
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
          path: child,
          frontmatter: parsed.value,
          frontmatterError: parsed.error,
          lineOf: parsed.lineOf,
          heading: firstHeading(parsed.body),
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
}
