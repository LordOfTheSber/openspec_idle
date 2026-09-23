import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { executableCandidates, resolveCommand } from '../process/platform.js';

export type EditorKind = 'idea' | 'vscode';

/** Команды по умолчанию: на Windows IDEA ставится как `idea64.exe`. */
const DEFAULT_COMMANDS: Readonly<Record<EditorKind, readonly string[]>> = {
  idea: ['idea', 'idea64'],
  vscode: ['code'],
};

/** Команда редактора не найдена. */
export class EditorNotFoundError extends Error {
  constructor(
    readonly command: string,
    readonly searched: readonly string[],
  ) {
    super(`Не найдена команда редактора «${command}». Укажите путь к ней в настройках.`);
    this.name = 'EditorNotFoundError';
  }
}

/** Аргументы открытия файла на строке. */
export function editorArgs(kind: EditorKind, file: string, line: number): string[] {
  return kind === 'idea' ? ['--line', String(line), file] : ['-g', `${file}:${line}`];
}

/** Находит исполняемый файл редактора: путь из настроек или PATH. */
export function locateEditor(
  kind: EditorKind,
  command: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { bin: string } | { searched: string[] } {
  const names = command === null || command.trim() === '' ? DEFAULT_COMMANDS[kind] : [command.trim()];
  const searched: string[] = [];
  for (const name of names) {
    if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
      searched.push(name);
      if (isExecutable(name)) return { bin: name };
      continue;
    }
    for (const dir of (env['PATH'] ?? '').split(delimiter)) {
      if (dir === '') continue;
      for (const candidate of executableCandidates(dir, name)) {
        searched.push(candidate);
        if (isExecutable(candidate)) return { bin: candidate };
      }
    }
  }
  return { searched };
}

/**
 * Открывает файл во внешнем редакторе. Без оболочки: обёртки npm разбираются
 * так же, как при запуске агента. Обёртки `.cmd` самих редакторов (VS Code на
 * Windows) запускаются через `cmd.exe` — им нужен их собственный исполняемый
 * файл, а не текущий Node.
 */
export function openInEditor(options: {
  readonly kind: EditorKind;
  readonly command: string | null;
  readonly root: string;
  readonly path: string;
  readonly line: number;
  readonly env?: NodeJS.ProcessEnv;
}): { command: string; args: string[] } {
  const env = options.env ?? process.env;
  const located = locateEditor(options.kind, options.command, env);
  if (!('bin' in located)) {
    throw new EditorNotFoundError(options.command ?? DEFAULT_COMMANDS[options.kind].join(' / '), located.searched);
  }
  const file = join(options.root, options.path);
  if (!existsSync(file)) throw new Error(`Файл ${options.path} не найден`);
  const args = editorArgs(options.kind, file, options.line);

  const windowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(located.bin) && !/\.m?js$/i.test(located.bin);
  const resolved = resolveCommand(located.bin);
  const script = resolved.command !== located.bin;
  const child = windowsShim && !script
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[located.bin, ...args].map((part) => `"${part}"`).join(' ')}"`], {
        env,
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn(resolved.command, [...resolved.prefix, ...args], {
        env: { ...env, ...resolved.env },
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
  child.on('error', (error) => console.error(`[редактор] ${located.bin}: ${error.message}`));
  child.unref();
  return { command: located.bin, args };
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
