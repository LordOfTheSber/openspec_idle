import { accessSync, constants, statSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { executableCandidates } from '../process/platform.js';

/**
 * Откуда взят CLI: `configured` — путь из настройки или `OPENSPEC_CLI`,
 * `project` — `node_modules/.bin`, `path` — PATH, `global` — известные каталоги
 * глобальной установки npm.
 */
export type CliSource = 'configured' | 'project' | 'path' | 'global';

/** Где искали исполняемый файл и что нашли. */
export type CliLocation =
  | { readonly kind: 'found'; readonly bin: string; readonly source: CliSource }
  | {
      readonly kind: 'not-found';
      readonly searched: readonly string[];
      /** Заданный явно путь, по которому CLI не нашёлся; `null` — путь не задавался. */
      readonly configured: string | null;
    };

export interface LocateOptions {
  /** Путь из настроек IDE — к исполняемому файлу или к каталогу с ним. */
  readonly configured?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Каталоги глобальной установки вместо известных — нужно тестам. */
  readonly globalDirs?: readonly string[];
}

const BIN_NAME = 'openspec';
/** Переменная окружения с путём к CLI — для запуска IDE вне VS Code. */
export const CLI_ENV = 'OPENSPEC_CLI';
/** Настройка VS Code с путём к CLI. */
export const CLI_SETTING = 'openspec.cliPath';

const SCRIPT = /\.(?:c|m)?js$/i;

/**
 * Ищет исполняемый файл CLI OpenSpec: по явно заданному пути, затем в
 * `node_modules/.bin` проекта и выше по дереву, в PATH и в каталогах
 * глобальной установки npm.
 *
 * Подъём по дереву обязателен: npm так же разрешает бинари, и в
 * монорепозитории зависимость обычно стоит в корне, а не в каталоге пакета.
 * Глобальные каталоги нужны потому, что PATH процесса редактора берётся при
 * его запуске: CLI, поставленный позже или через `.bashrc` Git Bash, в нём не
 * виден, хотя в терминале работает. Явный путь, если задан, не подменяется
 * найденным в другом месте — иначе ошибка в настройке осталась бы незамеченной.
 * Перечень просмотренных путей возвращается, чтобы сообщение об ошибке могло
 * его показать — иначе «не найден» ничего не объясняет.
 */
export function locateOpenspecCli(root: string, options: LocateOptions = {}): CliLocation {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathExt = envValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD';
  const searched: string[] = [];
  const probe = (candidates: readonly string[], source: CliSource): CliLocation | null => {
    for (const candidate of candidates) {
      if (searched.includes(candidate)) continue;
      searched.push(candidate);
      if (isRunnable(candidate)) return { kind: 'found', bin: candidate, source };
    }
    return null;
  };

  const configured = nonEmpty(options.configured) ?? nonEmpty(envValue(env, CLI_ENV, platform));
  if (configured !== null) {
    const found = probe(configuredCandidates(configured, root, { env, platform, pathExt }), 'configured');
    return found ?? { kind: 'not-found', searched, configured };
  }

  let current = root;
  for (;;) {
    const found = probe(executableCandidates(join(current, 'node_modules', '.bin'), BIN_NAME, platform, pathExt), 'project');
    if (found !== null) return found;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of (envValue(env, 'PATH', platform) ?? '').split(delimiter)) {
    if (dir === '') continue;
    const found = probe(executableCandidates(dir, BIN_NAME, platform, pathExt), 'path');
    if (found !== null) return found;
  }

  for (const dir of options.globalDirs ?? globalBinDirs(env, platform)) {
    const found = probe(executableCandidates(dir, BIN_NAME, platform, pathExt), 'global');
    if (found !== null) return found;
  }

  return { kind: 'not-found', searched, configured: null };
}

/**
 * Кандидаты по явно заданному пути. Принимает то, что человек скопирует из
 * терминала: путь в кавычках, `~/…`, путь Git Bash вида `/c/Users/…` и имя без
 * расширения, которое печатает `which openspec` на Windows, — к нему
 * подставляются расширения из PATHEXT. Каталог означает «CLI лежит в нём».
 */
export function configuredCandidates(
  value: string,
  root: string,
  options: { readonly env: NodeJS.ProcessEnv; readonly platform: NodeJS.Platform; readonly pathExt: string },
): string[] {
  const { env, platform, pathExt } = options;
  const path = platform === 'win32' ? win32 : posix;
  let raw = value.trim().replace(/^(["'])(.*)\1$/, '$2');

  const home = homeDir(env, platform);
  if (home !== null && (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\'))) {
    raw = path.join(home, raw.slice(1));
  }
  if (platform === 'win32') {
    const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(raw);
    if (msys !== null) raw = `${msys[1]!.toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`;
  }
  const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);

  if (isDirectory(absolute)) return executableCandidates(absolute, BIN_NAME, platform, pathExt);
  if (platform !== 'win32' || SCRIPT.test(absolute)) return [absolute];
  // `…\npm\openspec` — сценарий оболочки для Git Bash; рядом лежит `openspec.cmd`.
  const extensions = pathExt.split(';').map((ext) => ext.trim().toLowerCase()).filter((ext) => ext !== '');
  if (extensions.some((ext) => absolute.toLowerCase().endsWith(ext))) return [absolute];
  return extensions.map((ext) => `${absolute}${ext}`);
}

/**
 * Каталоги, куда npm и менеджеры версий Node кладут глобальные CLI, если их
 * нет в PATH процесса.
 */
export function globalBinDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const get = (name: string): string | null => nonEmpty(envValue(env, name, platform));
  const dirs: string[] = [];
  const add = (...parts: (string | null)[]): void => {
    if (parts.some((part) => part === null)) return;
    const dir = path.join(...(parts as string[]));
    if (!dirs.includes(dir)) dirs.push(dir);
  };

  // Префикс npm: на Windows CLI лежат в нём самом, на POSIX — в bin/.
  const prefix = get('npm_config_prefix') ?? get('NPM_CONFIG_PREFIX');
  if (platform === 'win32') {
    add(prefix);
    add(get('APPDATA'), 'npm');
    add(get('NVM_SYMLINK'));
    add(get('LOCALAPPDATA'), 'Volta', 'bin');
    const fnm = get('FNM_DIR');
    if (fnm === null) add(get('APPDATA'), 'fnm', 'aliases', 'default');
    else add(fnm, 'aliases', 'default');
    add(get('ProgramFiles'), 'nodejs');
    return dirs;
  }

  const home = homeDir(env, platform);
  add(prefix, 'bin');
  add(get('NVM_BIN'));
  const volta = get('VOLTA_HOME');
  if (volta === null) add(home, '.volta', 'bin');
  else add(volta, 'bin');
  add(home, '.npm-global', 'bin');
  add(home, '.local', 'bin');
  add('/usr/local/bin');
  add('/opt/homebrew/bin');
  return dirs;
}

/** Текст блокирующего уведомления, когда CLI не найден. */
export function missingCliNotice(location: Extract<CliLocation, { kind: 'not-found' }>): {
  readonly title: string;
  readonly tool: string;
  readonly install: string;
  readonly hint: string;
  readonly configured: string | null;
  readonly searched: readonly string[];
} {
  const configured = location.configured;
  return {
    title:
      configured === null
        ? 'Не найден CLI OpenSpec — без него IDE не может читать проект'
        : `CLI OpenSpec не найден по заданному пути «${configured}»`,
    tool: '@fission-ai/openspec',
    install: 'npm install -D @fission-ai/openspec',
    hint:
      configured === null
        ? 'Если openspec работает в терминале, IDE его не видит: PATH редактора берётся при запуске. ' +
          'Перезапустите VS Code полностью или укажите путь из «which openspec» (Git Bash) или ' +
          `«where openspec» (cmd) в настройке ${CLI_SETTING} либо в переменной ${CLI_ENV}.`
        : `Проверьте путь в настройке ${CLI_SETTING} или в переменной ${CLI_ENV}: ` +
          'нужен исполняемый файл openspec или каталог, где он лежит.',
    configured,
    searched: location.searched,
  };
}

/** Переменная окружения; на Windows имена без учёта регистра (`Path`). */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[name];
  if (direct !== undefined || platform !== 'win32') return direct;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function homeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  return nonEmpty(envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform));
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // Скрипт запускается текущим Node — признак исполняемости ему не нужен.
    if (SCRIPT.test(path)) return true;
    // На Windows признака исполняемости нет: X_OK проверяет лишь наличие.
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

