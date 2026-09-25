import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { executableCandidates, isUnresolvedShim, shimLaunchLine, spawnPlan } from '../process/platform.js';
import type { AgentConfig } from './launch.js';

/** Итог проверки доступности CLI. */
export interface ProbeResult {
  readonly ok: boolean;
  /** Найденный исполняемый файл. */
  readonly bin: string | null;
  /** Пути, где искался исполняемый файл, — показываются при неудаче. */
  readonly searched: readonly string[];
  readonly version: string | null;
  /** Формат вывода, с которым будет идти запуск. */
  readonly format: string | null;
  readonly streaming: boolean;
  /** Пояснение для пользователя: переход на одноразовый вывод и т. п. */
  readonly notice: string | null;
  /** Промпт идёт на стандартный ввод: CLI запускается через cmd.exe. */
  readonly promptViaStdin: boolean;
  readonly error: string | null;
  readonly checkedAt: string;
}

const PROBE_TIMEOUT_MS = 15_000;

/** Ищет исполняемый файл: путь как есть либо поиск по PATH. */
export async function locateExecutable(
  command: string,
  root: string,
  pathEnv: string = process.env['PATH'] ?? '',
): Promise<{ bin: string | null; searched: string[] }> {
  const candidates =
    command.includes('/') || command.includes('\\')
      ? (() => {
          const absolute = isAbsolute(command) ? command : resolve(root, command);
          return executableCandidates(dirname(absolute), basename(absolute));
        })()
      : pathEnv
          .split(delimiter)
          .filter((dir) => dir !== '')
          .flatMap((dir) => executableCandidates(dir, command));

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return { bin: candidate, searched: candidates };
    } catch {
      // нет файла или он не исполняемый — пробуем следующий путь
    }
  }
  return { bin: null, searched: candidates };
}

/** Выполняет короткую команду и собирает вывод. */
function capture(
  bin: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let plan;
    try {
      plan = spawnPlan(bin, args);
    } catch (problem) {
      done({ code: null, stdout, stderr, error: problem instanceof Error ? problem.message : String(problem) });
      return;
    }
    const child = spawn(plan.command, [...plan.args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, error: null });
    });
  });
}

/**
 * Проверяет доступность CLI: исполняемый файл, версию и поддержку потокового
 * вывода. Если сборка потоковый формат не принимает, запуск пойдёт с
 * одноразовым — и пользователь об этом узнает, а не увидит пустую панель.
 */
export async function probeAgent(
  agent: AgentConfig,
  root: string,
  now: () => string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProbeResult> {
  const { bin, searched } = await locateExecutable(agent.command, root, env['PATH'] ?? '');
  const base = { searched, checkedAt: now() };
  if (bin === null) {
    return {
      ...base,
      ok: false,
      bin: null,
      version: null,
      format: null,
      streaming: false,
      notice: null,
      promptViaStdin: false,
      error: `Исполняемый файл «${agent.command}» не найден. Проверены пути: ${searched.join(', ') || '(PATH пуст)'}`,
    };
  }

  // Обёртку, которую не удалось разобрать, запускает cmd.exe: многострочный
  // промпт через него не пройдёт, поэтому он пойдёт на стандартный ввод.
  const viaShell = isUnresolvedShim(bin);
  const shellNotice = viaShell
    ? `«${bin}» запускается через cmd.exe: строку запуска (${shimLaunchLine(bin) ?? 'не найдена'}) не удалось ` +
      'свести к скрипту Node или .exe, поэтому промпт передаётся на стандартный ввод. Если агент ответит, что ' +
      'задания не получил, укажите в настройках путь к .exe или к .js-файлу CLI.'
    : null;

  const version = await capture(bin, agent.launch.versionArgs, root, env);
  if (version.error !== null || version.code !== 0) {
    return {
      ...base,
      ok: false,
      bin,
      version: null,
      format: null,
      streaming: false,
      notice: null,
      promptViaStdin: false,
      error: `«${bin} ${agent.launch.versionArgs.join(' ')}» завершился ошибкой: ${
        version.error ?? (version.stderr.trim() || `код ${version.code}`)
      }${shellNotice === null ? '' : `. ${shellNotice}`}`,
    };
  }

  const help = await capture(bin, agent.launch.helpArgs, root, env);
  const text = `${help.stdout}\n${help.stderr}`;
  const streaming = text.includes(agent.launch.streamFormat);
  const oneShot = text.includes(agent.launch.oneShotFormat);

  return {
    ...base,
    ok: streaming || oneShot,
    bin,
    version: version.stdout.trim().split('\n')[0] ?? null,
    format: streaming ? agent.launch.streamFormat : oneShot ? agent.launch.oneShotFormat : null,
    streaming,
    notice: joinNotices(
      shellNotice,
      streaming
        ? null
        : oneShot
          ? `Сборка не принимает формат «${agent.launch.streamFormat}» — запуск пойдёт с одноразовым выводом «${agent.launch.oneShotFormat}»: ход работы будет виден только по завершении, а не в реальном времени.`
          : null,
    ),
    promptViaStdin: viaShell,
    error:
      streaming || oneShot
        ? null
        : `Сборка не поддерживает ни «${agent.launch.streamFormat}», ни «${agent.launch.oneShotFormat}» — разобрать её вывод нельзя.`,
  };
}

function joinNotices(...notices: (string | null)[]): string | null {
  const present = notices.filter((notice): notice is string => notice !== null);
  return present.length === 0 ? null : present.join(' ');
}
