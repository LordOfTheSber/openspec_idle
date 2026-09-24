import { execFile } from 'node:child_process';
import { resolveCommand } from '../process/platform.js';

/** Успешный вызов CLI с разобранным JSON. */
export interface CliSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly stdout: string;
}

/** Причина, по которой вызов CLI не дал полезного результата. */
export type CliFailureKind =
  | 'not-found' // исполняемый файл не найден
  | 'exit-code' // CLI завершился ненулевым кодом
  | 'parse' // вывод не разбирается как JSON
  | 'timeout' // CLI не уложился в отведённое время
  | 'aborted'; // вызов отменён — например, его вытеснил более свежий

/** Неуспешный вызов CLI. Текст сохраняется целиком, без интерпретации. */
export interface CliFailure {
  readonly ok: false;
  readonly kind: CliFailureKind;
  /** Код возврата; `null`, если процесс не запустился или был снят. */
  readonly code: number | null;
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
}

export type CliResult<T> = CliSuccess<T> | CliFailure;

/** Настройки одного вызова CLI. */
export interface CliRunOptions {
  /** Путь к исполняемому файлу `openspec`. */
  readonly bin: string;
  /** Рабочий каталог — корень рабочего пространства. */
  readonly cwd: string;
  /** Предел времени на один вызов, мс. */
  readonly timeoutMs?: number;
  /** Сигнал отмены: прерывает выполняющийся процесс. */
  readonly signal?: AbortSignal;
  /** Переменные окружения поверх окружения процесса IDE. */
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

interface RawRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError: NodeJS.ErrnoException | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/** Запускает CLI и возвращает сырой результат, не интерпретируя его. */
export async function runCli(options: CliRunOptions, args: readonly string[]): Promise<RawRun> {
  // На Windows `openspec` из npm — обёртка `.cmd`: запускается её скрипт.
  const { command, prefix } = resolveCommand(options.bin);
  return new Promise<RawRun>((resolve) => {
    execFile(
      command,
      [...prefix, ...args],
      // windowsHide: без него на Windows мелькает окно консоли на каждый вызов.
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, NO_COLOR: '1', ...options.env },
        windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, spawnError: null, timedOut: false, aborted: false });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        const spawnFailed = err.code === 'ENOENT' || err.code === 'EACCES';
        resolve({
          code: typeof err.code === 'number' ? err.code : null,
          stdout,
          stderr,
          spawnError: spawnFailed ? err : null,
          timedOut: err.killed === true && typeof err.code !== 'number',
          aborted: err.name === 'AbortError' || options.signal?.aborted === true,
        });
      },
    );
  });
}

/**
 * Вызывает CLI и разбирает его вывод как JSON.
 *
 * Ошибка разбора никогда не выдаётся за результат: она возвращается отдельным
 * видом отказа вместе с сохранённым исходным выводом.
 */
export async function runCliJson<T>(
  options: CliRunOptions,
  args: readonly string[],
): Promise<CliResult<T>> {
  const raw = await runCli(options, args);

  if (raw.aborted) {
    return {
      ok: false,
      kind: 'aborted',
      code: null,
      message: `Вызов «openspec ${args.join(' ')}» отменён`,
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }

  if (raw.spawnError !== null) {
    return {
      ok: false,
      kind: 'not-found',
      code: null,
      message: `Не удалось запустить «${options.bin}»: ${raw.spawnError.code ?? raw.spawnError.message}`,
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }

  if (raw.timedOut) {
    return {
      ok: false,
      kind: 'timeout',
      code: null,
      message: `Команда «openspec ${args.join(' ')}» не завершилась за отведённое время`,
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }

  if (raw.code !== 0) {
    return {
      ok: false,
      kind: 'exit-code',
      code: raw.code,
      message:
        `Команда «openspec ${args.join(' ')}» завершилась с кодом ${raw.code ?? 'неизвестно'}` +
        (raw.stderr.trim() === '' ? '' : `:\n${raw.stderr.trim()}`),
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }

  const payload = stripLeadingNotices(raw.stdout);
  try {
    return { ok: true, data: JSON.parse(payload) as T, stdout: raw.stdout };
  } catch (error) {
    return {
      ok: false,
      kind: 'parse',
      code: raw.code,
      message:
        `Вывод команды «openspec ${args.join(' ')}» не разбирается как JSON: ` +
        (error instanceof Error ? error.message : String(error)),
      stdout: raw.stdout,
      stderr: raw.stderr,
    };
  }
}

/**
 * Снимает строки-примечания, которые CLI печатает перед JSON (например,
 * предупреждение об экспериментальности команд схем).
 */
function stripLeadingNotices(stdout: string): string {
  const start = stdout.search(/[[{]/);
  return start <= 0 ? stdout : stdout.slice(start);
}
