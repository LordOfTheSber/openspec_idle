import type { AgentEvent } from '@openspec-ide/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeAgentEvents } from '../lib/agentFeed.js';
import {
  ApiError,
  type AgentRunRecord,
  type AgentStreamEvent,
  type AgentTargets,
  type ApprovalMode,
  type EffectiveLaunch,
  type RunTarget,
  buildAgentPrompt,
  fetchAgentRun,
  fetchAgentRuns,
  fetchAgentStatus,
  fetchAgentTargets,
  startAgentRun,
  stopAgentRun,
} from '../lib/api.js';
import { formatDuration, formatTokens } from '../lib/format.js';
import { MODES } from './Settings.js';

interface AgentProps {
  readonly change: string;
  /** Пункт плана, выбранный в метриках, — запуск по нему предлагается сразу. */
  readonly initialItem?: string | null;
}

interface Draft {
  readonly target: RunTarget;
  readonly label: string;
  readonly text: string;
  readonly mode: ApprovalMode;
  readonly consent: boolean;
  readonly effective: EffectiveLaunch;
}

interface Failure {
  readonly message: string;
  readonly details: readonly string[];
  readonly output: string;
  readonly runningRunId: string | null;
}

interface LogLine {
  readonly at: string;
  readonly event: AgentEvent;
}

const OUTCOME: Record<string, { mark: string; text: string; tone: string }> = {
  success: { mark: '✓', text: 'успешно', tone: 'ok' },
  failure: { mark: '✕', text: 'ошибка', tone: 'err' },
  aborted: { mark: '■', text: 'прерван', tone: 'warn' },
  'budget-time': { mark: '⏱', text: 'превышен бюджет времени', tone: 'err' },
  'budget-tools': { mark: '⚒', text: 'превышен бюджет вызовов', tone: 'err' },
};

function failure(error: unknown): Failure {
  if (error instanceof ApiError) {
    const running = error.payload['runningRunId'];
    return {
      message: error.message,
      details: error.details,
      output: error.output,
      runningRunId: typeof running === 'string' ? running : null,
    };
  }
  return { message: error instanceof Error ? error.message : String(error), details: [], output: '', runningRunId: null };
}

function clock(iso: string, since: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - Date.parse(since)) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function describe(event: AgentEvent): { mark: string; text: string; tone?: string } | null {
  switch (event.kind) {
    case 'init':
      return { mark: '▸', text: `Сессия ${event.sessionId ?? '—'} · модель ${event.model ?? '—'} · режим ${event.mode ?? '—'}` };
    case 'text':
      return { mark: '✎', text: event.text };
    case 'thinking':
      return { mark: '…', text: event.text, tone: 'muted' };
    case 'tool-call': {
      const target = ['file_path', 'absolute_path', 'path', 'command', 'pattern']
        .map((key) => event.input[key])
        .find((value) => typeof value === 'string');
      return { mark: '⚙', text: `${event.name}${typeof target === 'string' ? ` ${target}` : ''}` };
    }
    case 'tool-result':
      return event.isError ? { mark: '!', text: `Инструмент вернул ошибку: ${event.content}`, tone: 'err' } : null;
    case 'result':
      // Итоговый текст модели уже показан строкой выше — здесь только итог.
      return event.ok
        ? {
            mark: '✓',
            text: `Завершено${event.turns === null ? '' : ` · ходов ${event.turns}`}${
              event.usage.input === null ? '' : ` · токенов ${(event.usage.input ?? 0) + (event.usage.output ?? 0)}`
            }`,
            tone: 'ok',
          }
        : { mark: '✕', text: event.error ?? 'Завершено с ошибкой', tone: 'err' };
    case 'unknown':
      return {
        mark: '⚠',
        text: `Событие ${
          typeof event.raw === 'object' && event.raw !== null && 'type' in event.raw ? `типа ${String((event.raw as { type: unknown }).type)} ` : ''
        }не распознано — сохранено в журнал как есть, обработка продолжена`,
        tone: 'warn',
      };
    case 'malformed':
      return { mark: '⚠', text: 'Строка потока оборвана или не разобрана — сохранена как есть', tone: 'warn' };
    default:
      return null;
  }
}

export function Agent({ change, initialItem = null }: AgentProps) {
  const [targets, setTargets] = useState<AgentTargets | null>(null);
  const [history, setHistory] = useState<AgentRunRecord[]>([]);
  const [blockers, setBlockers] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [active, setActive] = useState<AgentRunRecord | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [tally, setTally] = useState<AgentStreamEvent['tally'] | null>(null);
  const [viewing, setViewing] = useState<{ record: AgentRunRecord; events: LogLine[] } | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const activeRef = useRef<AgentRunRecord | null>(null);
  activeRef.current = active;
  // Быстрый запуск успевает прислать события и даже завершиться раньше, чем
  // вернётся ответ на запрос запуска: они придерживаются до его прихода.
  const pendingRef = useRef(new Map<string, LogLine[]>());
  const finishedRef = useRef(new Map<string, AgentRunRecord>());

  const reload = useCallback(async () => {
    const [nextTargets, runs, status] = await Promise.all([
      fetchAgentTargets(change),
      fetchAgentRuns(change),
      fetchAgentStatus(),
    ]);
    setTargets(nextTargets);
    setHistory(runs.runs);
    setBlockers(status.blockers.filter((blocker) => !blocker.startsWith('Подключение ещё не проверялось')));
    if (nextTargets.running !== null && activeRef.current === null) {
      setActive(nextTargets.running);
      const stored = await fetchAgentRun(nextTargets.running.runId);
      setLog(stored.events);
    }
  }, [change]);

  useEffect(() => {
    setDraft(null);
    setActive(null);
    setLog([]);
    setViewing(null);
    setError(null);
    void reload().catch((caught: unknown) => setError(failure(caught)));
  }, [reload]);

  const choose = useCallback(
    async (target: RunTarget) => {
      setError(null);
      setViewing(null);
      try {
        const built = await buildAgentPrompt(change, target);
        setDraft({
          target,
          label: built.label,
          text: built.prompt,
          mode: built.effective.approvalMode as ApprovalMode,
          consent: false,
          effective: built.effective,
        });
      } catch (caught) {
        setDraft(null);
        setError(failure(caught));
      }
    },
    [change],
  );

  useEffect(() => {
    if (initialItem !== null) void choose({ kind: 'item', key: initialItem });
  }, [initialItem, choose]);

  useEffect(
    () =>
      subscribeAgentEvents((incoming) => {
        if (incoming.type === 'agent-event') {
          const payload = incoming.payload as AgentStreamEvent;
          if (payload.change !== change) return;
          if (payload.runId !== activeRef.current?.runId) {
            if (activeRef.current === null) {
              const pending = pendingRef.current.get(payload.runId) ?? [];
              pendingRef.current.set(payload.runId, [...pending, { at: payload.at, event: payload.event }]);
            }
            return;
          }
          setLog((current) => [...current, { at: payload.at, event: payload.event }]);
          setTally(payload.tally);
        } else if (incoming.type === 'agent-finished') {
          const record = incoming.payload as AgentRunRecord;
          if (record.change !== change) return;
          if (activeRef.current === null) finishedRef.current.set(record.runId, record);
          if (record.runId === activeRef.current?.runId) {
            setActive(null);
            setViewing((current) => current ?? { record, events: [] });
            void fetchAgentRun(record.runId).then((stored) => setViewing({ record: stored.record, events: stored.events }));
          }
          void reload();
        } else if (incoming.type === 'agent-started') {
          const record = incoming.payload as AgentRunRecord;
          if (record.change === change) void reload();
        }
      }),
    [change, reload],
  );

  useEffect(() => {
    if (active === null) return;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const run = async () => {
    if (draft === null) return;
    setError(null);
    try {
      const record = await startAgentRun({
        change,
        target: draft.target,
        prompt: draft.text,
        approvalMode: draft.mode,
        confirmYolo: draft.consent,
      });
      setDraft(null);
      const finished = finishedRef.current.get(record.runId);
      if (finished !== undefined) {
        const stored = await fetchAgentRun(record.runId);
        setViewing({ record: stored.record, events: stored.events });
        return;
      }
      setViewing(null);
      // Запуск уже подхвачен по событию agent-started — его журнал не сбрасывается.
      if (activeRef.current?.runId === record.runId) return;
      setLog(pendingRef.current.get(record.runId) ?? []);
      pendingRef.current.delete(record.runId);
      setTally(null);
      setActive(record);
    } catch (caught) {
      setError(failure(caught));
    }
  };

  const open = async (runId: string) => {
    setDraft(null);
    try {
      const stored = await fetchAgentRun(runId);
      setViewing({ record: stored.record, events: stored.events });
    } catch (caught) {
      setError(failure(caught));
    }
  };

  const yolo = draft?.mode === 'yolo';
  const wall = active?.limits.maxWallTime ?? '';

  return (
    <div className="agent" data-testid="agent">
      <div className="agent-side">
        <p className="pane-title">
          Запуск по артефакту <span className="count">{targets?.schema ?? ''}</span>
        </p>
        <ul className="target-list" data-testid="agent-artifacts">
          {targets?.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <button
                type="button"
                className="node"
                disabled={!artifact.available}
                title={artifact.reason ?? undefined}
                data-testid={`target-artifact-${artifact.id}`}
                onClick={() => void choose({ kind: 'artifact', artifact: artifact.id })}
              >
                <span className="nm mono">{artifact.id}</span>
                {!artifact.available && <span className="tail">нет инструкции</span>}
              </button>
            </li>
          ))}
        </ul>

        <p className="pane-title" style={{ marginTop: 14 }}>
          Запуск по пункту плана
        </p>
        {targets !== null && targets.items.length === 0 && <p className="empty">В плане нет пунктов.</p>}
        <ul className="target-list" data-testid="agent-items">
          {targets?.items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className="node"
                data-testid={`target-item-${item.key}`}
                onClick={() => void choose({ kind: 'item', key: item.key })}
              >
                <span className={`dot ${item.done ? 'done' : 'missing'}`} />
                <span className="nm">
                  <span className="mono">{item.key}</span> {item.text}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="pane-title" style={{ marginTop: 14 }}>
          История <span className="count">{history.length}</span>
        </p>
        <ul className="run-history" data-testid="agent-history">
          {history.map((record) => {
            const outcome = record.outcome === null ? null : OUTCOME[record.outcome];
            return (
              <li key={record.runId}>
                <button
                  type="button"
                  className={`node ${viewing?.record.runId === record.runId ? 'sel' : ''}`}
                  data-testid={`history-${record.runId}`}
                  data-outcome={record.outcome ?? 'running'}
                  onClick={() => void open(record.runId)}
                >
                  <span className={`run-mark ${outcome?.tone ?? 'warn'}`}>{outcome?.mark ?? '▶'}</span>
                  <span className="nm">
                    {outcome?.text ?? 'выполняется'} · {record.label}
                  </span>
                  <span className="tail">
                    {formatTokens(record.tokensIn === null && record.tokensOut === null ? null : (record.tokensIn ?? 0) + (record.tokensOut ?? 0))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="agent-main">
        {blockers.length > 0 && (
          <div className="notice info" data-testid="agent-blocked">
            <span>Запуск агента заблокирован:</span>
            <ul className="failure-details">
              {blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
            <span>Откройте «Настройки», чтобы завершить подключение.</span>
          </div>
        )}

        {error !== null && (
          <div className="notice error" role="alert" data-testid="agent-error">
            <span>{error.message}</span>
            {error.details.length > 0 && (
              <ul className="failure-details">
                {error.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
            {error.output !== '' && <pre className="diff-preview">{error.output}</pre>}
            {error.runningRunId !== null && (
              <button type="button" className="btn" data-testid="open-running" onClick={() => void open(error.runningRunId!)}>
                Открыть выполняющийся запуск
              </button>
            )}
          </div>
        )}

        {draft !== null && active === null && (
          <section className="run-confirm" data-testid="run-confirm">
            <p className="pane-title">
              Запуск · {draft.label} <span className="count">промпт собран из openspec instructions</span>
            </p>
            <textarea
              className="prompt-editor"
              aria-label="Промпт запуска"
              rows={14}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
            <div className="run-params">
              <label>
                Режим
                <select
                  aria-label="Режим подтверждения"
                  value={draft.mode}
                  onChange={(event) => setDraft({ ...draft, mode: event.target.value as ApprovalMode, consent: false })}
                >
                  {MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.title}
                    </option>
                  ))}
                </select>
              </label>
              <span>
                Время <b>{draft.effective.maxWallTime}</b>
              </span>
              <span>
                Вызовы инструментов <b>{draft.effective.maxToolCalls}</b>
              </span>
              <span>
                Модель <b>{draft.effective.model ?? 'по умолчанию CLI'}</b>
              </span>
            </div>
            <p className="hint" data-testid="run-mode-hint">
              {MODES.find((mode) => mode.id === draft.mode)?.hint}
            </p>
            {!draft.effective.streaming && draft.effective.notice !== null && (
              <p className="notice info" data-testid="oneshot-notice">
                {draft.effective.notice}
              </p>
            )}
            {yolo && (
              <label className="notice error yolo-consent" data-testid="yolo-warning">
                <input
                  type="checkbox"
                  checked={draft.consent}
                  onChange={(event) => setDraft({ ...draft, consent: event.target.checked })}
                />
                <span>
                  Режим yolo: агент будет менять файлы и выполнять команды без подтверждения. Я понимаю риск неконтролируемых
                  изменений и соглашаюсь.
                </span>
              </label>
            )}
            <pre className="diff-preview">{draft.effective.command.replace(/--approval-mode \S+/, `--approval-mode ${draft.mode}`)}</pre>
            <div className="conflict-actions">
              <button
                type="button"
                className="btn primary"
                data-testid="run-start"
                disabled={(yolo && !draft.consent) || blockers.length > 0 || draft.text.trim() === ''}
                onClick={() => void run()}
              >
                Запустить
              </button>
              <button type="button" className="btn" onClick={() => setDraft(null)}>
                Отмена
              </button>
            </div>
          </section>
        )}

        {active !== null && (
          <section className="run-live" data-testid="run-live" data-run={active.runId}>
            <div className="run-head">
              <p className="pane-title">
                {active.label} · выполняется {clock(now, active.startedAt)}
              </p>
              <button type="button" className="btn" data-testid="run-stop" onClick={() => void stopAgentRun(active.runId)}>
                Остановить
              </button>
            </div>
            <div className="run-budget" data-testid="run-budget">
              <span>
                Время <b>{clock(now, active.startedAt)}</b> / {wall}
              </span>
              <span>
                Вызовы инструментов <b>{tally?.toolCalls ?? 0}</b> / {active.limits.maxToolCalls}
              </span>
              <span>
                Токены <b>{formatTokens(tally === null || (tally.tokensIn === null && tally.tokensOut === null) ? null : (tally.tokensIn ?? 0) + (tally.tokensOut ?? 0))}</b>
              </span>
              <span>
                Режим <b>{active.approvalMode}</b>
              </span>
            </div>
            {!active.streaming && <p className="notice info">Вывод будет показан по завершении, а не в реальном времени.</p>}
            <RunLog lines={log} since={active.startedAt} />
          </section>
        )}

        {viewing !== null && active === null && draft === null && <RunView record={viewing.record} lines={viewing.events} />}

        {draft === null && active === null && viewing === null && error === null && (
          <p className="empty">Выберите артефакт или пункт плана слева — промпт соберётся из инструкций схемы.</p>
        )}
      </div>
    </div>
  );
}

function RunLog({ lines, since }: { lines: readonly LogLine[]; since: string }) {
  return (
    <ol className="run-log" data-testid="run-log">
      {lines.map((line, index) => {
        const shown = describe(line.event);
        if (shown === null) return null;
        return (
          <li key={index} className={shown.tone ?? ''} data-kind={line.event.kind}>
            <span className="t">{clock(line.at, since)}</span>
            <span className="m">{shown.mark}</span>
            <span className="x">{shown.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RunView({ record, lines }: { record: AgentRunRecord; lines: readonly LogLine[] }) {
  const outcome = record.outcome === null ? null : OUTCOME[record.outcome];
  return (
    <section className="run-view" data-testid="run-view" data-outcome={record.outcome ?? ''}>
      <p className="pane-title">
        {record.label} · <span className={outcome?.tone}>{outcome?.text ?? 'выполняется'}</span>
      </p>
      <dl className="run-facts">
        <dt>Начат</dt>
        <dd>{new Date(record.startedAt).toLocaleString('ru-RU')}</dd>
        <dt>Длительность</dt>
        <dd>{record.durationMs === null ? '—' : formatDuration(record.durationMs)}</dd>
        <dt>Код возврата</dt>
        <dd data-testid="run-exit">{record.exitCode ?? record.signal ?? '—'}</dd>
        <dt>Токены</dt>
        <dd data-testid="run-tokens">
          {record.tokensIn === null && record.tokensOut === null
            ? 'нет данных'
            : `${formatTokens(record.tokensIn)} вход · ${formatTokens(record.tokensOut)} выход`}
        </dd>
        <dt>Вызовы инструментов</dt>
        <dd>
          {record.toolCalls} / {record.limits.maxToolCalls}
        </dd>
        <dt>Режим</dt>
        <dd>{record.approvalMode}</dd>
        <dt>Затронутые файлы</dt>
        <dd data-testid="run-files">{record.files.length === 0 ? 'нет' : record.files.join(', ')}</dd>
      </dl>
      {record.finalText !== null && (
        <div className="notice ok" data-testid="run-final">
          {record.finalText}
        </div>
      )}
      {record.error !== null && (
        <div className="notice error" data-testid="run-error">
          {record.error}
        </div>
      )}
      <details>
        <summary>Промпт запуска</summary>
        <pre className="diff-preview" data-testid="run-prompt">
          {record.prompt}
        </pre>
      </details>
      <details>
        <summary>Команда</summary>
        <pre className="diff-preview">{record.command}</pre>
      </details>
      {record.stderr.trim() !== '' && (
        <details>
          <summary>Вывод ошибок процесса</summary>
          <pre className="diff-preview">{record.stderr}</pre>
        </details>
      )}
      <p className="pane-title" style={{ marginTop: 12 }}>
        Ход работы
      </p>
      <RunLog lines={lines} since={record.startedAt} />
    </section>
  );
}
