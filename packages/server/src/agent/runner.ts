import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import {
  type AgentEvent,
  NdjsonSplitter,
  type ParsedMessage,
  type RunTally,
  classifyOutcome,
  emptyTally,
  parseAgentJsonOutput,
  parseAgentLine,
  tallyMessage,
} from '@openspec-ide/core';
import { type IdeConfig, loadConfig } from '../config.js';
import type { EventBus } from '../events.js';
import type { MetricsService } from '../metrics.js';
import { killTree, spawnTree, toPosixPath } from '../process/platform.js';
import { type AgentConfig, buildArgs, displayCommand, parseDuration } from './launch.js';
import { type ProbeResult, probeAgent } from './probe.js';
import type { BuiltPrompt, RunTarget } from './prompt.js';
import { type AgentRunRecord, AgentRunStore, Redactor, type StoredAgentEvent } from './store.js';

/** Режимы подтверждения действий агента. */
export const APPROVAL_MODES = ['plan', 'default', 'auto-edit', 'auto', 'yolo'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Запуск невозможен — причина для пользователя. */
export class AgentBlockedError extends Error {
  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'AgentBlockedError';
  }
}

/** По change уже идёт запуск. */
export class AgentBusyError extends Error {
  constructor(readonly runningRunId: string, change: string) {
    super(`По «${change}» уже выполняется запуск агента — параллельный запуск заблокирован.`);
    this.name = 'AgentBusyError';
  }
}

/** Режим полного автоподтверждения требует явного согласия. */
export class AgentConsentError extends Error {
  constructor() {
    super(
      'Режим yolo подтверждает все действия агента без остановки: файлы меняются и команды выполняются без вашего контроля. ' +
        'Подтвердите согласие явно, чтобы запустить в этом режиме.',
    );
    this.name = 'AgentConsentError';
  }
}

/** Запрос запуска. */
export interface RunRequest {
  readonly built: BuiltPrompt;
  /** Текст, который ушёл в CLI: собранный промпт после правки пользователем. */
  readonly prompt: string;
  readonly approvalMode?: ApprovalMode;
  readonly confirmYolo?: boolean;
}

/** Состояние настройки подключения. */
export interface AgentStatus {
  readonly config: AgentConfig;
  readonly configError: string | null;
  readonly credentials: { readonly env: string | null; readonly set: boolean };
  readonly probe: ProbeResult | null;
  /** Что мешает запуску; пусто — запуск доступен. */
  readonly blockers: readonly string[];
}

interface ActiveRun {
  record: AgentRunRecord;
  child: ChildProcess;
  tally: RunTally;
  stoppedByUser: boolean;
  watchdogFired: boolean;
  killTimer: NodeJS.Timeout | null;
}

export interface AgentServiceOptions {
  readonly root: string;
  readonly events: EventBus;
  readonly metrics: MetricsService | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  /** Пауза между мягким и принудительным завершением процесса, мс. */
  readonly killGraceMs?: number;
  /** Запас сторожевого таймера сверх предела времени CLI, мс. */
  readonly watchdogGraceMs?: number;
}

const STDERR_TAIL = 8000;

/**
 * Запуск агента через GigaCode CLI как управляемая операция: с проверкой
 * настроек, бюджетами, потоковым выводом и записью в журнал и метрики.
 */
export class AgentService {
  readonly #options: AgentServiceOptions;
  readonly #store: AgentRunStore;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => string;
  readonly #active = new Map<string, ActiveRun>();
  #probe: ProbeResult | null = null;
  #probedCommand: string | null = null;

  constructor(options: AgentServiceOptions) {
    this.#options = options;
    this.#store = new AgentRunStore(options.root);
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async #config(): Promise<{ config: IdeConfig; error: string | null }> {
    const load = await loadConfig(this.#options.root);
    return { config: load.config, error: load.parseError };
  }

  async status(): Promise<AgentStatus> {
    const { config, error } = await this.#config();
    const agent = config.agent;
    const envSet = agent.credentialsEnv === null || (this.#env[agent.credentialsEnv] ?? '') !== '';
    const probe = this.#probedCommand === agent.command ? this.#probe : null;

    const blockers: string[] = [];
    if (error !== null) blockers.push(`Файл настроек не разбирается: ${error}`);
    if (!envSet && agent.credentialsEnv !== null) {
      blockers.push(
        `Переменная окружения ${agent.credentialsEnv} не задана в среде сервера IDE. Задайте её и перезапустите IDE: значение ключа в настройках не хранится.`,
      );
    }
    if (probe === null) blockers.push('Подключение ещё не проверялось — нажмите «Проверить подключение».');
    else if (!probe.ok) blockers.push(probe.error ?? 'Проверка подключения не прошла.');

    return {
      config: agent,
      configError: error,
      credentials: { env: agent.credentialsEnv, set: envSet },
      probe,
      blockers,
    };
  }

  async probe(): Promise<ProbeResult> {
    const { config } = await this.#config();
    this.#probe = await probeAgent(config.agent, this.#options.root, this.#now, this.#env);
    this.#probedCommand = config.agent.command;
    return this.#probe;
  }

  /** Действующие значения запуска — показываются в окне подтверждения. */
  async effective(): Promise<{
    approvalMode: string;
    maxWallTime: string;
    maxToolCalls: number;
    model: string | null;
    command: string;
    format: string | null;
    streaming: boolean;
    notice: string | null;
  }> {
    const { config } = await this.#config();
    const agent = config.agent;
    const probe = this.#probedCommand === agent.command ? this.#probe : null;
    const format = probe?.format ?? agent.launch.streamFormat;
    const args = buildArgs(agent.launch.args, {
      prompt: '<промпт>',
      format,
      approvalMode: agent.approvalMode,
      maxWallTime: agent.maxWallTime,
      maxToolCalls: agent.maxToolCalls,
      model: agent.model,
      extraArgs: agent.extraArgs,
    });
    return {
      approvalMode: agent.approvalMode,
      maxWallTime: agent.maxWallTime,
      maxToolCalls: agent.maxToolCalls,
      model: agent.model,
      command: displayCommand(agent.command, args, '<промпт>'),
      format: probe?.format ?? null,
      streaming: probe?.streaming ?? true,
      notice: probe?.notice ?? null,
    };
  }

  /** Все выполняющиеся запуски. */
  activeRuns(): AgentRunRecord[] {
    return [...this.#active.values()].map((run) => run.record);
  }

  running(change: string): AgentRunRecord | null {
    return this.#active.get(change)?.record ?? null;
  }

  async start(request: RunRequest): Promise<AgentRunRecord> {
    const change = request.built.change;
    const busy = this.#active.get(change);
    if (busy !== undefined) throw new AgentBusyError(busy.record.runId, change);

    const { config } = await this.#config();
    const agent = config.agent;
    const mode = request.approvalMode ?? agent.approvalMode;
    if (!APPROVAL_MODES.includes(mode)) throw new AgentBlockedError(`Неизвестный режим подтверждения «${mode}»`);
    if (mode === 'yolo' && request.confirmYolo !== true) throw new AgentConsentError();
    if (request.prompt.trim() === '') throw new AgentBlockedError('Промпт пуст — запускать нечего.');

    // Проба перед первым запуском: без неё неизвестно, есть ли CLI и какой
    // формат вывода он принимает.
    if (this.#probe === null || this.#probedCommand !== agent.command) await this.probe();
    const status = await this.status();
    if (status.blockers.length > 0) {
      throw new AgentBlockedError('Запуск агента заблокирован', status.blockers);
    }
    const probe = this.#probe as ProbeResult;
    const format = probe.format ?? agent.launch.streamFormat;
    const wallMs = parseDuration(agent.maxWallTime);

    const redactor = new Redactor(
      [...(agent.credentialsEnv === null ? [] : [agent.credentialsEnv]), ...agent.secretEnvs],
      this.#env,
    );
    const args = buildArgs(agent.launch.args, {
      prompt: request.prompt,
      format,
      approvalMode: mode,
      maxWallTime: agent.maxWallTime,
      maxToolCalls: agent.maxToolCalls,
      model: agent.model,
      extraArgs: agent.extraArgs,
    });

    const runId = `${this.#now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const record: AgentRunRecord = {
      runId,
      change,
      target: request.built.target,
      label: request.built.label,
      prompt: redactor.text(request.prompt),
      approvalMode: mode,
      model: agent.model,
      format,
      streaming: probe.streaming,
      command: redactor.text(displayCommand(agent.command, args, request.prompt)),
      limits: { maxWallTime: agent.maxWallTime, maxToolCalls: agent.maxToolCalls },
      startedAt: this.#now(),
      state: 'running',
      finishedAt: null,
      durationMs: null,
      outcome: null,
      exitCode: null,
      signal: null,
      tokensIn: null,
      tokensOut: null,
      toolCalls: 0,
      files: [],
      finalText: null,
      error: null,
      stderr: '',
      sessionId: null,
      unknownEvents: 0,
    };

    // Своя группа процессов (на POSIX): остановка снимает и дочерние процессы агента.
    const child = spawnTree(probe.bin as string, args, { cwd: this.#options.root, env: this.#env });
    const run: ActiveRun = { record, child, tally: emptyTally(), stoppedByUser: false, watchdogFired: false, killTimer: null };
    this.#active.set(change, run);
    this.#options.events.emit({ type: 'agent-started', payload: record });

    const started = Date.now();
    let writes = Promise.resolve();
    const persist = (events: readonly StoredAgentEvent[]): void => {
      const safe = redactor.value(events);
      writes = writes.then(() => this.#store.appendEvents(runId, safe)).catch(() => undefined);
    };

    const consume = (parsed: ParsedMessage): void => {
      run.tally = tallyMessage(run.tally, parsed);
      const at = this.#now();
      const visible = parsed.events.filter((event: AgentEvent) => event.kind !== 'partial');
      if (visible.length === 0) return;
      persist(visible.map((event) => ({ at, event })));
      for (const event of visible) {
        this.#options.events.emit({
          type: 'agent-event',
          payload: redactor.value({
            runId,
            change,
            at,
            event,
            tally: { toolCalls: run.tally.toolCalls, tokensIn: run.tally.tokensIn, tokensOut: run.tally.tokensOut },
          }),
        });
      }
    };

    const splitter = new NdjsonSplitter();
    let oneShot = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (!probe.streaming) {
        oneShot += chunk;
        return;
      }
      for (const line of splitter.push(chunk)) consume(parseAgentLine(line));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });

    // Сторожевой таймер: CLI сам следит за пределом времени, но если он его
    // не соблюдает, запуск всё равно должен закончиться.
    const watchdog =
      wallMs === null
        ? null
        : setTimeout(() => {
            run.watchdogFired = true;
            this.#terminate(run);
          }, wallMs + (this.#options.watchdogGraceMs ?? 15_000));

    const finished = new Promise<AgentRunRecord>((done) => {
      const finish = async (code: number | null, signal: NodeJS.Signals | null, spawnError: string | null) => {
        if (watchdog !== null) clearTimeout(watchdog);
        if (run.killTimer !== null) clearTimeout(run.killTimer);
        if (probe.streaming) {
          const rest = splitter.end();
          if (rest !== null) consume(parseAgentLine(rest));
        } else {
          for (const parsed of parseAgentJsonOutput(oneShot)) consume(parsed);
        }

        const tally = run.tally;
        const outcome =
          spawnError !== null
            ? 'failure'
            : classifyOutcome({
                exitCode: code,
                stoppedByUser: run.stoppedByUser,
                watchdogFired: run.watchdogFired,
                stderr,
                tally,
                maxToolCalls: agent.maxToolCalls,
                budgetExitCode: agent.launch.budgetExitCode,
              });
        const finishedAt = this.#now();
        const final: AgentRunRecord = redactor.value({
          ...record,
          state: 'finished',
          finishedAt,
          durationMs: Date.now() - started,
          outcome,
          exitCode: code,
          signal,
          tokensIn: tally.tokensIn,
          tokensOut: tally.tokensOut,
          toolCalls: tally.toolCalls,
          files: tally.files.map((file) => this.#relative(file)),
          finalText: tally.finalText,
          error: spawnError ?? tally.result?.error ?? (outcome === 'failure' && stderr.trim() !== '' ? stderr.trim().split('\n').at(-1) ?? null : null),
          stderr,
          sessionId: tally.sessionId,
          unknownEvents: tally.unknownEvents,
        });

        await writes;
        await this.#store.finish(final).catch(() => undefined);
        await this.#options.metrics
          ?.recordRun({
            type: 'run-finished',
            at: finishedAt,
            change,
            item: record.target.kind === 'item' ? record.target.key : null,
            runId,
            outcome,
            startedAt: record.startedAt,
            durationMs: final.durationMs ?? 0,
            tokensIn: final.tokensIn,
            tokensOut: final.tokensOut,
            toolCalls: final.toolCalls,
            files: final.files,
          })
          .catch(() => undefined);
        this.#active.delete(change);
        this.#options.events.emit({ type: 'agent-finished', payload: final });
        done(final);
      };

      let spawnError: string | null = null;
      child.on('error', (error) => {
        spawnError = `Не удалось запустить «${probe.bin}»: ${error.message}`;
      });
      child.on('close', (code, signal) => void finish(code, signal, spawnError));
    });
    this.#finished.set(runId, finished);
    return record;
  }

  readonly #finished = new Map<string, Promise<AgentRunRecord>>();

  /** Ждёт завершения запуска — для тестов и сквозных сценариев. */
  async waitFor(runId: string): Promise<AgentRunRecord | null> {
    return (await this.#finished.get(runId)) ?? null;
  }

  /** Останавливает запуск: мягкий сигнал, затем принудительный. */
  stop(runId: string): boolean {
    const run = [...this.#active.values()].find((item) => item.record.runId === runId);
    if (run === undefined) return false;
    run.stoppedByUser = true;
    this.#terminate(run);
    return true;
  }

  #terminate(run: ActiveRun): void {
    killTree(run.child, false);
    if (run.killTimer !== null) return;
    run.killTimer = setTimeout(() => killTree(run.child, true), this.#options.killGraceMs ?? 5000);
  }

  #relative(file: string): string {
    return toPosixPath(isAbsolute(file) ? relative(this.#options.root, file) : file);
  }

  /** История запусков change от новых к старым, включая выполняющийся. */
  async history(change: string): Promise<AgentRunRecord[]> {
    const finished = (await this.#store.history()).filter((record) => record.change === change);
    const running = this.#active.get(change)?.record;
    const all = running === undefined ? finished : [...finished, running];
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async run(runId: string): Promise<{ record: AgentRunRecord; events: StoredAgentEvent[] } | null> {
    const active = [...this.#active.values()].find((item) => item.record.runId === runId);
    const record = active?.record ?? (await this.#store.history()).find((item) => item.runId === runId);
    if (record === undefined) return null;
    return { record, events: await this.#store.events(runId) };
  }

  /** Снимает все выполняющиеся запуски — при остановке сервера. */
  shutdown(): void {
    for (const run of this.#active.values()) {
      run.stoppedByUser = true;
      killTree(run.child, true);
    }
  }
}

export type { RunTarget };
