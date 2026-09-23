import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, posix, relative } from 'node:path';
import type { ModuleDef, ModuleKind } from '@openspec-ide/core';
import { toPosixPath } from '../process/platform.js';
import { GitIgnore } from './gitignore.js';

/** Каталоги зависимостей, сборки и служебные — не обходятся никогда. */
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  'bin',
  'obj',
  '.git',
  '.gradle',
  '.idea',
  '.vscode',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'coverage',
  '.openspec-ide',
  'openspec',
]);

/** Каталоги-контейнеры: их имя не входит в id модуля (`services/billing` → `billing`). */
const CONTAINERS = new Set([
  'services',
  'service',
  'apps',
  'app',
  'packages',
  'libs',
  'lib',
  'modules',
  'components',
  'projects',
  'src',
]);

const MAX_DEPTH = 8;

export type ManifestKind = 'npm' | 'maven' | 'gradle' | 'go' | 'dotnet' | 'python';

/** Модуль, найденный по манифесту. */
export interface DiscoveredModule {
  readonly id: string;
  readonly title: string;
  readonly kind: ModuleKind;
  /** Каталог кода от корня репозитория, через `/`. */
  readonly path: string;
  readonly specs: string;
  readonly group: string | null;
  readonly dependsOn: readonly string[];
  /** Манифест, по которому найден модуль. */
  readonly manifest: string;
  readonly manifestKind: ManifestKind;
}

/** Что манифест говорит о модуле до сопоставления зависимостей. */
interface ManifestInfo {
  readonly dir: string;
  readonly manifest: string;
  readonly manifestKind: ManifestKind;
  /** Имена, по которым на модуль ссылаются другие манифесты. */
  readonly names: readonly string[];
  /** Ссылки на другие модули: имена или пути каталогов (`path:` + каталог). */
  readonly references: readonly string[];
  readonly kind: ModuleKind;
  readonly title: string | null;
  /** Агрегатор (корневой pom, workspaces) — сам модулем не считается. */
  readonly aggregator: boolean;
}

/**
 * Обходит репозиторий и находит модули по манифестам сборки. Каталоги
 * зависимостей и сборки и файлы из `.gitignore` пропускаются.
 */
export async function discoverModules(root: string): Promise<DiscoveredModule[]> {
  const ignore = await GitIgnore.load(root);
  const found: ManifestInfo[] = [];
  // Каталоги с settings.gradle: есть ли в них подпроекты (include).
  const gradleRoots = new Map<string, boolean>();

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const read = (name: string): Promise<string | null> => readText(join(root, dir, name));
    for (const settings of ['settings.gradle.kts', 'settings.gradle']) {
      if (!files.has(settings)) continue;
      const text = (await read(settings)) ?? '';
      gradleRoots.set(dir, /^\s*include\b/m.test(text));
      break;
    }
    const info = await readManifest(dir, files, read, gradleRoots);
    if (info !== null) found.push(info);

    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (ignore.ignores(child, true)) continue;
      await walk(child, depth + 1);
    }
  };
  await walk('', 0);

  const modules = found.filter((info) => !info.aggregator);
  const ids = assignIds(modules.map((info) => info.dir));
  const byName = new Map<string, string>();
  const byDir = new Map<string, string>();
  modules.forEach((info, index) => {
    const id = ids[index]!;
    byDir.set(info.dir, id);
    for (const name of info.names) if (!byName.has(name)) byName.set(name, id);
  });

  return modules.map((info, index) => {
    const id = ids[index]!;
    const dependsOn: string[] = [];
    for (const reference of info.references) {
      const target = reference.startsWith('path:') ? byDir.get(reference.slice(5)) : byName.get(reference);
      if (target !== undefined && target !== id && !dependsOn.includes(target)) dependsOn.push(target);
    }
    const segments = info.dir.split('/');
    return {
      id,
      title: info.title ?? id,
      kind: info.kind,
      path: info.dir === '' ? '.' : info.dir,
      specs: id,
      group: segments.length > 1 ? segments[0]! : null,
      dependsOn,
      manifest: info.dir === '' ? info.manifest : `${info.dir}/${info.manifest}`,
      manifestKind: info.manifestKind,
    };
  });
}

/** id модуля из каталога: без каталога-контейнера, уникальный. */
export function assignIds(dirs: readonly string[]): string[] {
  const short = dirs.map((dir) => {
    if (dir === '') return 'root';
    const segments = dir.split('/');
    return segments.length > 1 && CONTAINERS.has(segments[0]!.toLowerCase()) ? segments.slice(1).join('/') : dir;
  });
  const counts = new Map<string, number>();
  for (const id of short) counts.set(id, (counts.get(id) ?? 0) + 1);
  return short.map((id, index) => ((counts.get(id) ?? 0) > 1 ? dirs[index]! : id));
}

async function readManifest(
  dir: string,
  files: ReadonlySet<string>,
  read: (name: string) => Promise<string | null>,
  gradleRoots: ReadonlyMap<string, boolean>,
): Promise<ManifestInfo | null> {
  const npm = files.has('package.json') ? npmManifest(dir, (await read('package.json')) ?? '') : null;
  // Сборка JVM важнее package.json рядом (фронтенд, собираемый Maven): модуль
  // описывает pom или Gradle, а UI-зависимости только уточняют вид.
  const jvm = await jvmManifest(dir, files, read, gradleRoots);
  if (jvm !== null) return npm?.kind === 'ui' ? { ...jvm, kind: 'ui' } : jvm;
  if (npm !== null) return npm;
  if (files.has('go.mod')) {
    const text = await read('go.mod');
    if (text !== null) return goManifest(dir, text, files);
  }
  const csproj = [...files].find((name) => name.endsWith('.csproj'));
  if (csproj !== undefined) {
    const text = await read(csproj);
    if (text !== null) return dotnetManifest(dir, csproj, text);
  }
  if (files.has('pyproject.toml')) {
    const text = await read('pyproject.toml');
    if (text !== null) return pythonManifest(dir, text);
  }
  return null;
}

async function jvmManifest(
  dir: string,
  files: ReadonlySet<string>,
  read: (name: string) => Promise<string | null>,
  gradleRoots: ReadonlyMap<string, boolean>,
): Promise<ManifestInfo | null> {
  if (files.has('pom.xml')) {
    const text = await read('pom.xml');
    if (text !== null) return mavenManifest(dir, text);
  }
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    if (!files.has(name)) continue;
    const text = await read(name);
    if (text !== null) return gradleManifest(dir, name, text, gradleRoots);
  }
  return null;
}

const UI_PACKAGES = ['react', 'vue', '@angular/core', 'svelte', 'next', 'nuxt', 'solid-js', 'preact', 'lit'];

export function npmManifest(dir: string, text: string): ManifestInfo | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : null;
  const keys = (key: string): string[] => Object.keys((manifest[key] as Record<string, unknown> | undefined) ?? {});
  const dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(keys);
  const scripts = (manifest['scripts'] as Record<string, unknown> | undefined) ?? {};
  // peerDependencies на React — признак библиотеки компонентов, а не приложения.
  const own = [...keys('dependencies'), ...keys('devDependencies')];
  const kind: ModuleKind = own.some((dependency) => UI_PACKAGES.includes(dependency))
    ? 'ui'
    : 'start' in scripts || 'serve' in scripts || manifest['bin'] !== undefined
      ? 'service'
      : 'library';
  return {
    dir,
    manifest: 'package.json',
    manifestKind: 'npm',
    names: name === null ? [] : [name],
    references: dependencies,
    kind,
    title: null,
    aggregator: manifest['workspaces'] !== undefined,
  };
}

export function mavenManifest(dir: string, text: string): ManifestInfo {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(withoutComments)?.[1] ?? '';
  // Собственные координаты — вне parent, dependencies, build и профилей.
  const own = withoutComments
    .replace(/<parent>[\s\S]*?<\/parent>/g, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, '');
  const artifactId = tag(own, 'artifactId');
  const groupId = tag(own, 'groupId') ?? tag(parent, 'groupId');
  const packaging = tag(own, 'packaging');
  const dependencySection = withoutComments
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .match(/<dependencies>([\s\S]*?)<\/dependencies>/g) ?? [];
  const references: string[] = [];
  for (const section of dependencySection) {
    for (const match of section.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const body = match[1] ?? '';
      const depArtifact = tag(body, 'artifactId');
      const depGroup = tag(body, 'groupId');
      if (depArtifact === null) continue;
      const group = depGroup === null || depGroup.includes('${project.groupId}') ? groupId : depGroup;
      references.push(group === null ? depArtifact : `${group}:${depArtifact}`);
    }
  }
  const isService = /spring-boot-maven-plugin|<mainClass>|quarkus-maven-plugin/.test(withoutComments);
  return {
    dir,
    manifest: 'pom.xml',
    manifestKind: 'maven',
    names: artifactId === null ? [] : [groupId === null ? artifactId : `${groupId}:${artifactId}`],
    references,
    kind: isService ? 'service' : 'library',
    title: tag(own, 'name'),
    aggregator: packaging === 'pom',
  };
}

export function gradleManifest(
  dir: string,
  manifest: string,
  text: string,
  gradleRoots: ReadonlyMap<string, boolean>,
): ManifestInfo {
  // Путь проекта Gradle — от ближайшего каталога с settings.gradle выше.
  let base = '';
  for (const candidate of gradleRoots.keys()) {
    if ((candidate === '' || dir === candidate || dir.startsWith(`${candidate}/`)) && candidate.length >= base.length) {
      base = candidate;
    }
  }
  const relativeDir = base === '' ? dir : dir === base ? '' : dir.slice(base.length + 1);
  const projectPath = `:${relativeDir.split('/').filter(Boolean).join(':')}`;
  const references: string[] = [];
  for (const match of text.matchAll(/project\s*\(\s*(?:path\s*[:=]\s*)?["']([^"']+)["']/g)) {
    references.push(`gradle:${base}|${match[1]}`);
  }
  const isService = /org\.springframework\.boot|id\s*\(?\s*["']application["']|\bapplication\s*\{|io\.quarkus|io\.ktor\.plugin/.test(text);
  return {
    dir,
    manifest,
    manifestKind: 'gradle',
    names: [`gradle:${base}|${projectPath}`],
    references,
    kind: isService ? 'service' : 'library',
    title: null,
    // Корневой проект многомодульной сборки (settings.gradle с include) — агрегатор.
    aggregator: gradleRoots.get(dir) === true,
  };
}

export function goManifest(dir: string, text: string, files: ReadonlySet<string>): ManifestInfo {
  const name = /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
  const references: string[] = [];
  const requireBlock = [...text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)].map((match) => match[1] ?? '').join('\n');
  const requireLines = [...text.matchAll(/^require\s+([^\s(]+)\s/gm)].map((match) => match[1] ?? '');
  for (const line of requireBlock.split('\n')) {
    const module = line.trim().split(/\s+/)[0];
    if (module !== undefined && module !== '' && !module.startsWith('//')) references.push(module);
  }
  references.push(...requireLines);
  for (const match of text.matchAll(/^\s*(?:replace\s+)?(\S+)(?:\s+\S+)?\s+=>\s+(\.{1,2}\/\S*)/gm)) {
    const target = posix.normalize(posix.join(dir, match[2]!));
    references.push(`path:${target === '.' ? '' : target}`);
  }
  return {
    dir,
    manifest: 'go.mod',
    manifestKind: 'go',
    names: name === null ? [] : [name],
    references,
    kind: files.has('main.go') || /\bpackage main\b/.test(text) ? 'service' : 'library',
    title: null,
    aggregator: false,
  };
}

export function dotnetManifest(dir: string, file: string, text: string): ManifestInfo {
  const references: string[] = [];
  for (const match of text.matchAll(/<ProjectReference\s+Include\s*=\s*"([^"]+)"/g)) {
    const target = posix.normalize(posix.join(dir, dirname(match[1]!.replace(/\\/g, '/'))));
    references.push(`path:${target === '.' ? '' : target}`);
  }
  const isService = /Sdk="Microsoft\.NET\.Sdk\.Web"|<OutputType>\s*Exe\s*<\/OutputType>/i.test(text);
  return {
    dir,
    manifest: file,
    manifestKind: 'dotnet',
    names: [basename(file, '.csproj')],
    references,
    kind: isService ? 'service' : 'library',
    title: null,
    aggregator: false,
  };
}

export function pythonManifest(dir: string, text: string): ManifestInfo {
  const section = (name: string): string => {
    const start = text.search(new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\s*$`, 'm'));
    if (start === -1) return '';
    const rest = text.slice(start).split('\n').slice(1);
    const end = rest.findIndex((line) => /^\[/.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n');
  };
  const project = section('project');
  const poetry = section('tool.poetry');
  const name = /^name\s*=\s*["']([^"']+)["']/m.exec(project)?.[1] ?? /^name\s*=\s*["']([^"']+)["']/m.exec(poetry)?.[1] ?? null;
  const references: string[] = [];
  const list = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(project)?.[1] ?? '';
  for (const match of list.matchAll(/["']([A-Za-z0-9._-]+)/g)) references.push(pythonName(match[1]!));
  for (const line of section('tool.poetry.dependencies').split('\n')) {
    const key = /^([A-Za-z0-9._-]+)\s*=/.exec(line)?.[1];
    if (key !== undefined && key !== 'python') references.push(pythonName(key));
  }
  const isService = section('project.scripts') !== '' || section('tool.poetry.scripts') !== '';
  return {
    dir,
    manifest: 'pyproject.toml',
    manifestKind: 'python',
    names: name === null ? [] : [pythonName(name)],
    references,
    kind: isService ? 'service' : 'library',
    title: null,
    aggregator: false,
  };
}

function pythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function tag(xml: string, name: string): string | null {
  const value = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];
  return value === undefined || value === '' ? null : value;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Расхождения найденного с картой: чего в карте нет и какие зависимости разошлись. */
export interface DiscoveryDiff {
  /** Модули из кода, которых нет в карте (по каталогу кода). */
  readonly added: readonly DiscoveredModule[];
  /** Модули карты, у которых зависимости в коде отличаются от карты. */
  readonly dependencyChanges: readonly {
    readonly id: string;
    readonly add: readonly string[];
    readonly remove: readonly string[];
  }[];
  /** Модули карты, чей каталог больше не содержит манифеста. */
  readonly missing: readonly string[];
}

/**
 * Сравнивает найденное с существующей картой. Модули сопоставляются по
 * каталогу кода: id и префикс в карте могли переименовать руками.
 */
export function diffWithMap(discovered: readonly DiscoveredModule[], map: readonly ModuleDef[]): DiscoveryDiff {
  const byPath = new Map(map.filter((module) => module.path !== null).map((module) => [module.path!, module]));
  // Зависимости найденных модулей выражены id черновика; переводим в id карты.
  const draftToMap = new Map<string, string>();
  for (const module of discovered) {
    const known = byPath.get(module.path);
    if (known !== undefined) draftToMap.set(module.id, known.id);
  }
  const added = discovered.filter((module) => !byPath.has(module.path));
  const dependencyChanges: { id: string; add: string[]; remove: string[] }[] = [];
  for (const module of discovered) {
    const known = byPath.get(module.path);
    if (known === undefined) continue;
    const inCode = module.dependsOn.map((id) => draftToMap.get(id) ?? id);
    const add = inCode.filter((id) => !known.dependsOn.includes(id));
    // Убрать предлагается только связь, которую сканер мог бы увидеть: на
    // модуль той же системы сборки. Связь сервиса npm с библиотекой Maven
    // заведена руками — манифесты её не выражают.
    const sameBuild = new Set(
      discovered
        .filter((entry) => entry.manifestKind === module.manifestKind)
        .map((entry) => draftToMap.get(entry.id) ?? entry.id),
    );
    const remove = known.dependsOn.filter((id) => sameBuild.has(id) && !inCode.includes(id));
    if (add.length > 0 || remove.length > 0) dependencyChanges.push({ id: known.id, add, remove });
  }
  const discoveredPaths = new Set(discovered.map((module) => module.path));
  const missing = map.filter((module) => module.path !== null && !discoveredPaths.has(module.path)).map((module) => module.id);
  return { added, dependencyChanges, missing };
}

/** Путь от корня через `/` — для сообщений. */
export function relativePath(root: string, path: string): string {
  return toPosixPath(relative(root, path));
}
