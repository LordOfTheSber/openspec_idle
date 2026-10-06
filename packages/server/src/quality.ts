import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import {
  type AuthoringSources,
  DEFAULT_QUALITY_CONFIG,
  type DomainCode,
  type ModuleFile,
  OPENSPEC_DIR,
  QUALITY_FILE,
  type QualityConfig,
  type QualityConfigError,
  type QualityIssue,
  QUALITY_RULES,
  type RegistryFile,
  TEST_FILE,
  parseQualityConfig,
  planTestRefIssues,
  planTestReferences,
  registryCodes,
  specCodeIssues,
} from '@openspec-ide/core';
import { type Document, LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
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
    if (isSeq(node)) {
      // Элементы списков (`exclude`, `artifacts`) — со строкой своего начала.
      node.items.forEach((item, index) => {
        const offset = (item as { range?: [number, number, number] } | null)?.range?.[0];
        if (offset !== undefined) lines.set([...path, String(index)].join('\u0000'), counter.linePos(offset).line);
        walk(item, [...path, String(index)]);
      });
      return;
    }
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
  const code = await domainCode(root);
  return [...planTestRefIssues(refs, files, config), ...specCodeIssues(sources, code.domains, code.everywhere)];
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Код модулей карты контекста: по доменам и всех модулей вместе; без модулей — пусто. */
async function domainCode(root: string): Promise<{ domains: DomainCode[]; everywhere: ModuleFile[] }> {
  const modulesDir = join(root, OPENSPEC_DIR, 'context', 'modules');
  let folders: string[];
  try {
    folders = (await readdir(modulesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return { domains: [], everywhere: [] };
  }
  const cache = new Map<string, { path: string; text: string }[]>();
  const modules: { name: string; domains: string[]; files: ModuleFile[] }[] = [];
  for (const folder of folders) {
    const index = await readText(join(modulesDir, folder, 'index.md'));
    if (index === null) continue;
    const value = parseFrontmatter(index).value as { module?: unknown; domains?: unknown; code_paths?: unknown } | null;
    if (value === null) continue;
    const list = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []);
    const name = typeof value.module === 'string' ? value.module : folder;
    const files: ModuleFile[] = [];
    for (const path of new Set(list(value.code_paths))) {
      const relative = normalize(path).replaceAll('\\', '/').replace(/\/$/, '');
      if (isAbsolute(path) || relative.startsWith('..')) continue;
      let found = cache.get(relative);
      if (found === undefined) {
        found = await collectCode(root, relative);
        cache.set(relative, found);
      }
      files.push(...found.map((file) => ({ ...file, module: name })));
    }
    modules.push({ name, domains: list(value.domains), files });
  }
  const capabilities = new Set(modules.flatMap((module) => module.domains));
  const domains = [...capabilities].map((capability) => {
    const owners = modules.filter((module) => module.domains.includes(capability));
    return { capability, modules: owners.map((module) => module.name), files: owners.flatMap((module) => module.files) };
  });
  return { domains, everywhere: modules.flatMap((module) => module.files) };
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

// ---------------------------------------------------------------------------
// Правка настроек из раздела «Качество»

/** Правка настроек невозможна: файл не разбирается, уже есть или запрос неверен. */
export class QualitySettingsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'QualitySettingsError';
  }
}

/** Заготовка `openspec/quality.yaml`: всё, кроме scope и rules, — закомментированные примеры. */
export const QUALITY_TEMPLATE = `# Настройки проверки качества спеков. Описание ключей — README, раздел «Качество спеков».
version: 1
scope: all               # all — основные спеки и дельты; changes — только дельты активных changes
rules: {}                # правило: error | warning | info | off
# exclude:               # исключения: правило (или все) в файлах по шаблону пути и в требовании
#   - rule: vague-wording
#     path: openspec/specs/legacy/**
#     reason: старые спеки, переписываются
# actors: [система]
# glossary: []
# parameters: {}
# errorCodes: { registry: [] }
# thresholds: { ambiguityDensity: 0.5 }
# artifacts: []
`;

const LEVEL_VALUES: readonly string[] = ['error', 'warning', 'info', 'off'];

/** Создаёт `openspec/quality.yaml` из заготовки; есть — ошибка 409. */
export async function initQualityConfig(root: string): Promise<void> {
  try {
    await writeFile(join(root, QUALITY_FILE), QUALITY_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'EEXIST') throw new QualitySettingsError(`${QUALITY_FILE} уже есть — откройте его в редакторе`, 409);
    throw failure;
  }
}

/** Читает настройки как документ YAML для правки; файла нет — заготовка. */
async function editableConfig(root: string): Promise<Document> {
  let text: string;
  try {
    text = await readFile(join(root, QUALITY_FILE), 'utf8');
  } catch {
    text = QUALITY_TEMPLATE;
  }
  const document = parseDocument(text);
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) {
    throw new QualitySettingsError(`${QUALITY_FILE} не разбирается — исправьте его в редакторе, затем повторите`, 409);
  }
  return document;
}

async function saveConfig(root: string, document: Document): Promise<void> {
  await writeFile(join(root, QUALITY_FILE), document.toString(), 'utf8');
}

/** Задаёт уровень правила в `rules` (`null` — убрать, действует уровень по умолчанию). */
export async function setRuleLevel(root: string, rule: string, level: string | null): Promise<void> {
  if (!(rule in QUALITY_RULES)) throw new QualitySettingsError(`Неизвестное правило «${rule}»`, 400);
  if (level !== null && !LEVEL_VALUES.includes(level)) throw new QualitySettingsError(`Уровень правила — ${LEVEL_VALUES.join(', ')} или пусто`, 400);
  const document = await editableConfig(root);
  if (level === null) {
    if (document.hasIn(['rules', rule])) document.deleteIn(['rules', rule]);
  } else if (isMap(document.get('rules'))) {
    document.setIn(['rules', rule], level);
  } else {
    // `rules: {}` из заготовки — поточная запись; правка превращает её в обычный словарь.
    document.set('rules', document.createNode({ [rule]: level }));
  }
  await saveConfig(root, document);
}

/** Добавляет исключение в конец `exclude`. */
export async function addExclusion(
  root: string,
  exclusion: { rule?: string | null; path?: string | null; requirement?: string | null; reason?: string | null },
): Promise<void> {
  const item: Record<string, string> = {};
  for (const key of ['rule', 'path', 'requirement', 'reason'] as const) {
    const value = exclusion[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.trim() === '') throw new QualitySettingsError(`«${key}» исключения — непустая строка`, 400);
    item[key] = value.trim();
  }
  if (item['rule'] !== undefined && !(item['rule'] in QUALITY_RULES)) throw new QualitySettingsError(`Неизвестное правило «${item['rule']}»`, 400);
  if (item['rule'] === undefined && item['path'] === undefined && item['requirement'] === undefined) {
    throw new QualitySettingsError('Исключение должно задавать правило, путь или требование', 400);
  }
  const document = await editableConfig(root);
  const current = document.get('exclude');
  if (isSeq(current)) current.add(document.createNode(item));
  else document.set('exclude', document.createNode([item]));
  await saveConfig(root, document);
}

/** Удаляет исключение по номеру в `exclude`. */
export async function removeExclusion(root: string, index: number): Promise<void> {
  const document = await editableConfig(root);
  const current = document.get('exclude');
  if (!isSeq(current) || !Number.isInteger(index) || index < 0 || index >= current.items.length) {
    throw new QualitySettingsError(`Исключения №${index + 1} нет`, 404);
  }
  current.delete(index);
  if (current.items.length === 0) document.delete('exclude');
  await saveConfig(root, document);
}
