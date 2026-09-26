import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix, sep, win32 } from 'node:path';

/**
 * Запуск внешних программ одинаково на Linux, macOS и Windows.
 *
 * На Windows npm ставит CLI не исполняемым файлом, а обёрткой `.cmd`, которая
 * вызывает `node <скрипт>.js`. Запустить `.cmd` без оболочки нельзя, а через
 * `cmd.exe` не проходит многострочный аргумент — промпт агента обрезался бы на
 * первой строке. Поэтому обёртка разбирается, и скрипт запускается напрямую
 * текущим Node.
 */

export interface ResolvedCommand {
  readonly command: string;
  /** Аргументы перед пользовательскими: путь к скрипту для `node`. */
  readonly prefix: readonly string[];
}

/** Что запускает обёртка `.cmd`: скрипт через Node или исполняемый файл. */
export type ShimLaunch =
  | {
      readonly kind: 'node';
      /** Node из обёртки, если она называет его путём; `null` — текущий Node. */
      readonly node: string | null;
      /** Флаги Node, скрипт и аргументы перед `%*`. */
      readonly args: readonly string[];
    }
  | { readonly kind: 'exe'; readonly exe: string; readonly args: readonly string[] };

const SCRIPT = /\.(?:c|m)?js$/i;
const WINDOWS_SHIM = /\.(?:cmd|bat)$/i;
const NODE = /(?:^|\\)node(?:\.exe)?$/i;
const cache = new Map<string, ResolvedCommand>();

/**
 * Разбирает обёртку `.cmd`: что она запускает с аргументами `%*`.
 *
 * Понимает обёртки npm (`cmd-shim`) и собственные обёртки установщиков:
 * `%~dp0` с обратной косой чертой и без, переменные из `SET` (в том числе
 * `SET "имя=значение"`), пути в кавычках и без, свой `node.exe` рядом с
 * обёрткой, флаги Node и аргументы перед `%*`. Возвращает `null`, если строку
 * запуска не удалось свести к Node-скрипту или `.exe` с известными путями.
 */
export function parseShim(shimPath: string, text: string, env: NodeJS.ProcessEnv = {}): ShimLaunch | null {
  const dir = win32.dirname(shimPath);
  const vars = new Map<string, string>();
  const expand = (value: string): string =>
    value
      .replace(/%~dp0\\?/gi, `${dir}\\`)
      .replace(/%([A-Za-z_][\w]*)%\\?/g, (whole, name: string) => {
        const known = vars.get(name.toLowerCase()) ?? envValue(env, name);
        if (known === undefined) return whole;
        // `%dp0%\` при dp0, уже оканчивающемся на `\`, не должен давать `\\`.
        return whole.endsWith('\\') && !known.endsWith('\\') ? `${known}\\` : known;
      });

  let launch: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^@/, '').replace(/^\(\s*/, '').replace(/\s*\)$/, '');
    if (/^(?:rem\b|::)/i.test(line)) continue;
    const set = /^set\s+"?([A-Za-z_][\w]*)=([^"]*)"?\s*$/i.exec(line);
    if (set !== null) {
      vars.set(set[1]!.toLowerCase(), expand(set[2]!));
      continue;
    }
    if (line.includes('%*')) launch = line;
  }
  if (launch === null) return null;

  // Из цепочки `a & b || c` нужна команда, которой передаются аргументы.
  const segment = splitUnquoted(launch).find((part) => part.includes('%*'));
  if (segment === undefined) return null;
  const tokens = [...segment.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '');
  const rest = tokens.indexOf('%*');
  if (rest <= 0) return null;
  const head = tokens.slice(0, rest).map(expand);
  if (/^call$/i.test(head[0] ?? '')) head.shift();
  if (head.length === 0 || head.some((token) => token.includes('%'))) return null;

  const scriptAt = head.findIndex((token) => SCRIPT.test(token));
  if (scriptAt >= 0) {
    if (!win32.isAbsolute(head[scriptAt]!)) return null;
    const first = head[0]!;
    if (scriptAt > 0 && !NODE.test(first)) return null;
    const node = scriptAt > 0 && win32.isAbsolute(first) ? win32.normalize(first) : null;
    const args = head.slice(scriptAt > 0 ? 1 : 0).map((token, index) =>
      index + (scriptAt > 0 ? 1 : 0) === scriptAt ? win32.normalize(token) : token,
    );
    return { kind: 'node', node, args };
  }

  const exe = head[0]!;
  if (!/\.exe$/i.test(exe) || !win32.isAbsolute(exe) || NODE.test(exe)) return null;
  return { kind: 'exe', exe: win32.normalize(exe), args: head.slice(1) };
}

/** Путь к скрипту, который вызывает обёртка; `null`, если это не Node-скрипт. */
export function shimTarget(shimPath: string, text: string): string | null {
  const launch = parseShim(shimPath, text);
  return launch?.kind === 'node' ? (launch.args.find((arg) => SCRIPT.test(arg)) ?? null) : null;
}

/** Как запустить исполняемый файл: напрямую или через текущий Node. */
export function resolveCommand(bin: string, platform: NodeJS.Platform = process.platform): ResolvedCommand {
  const cached = cache.get(bin);
  if (cached !== undefined) return cached;

  let resolved: ResolvedCommand = { command: bin, prefix: [] };
  if (SCRIPT.test(bin)) {
    resolved = { command: process.execPath, prefix: [bin] };
  } else if (platform === 'win32' && WINDOWS_SHIM.test(bin)) {
    try {
      const launch = parseShim(bin, readFileSync(bin, 'utf8'), process.env);
      if (launch?.kind === 'exe') resolved = { command: launch.exe, prefix: launch.args };
      if (launch?.kind === 'node') {
        const node = launch.node !== null && existsSync(launch.node) ? launch.node : process.execPath;
        resolved = { command: node, prefix: launch.args };
      }
    } catch {
      // Обёртка не читается — ошибку покажет сам запуск.
    }
  }
  cache.set(bin, resolved);
  return resolved;
}

/** Обёртка `.cmd`, которую не удалось свести к запуску скрипта. */
export function isUnresolvedShim(bin: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && WINDOWS_SHIM.test(bin) && resolveCommand(bin, platform).command === bin;
}

/** Строка запуска из обёртки — для сообщения, когда её не удалось разобрать. */
export function shimLaunchLine(bin: string): string | null {
  try {
    const lines = readFileSync(bin, 'utf8').split(/\r?\n/).map((line) => line.trim());
    return lines.filter((line) => line.includes('%*')).at(-1) ?? null;
  } catch {
    return null;
  }
}

/** Аргумент нельзя безопасно передать через `cmd.exe`. */
export class UnsafeShellArgumentError extends Error {
  constructor(readonly argument: string) {
    super(
      `Аргумент «${argument.length > 60 ? `${argument.slice(0, 60)}…` : argument}» нельзя передать через cmd.exe: ` +
        'в нём перевод строки, кавычка или знак %.',
    );
    this.name = 'UnsafeShellArgumentError';
  }
}

/** Готовая к `spawn` команда. */
export interface SpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  /** Аргументы уже закавычены для `cmd.exe` — Node не должен их трогать. */
  readonly verbatim: boolean;
}

/**
 * Как запустить программу с аргументами. Нераспознанная обёртка `.cmd`
 * запускается через `cmd.exe` — Node не запускает `.cmd` без оболочки. Каждый
 * аргумент при этом закавычивается; то, что `cmd.exe` исказил бы (перевод
 * строки, кавычка, `%`), не передаётся вовсе, а даёт ошибку.
 */
export function spawnPlan(bin: string, args: readonly string[], platform: NodeJS.Platform = process.platform): SpawnPlan {
  if (!isUnresolvedShim(bin, platform)) {
    const { command, prefix } = resolveCommand(bin, platform);
    return { command, args: [...prefix, ...args], verbatim: false };
  }
  const line = [bin, ...args].map(cmdQuote).join(' ');
  return {
    command: envValue(process.env, 'ComSpec') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

function cmdQuote(arg: string): string {
  if (/[\r\n"%]/.test(arg)) throw new UnsafeShellArgumentError(arg);
  return arg !== '' && /^[\w@+=:,./\\-]+$/.test(arg) ? arg : `"${arg}"`;
}

/** Делит строку `cmd.exe` по `&`, `&&`, `||` и `|` вне кавычек. */
function splitUnquoted(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === '&' || char === '|')) {
      if (current.trim() !== '') parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Кандидаты исполняемого файла в каталоге. На Windows имя дополняется
 * расширениями из PATHEXT: `gigacode` ставится как `gigacode.cmd`.
 */
export function executableCandidates(
  dir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD',
): string[] {
  const path = platform === 'win32' ? win32 : posix;
  if (platform !== 'win32') return [path.join(dir, name)];
  const extensions = pathExt
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext !== '');
  // Файл без расширения на Windows — сценарий оболочки, запустить его нельзя.
  if (extensions.some((ext) => name.toLowerCase().endsWith(ext))) return [path.join(dir, name)];
  return extensions.map((ext) => path.join(dir, `${name}${ext}`));
}

/**
 * Запуск с собственной группой процессов там, где она есть. `stdin` — текст,
 * который получит программа на стандартный ввод; без него ввод закрыт.
 */
export function spawnTree(
  bin: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
): ChildProcess {
  const plan = spawnPlan(bin, args);
  const child = spawn(plan.command, [...plan.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    // POSIX: своя группа, чтобы остановка сняла и дочерние процессы. На
    // Windows группа не нужна (дерево снимает taskkill), а detached открыл бы
    // новое окно консоли.
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: plan.verbatim,
  });
  if (options.stdin !== undefined && child.stdin !== null) {
    // Программа может выйти, не дочитав ввод, — это не ошибка запуска.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin);
  }
  return child;
}

/** Команда оболочки: `sh -c` на POSIX, `cmd.exe` на Windows. */
export function spawnShell(command: string, options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

/**
 * Останавливает процесс вместе с потомками. `force === false` — мягкий
 * сигнал, после которого процесс может завершиться сам.
 */
export function killTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])];
    try {
      spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    } catch {
      // taskkill недоступен — остаётся сигнал самому процессу
    }
    if (force) child.kill();
    return;
  }
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // процесс уже завершился
    }
  }
}

/** Путь для интерфейса и журналов: с прямыми слэшами на любой платформе. */
export function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}
