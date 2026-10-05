import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import {
  type AuthoringSources,
  DEFAULT_QUALITY_CONFIG,
  type DomainCode,
  OPENSPEC_DIR,
  QUALITY_FILE,
  type QualityConfig,
  type QualityConfigError,
  type QualityIssue,
  type RegistryFile,
  TEST_FILE,
  parseQualityConfig,
  planTestRefIssues,
  planTestReferences,
  registryCodes,
  specCodeIssues,
} from '@openspec-ide/core';
import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';
import { parseFrontmatter } from './contextMap.js';
import { GitHistory } from './git.js';

/**
 * Читает настройки проверки качества спеков — `openspec/quality.yaml` — и
 * файлы реестра кодов ошибок, на которые они ссылаются. Без файла настроек —
 * умолчания; ошибки файла и ненайденные реестры попадают в `errors`.
 */
export async function readQualityConfig(root: string): Promise<QualityConfig> {
  let text: string;
  try {
    text = await readFile(join(root, QUALITY_FILE), 'utf8');
  } catch {
    return DEFAULT_QUALITY_CONFIG;
  }

  const counter = new LineCounter();
  const document = parseDocument(text, { lineCounter: counter, prettyErrors: false });
  const failure = document.errors[0];
  if (failure !== undefined) {
    return {
      ...DEFAULT_QUALITY_CONFIG,
      path: QUALITY_FILE,
      errors: [
        {
          line: counter.linePos(failure.pos[0]).line,
          message: `${QUALITY_FILE} не разбирается как YAML: ${failure.message.split('\n')[0] ?? failure.message}`,
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
  const lineOf = (path: readonly string[]): number | null => lines.get(path.join('\u0000')) ?? null;

  const { config, registryPaths } = parseQualityConfig(document.toJS(), lineOf);
  if (registryPaths.length === 0) return config;

  const errors: QualityConfigError[] = [...config.errors];
  const registry: RegistryFile[] = [];
  for (const path of registryPaths) {
    const relative = normalize(path).replaceAll('\\', '/');
    // Реестр — файл проекта: путь вне корня не читается.
    if (isAbsolute(path) || relative.startsWith('..')) {
      errors.push({ line: lineOf(['errorCodes', 'registry']), message: `${QUALITY_FILE}: реестр «${path}» — путь от корня проекта, без выхода за него` });
      continue;
    }
    try {
      const content = await readFile(join(root, relative), 'utf8');
      registry.push({ path: relative, codes: registryCodes(content, config.errorCodePattern) });
    } catch {
      errors.push({ line: lineOf(['errorCodes', 'registry']), message: `${QUALITY_FILE}: файл реестра кодов ошибок «${path}» не найден` });
    }
  }
  return { ...config, registry, errors };
}

/** Каталоги, код в которых не ищется: зависимости, сборки, медиа. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'media', '.git', '.openspec-ide', '__pycache__']);
/** Текстовые файлы кода и ресурсов, где живут сообщения и константы. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|java|kt|kts|scala|groovy|py|go|rs|cs|swift|rb|php|vue|svelte|html|json|ya?ml|properties|xml|sql)$/i;
/** Больше — не код, а данные или сборка. */
const MAX_CODE_FILE = 512 * 1024;
const MAX_CODE_FILES = 5_000;

/**
 * Проверки качества, которым нужен диск: ссылки плана на тесты и сверка спек с
 * кодом модулей их домена по карте контекста (`domains` и `code_paths` в
 * `index.md` модулей).
 */
export async function projectQualityIssues(root: string, sources: AuthoringSources): Promise<QualityIssue[]> {
  const refs = planTestReferences(sources);
  const files = new Map<string, string | null>();
  for (const ref of refs) {
    if (files.has(ref.file)) continue;
    const relative = normalize(ref.file).replaceAll('\\', '/');
    files.set(ref.file, isAbsolute(ref.file) || relative.startsWith('..') ? null : await readText(join(root, relative)));
  }
  const config = sources.quality ?? DEFAULT_QUALITY_CONFIG;
  return [...planTestRefIssues(refs, files, config), ...specCodeIssues(sources, await domainCode(root))];
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Код модулей каждого домена карты контекста; без модулей — пусто. */
async function domainCode(root: string): Promise<DomainCode[]> {
  const modulesDir = join(root, OPENSPEC_DIR, 'context', 'modules');
  let folders: string[];
  try {
    folders = (await readdir(modulesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const domains = new Map<string, { modules: string[]; paths: string[] }>();
  for (const folder of folders) {
    const index = await readText(join(modulesDir, folder, 'index.md'));
    if (index === null) continue;
    const value = parseFrontmatter(index).value as { module?: unknown; domains?: unknown; code_paths?: unknown } | null;
    if (value === null) continue;
    const list = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []);
    const name = typeof value.module === 'string' ? value.module : folder;
    for (const domain of list(value.domains)) {
      const entry = domains.get(domain) ?? { modules: [], paths: [] };
      entry.modules.push(name);
      entry.paths.push(...list(value.code_paths));
      domains.set(domain, entry);
    }
  }
  const cache = new Map<string, { path: string; text: string }[]>();
  const result: DomainCode[] = [];
  for (const [capability, entry] of domains) {
    const files: { path: string; text: string }[] = [];
    for (const path of [...new Set(entry.paths)]) {
      const relative = normalize(path).replaceAll('\\', '/').replace(/\/$/, '');
      if (isAbsolute(path) || relative.startsWith('..')) continue;
      let found = cache.get(relative);
      if (found === undefined) {
        found = await collectCode(root, relative);
        cache.set(relative, found);
      }
      files.push(...found);
    }
    result.push({ capability, modules: entry.modules, files });
  }
  return result;
}

/** Файлы кода под путём, без тестов: сообщение и константа должны жить в продукте. */
async function collectCode(root: string, relative: string): Promise<{ path: string; text: string }[]> {
  const result: { path: string; text: string }[] = [];
  const visit = async (path: string): Promise<void> => {
    if (result.length >= MAX_CODE_FILES) return;
    let info;
    try {
      info = await stat(join(root, path));
    } catch {
      return;
    }
    if (info.isDirectory()) {
      const entries = await readdir(join(root, path), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await visit(`${path}/${entry.name}`);
      }
      return;
    }
    if (!CODE_FILE.test(path) || TEST_FILE.test(path) || info.size > MAX_CODE_FILE) return;
    const text = await readText(join(root, path));
    if (text !== null) result.push({ path, text });
  };
  await visit(relative);
  return result;
}

/**
 * Основные спеки и дельты активных changes в ревизии git — для сравнения
 * метрик с базовой веткой. Настройки — текущие: сравнивается текст спек, а не
 * правила. Ревизии нет или git недоступен — `null`.
 */
export async function baselineSources(root: string, ref: string, quality: QualityConfig): Promise<AuthoringSources | null> {
  const git = new GitHistory(root);
  if (!(await git.available())) return null;
  const commit = await git.resolve(ref);
  if (commit === null) return null;
  const paths = await git.listFiles(commit, [`${OPENSPEC_DIR}/specs`, `${OPENSPEC_DIR}/changes`]);
  const mainSpecs: AuthoringSources['mainSpecs'][number][] = [];
  const changes = new Map<string, AuthoringSources['changes'][number]['deltas'][number][]>();
  // Артефакты changes — чтобы исполняемые правила считались в обеих ревизиях одинаково. Схемы
  // ревизии неизвестны: идентификатор — имя файла (`design.md` → design), дельты — specs.
  const artifacts = new Map<string, { id: string; path: string; text: string }[]>();
  for (const path of paths) {
    const artifact = new RegExp(`^${OPENSPEC_DIR}/changes/([^/]+)/(?:([^/]+)\\.md|specs/.+\\.md)$`).exec(path);
    if (artifact?.[1] !== undefined && artifact[1] !== 'archive') {
      const text = await git.show(commit, path);
      if (text !== null) {
        const list = artifacts.get(artifact[1]) ?? [];
        list.push({ id: artifact[2] ?? 'specs', path, text });
        artifacts.set(artifact[1], list);
        if (!changes.has(artifact[1])) changes.set(artifact[1], []);
      }
    }
    if (!path.endsWith('/spec.md')) continue;
    const main = new RegExp(`^${OPENSPEC_DIR}/specs/(.+)/spec\\.md$`).exec(path);
    const delta = new RegExp(`^${OPENSPEC_DIR}/changes/([^/]+)/specs/(.+)/spec\\.md$`).exec(path);
    if (main?.[1] === undefined && (delta?.[1] === undefined || delta[1] === 'archive')) continue;
    const text = await git.show(commit, path);
    if (text === null) continue;
    if (main?.[1] !== undefined) mainSpecs.push({ capability: main[1], path, text });
    else if (delta?.[1] !== undefined && delta[2] !== undefined) {
      const list = changes.get(delta[1]) ?? [];
      list.push({ capability: delta[2], path, text });
      changes.set(delta[1], list);
    }
  }
  return {
    mainSpecs,
    changes: [...changes].map(([name, deltas]) => ({ name, deltas, plan: null, artifacts: artifacts.get(name) ?? [] })),
    quality,
  };
}
