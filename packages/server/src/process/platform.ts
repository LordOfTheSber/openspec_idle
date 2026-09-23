import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const SCRIPT = /\.(?:c|m)?js$/i;
const WINDOWS_SHIM = /\.(?:cmd|bat)$/i;
const cache = new Map<string, ResolvedCommand>();

/** Путь к скрипту, который вызывает обёртка npm (`cmd-shim`); `null`, если не распознана. */
export function shimTarget(shimPath: string, text: string): string | null {
  const relative = /"%~?dp0%?\\([^"]+?\.(?:c|m)?js)"/i.exec(text)?.[1];
  if (relative !== undefined) return win32.join(win32.dirname(shimPath), relative);
  const absolute = /"([A-Za-z]:\\[^"]+?\.(?:c|m)?js)"/.exec(text)?.[1];
  return absolute ?? null;
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
      const target = shimTarget(bin, readFileSync(bin, 'utf8'));
      if (target !== null) resolved = { command: process.execPath, prefix: [target] };
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

/** Запуск с собственной группой процессов там, где она есть. */
export function spawnTree(
  bin: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
  const { command, prefix } = resolveCommand(bin);
  return spawn(command, [...prefix, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: своя группа, чтобы остановка сняла и дочерние процессы. На
    // Windows группа не нужна (дерево снимает taskkill), а detached открыл бы
    // новое окно консоли.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
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
