import { useCallback, useEffect, useState } from 'react';
import type { ItemMetrics } from '@openspec-ide/core';
import {
  bindAcceptance,
  fetchMetrics,
  fetchMetricsExport,
  runAcceptance,
  startItem,
  type MetricsResponse,
} from '../lib/api.js';
import { formatDuration, formatShare, formatTokens, plural } from '../lib/format.js';
import { inVsCode, openInEditor } from '../lib/host.js';

const STATE_LABEL: Record<ItemMetrics['state'], string> = {
  'not-started': 'не начата',
  'in-progress': 'в работе',
  done: 'готово',
  removed: 'удалена',
};

const STATE_DOT: Record<ItemMetrics['state'], string> = {
  'not-started': 'missing',
  'in-progress': 'draft',
  done: 'done',
  removed: 'missing',
};

function acceptanceLabel(item: ItemMetrics): { text: string; dot: string } {
  if (item.acceptance.criterion === null) return { text: 'нет критерия', dot: 'missing' };
  if (item.acceptance.passed === true) return { text: 'пройдена', dot: 'done' };
  if (item.acceptance.passed === false) return { text: 'не пройдена', dot: 'invalid' };
  return { text: 'не запускалась', dot: 'missing' };
}

/** Сохраняет выгрузку файлом — в локальном приложении загрузка работает. */
function download(name: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function Metrics({
  change,
  onAgent,
}: {
  readonly change: string;
  /** Открывает панель агента на пункте: запуск и история его запусков. */
  readonly onAgent?: (key: string) => void;
}) {
  const [view, setView] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [checkOutput, setCheckOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setView(await fetchMetrics(change));
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, [change]);

  useEffect(() => {
    setView(null);
    setSelected(null);
    void reload();
  }, [reload]);

  async function act(action: () => Promise<MetricsResponse>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setView(await action());
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && view === null) {
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  }
  if (view === null) return <p className="empty">Загрузка метрик…</p>;

  if (!view.tracked) {
    return (
      <p className="notice info" data-testid="metrics-untracked">
        {view.reason}
      </p>
    );
  }

  const { summary, items, removed } = view;
  const maxTokens = Math.max(1, ...items.map((item) => item.tokens ?? 0));
  const current = items.find((item) => item.key === selected) ?? null;

  return (
    <div className="metrics" data-testid="metrics">
      {view.recovered && (
        <p className="notice info">
          Снимок метрик был пересобран из журнала событий — данные восстановлены.
        </p>
      )}

      <div className="tiles" data-testid="metrics-summary">
        <div className="tile">
          <div className="k">Выполнено</div>
          <div className="v">{formatShare(summary.doneShare)}</div>
          <div className="sub">
            {summary.complete} из {plural(summary.total, ['пункта', 'пунктов', 'пунктов'])}
          </div>
        </div>
        <div className="tile">
          <div className="k">Токенов всего</div>
          <div className="v" data-testid="tokens-total">
            {formatTokens(summary.tokensTotal)}
          </div>
          <div className="sub">
            по {plural(summary.itemsWithTokenData, ['пункту', 'пунктам', 'пунктам'])} с данными
          </div>
        </div>
        <div className="tile">
          <div className="k">В среднем на пункт</div>
          <div className="v">{formatTokens(summary.tokensAverage)}</div>
          <div className="sub">медиана {formatTokens(summary.tokensMedian)}</div>
        </div>
        <div className="tile">
          <div className="k">Время агента</div>
          <div className="v">{formatDuration(summary.agentTimeMs)}</div>
          <div className="sub">
            {plural(summary.runs, ['запуск', 'запуска', 'запусков'])},{' '}
            {plural(summary.failedRuns, ['неуспешный', 'неуспешных', 'неуспешных'])}
          </div>
        </div>
        <div className="tile">
          <div className="k">Без критерия приёмки</div>
          <div className={summary.withoutCriterion > 0 ? 'v flag' : 'v'} data-testid="without-criterion">
            {summary.withoutCriterion}
          </div>
          <div className="sub">план непроверяем там, где его нет</div>
        </div>
        <div className="tile">
          <div className="k">Расхождений приёмки</div>
          <div
            className={summary.acceptanceMismatches > 0 ? 'v flag' : 'v'}
            data-testid="mismatches"
          >
            {summary.acceptanceMismatches}
          </div>
          <div className="sub">отмечены при красной проверке</div>
        </div>
      </div>

      <div className="metrics-toolbar">
        <span className="pane-title">
          Пункты плана <span className="count">сортировка по расходу</span>
        </span>
        <span className="spacer" />
        <span className="crumbs">
          схема {summary.schema ?? '—'} · {view.trackedPath}
        </span>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void fetchMetricsExport(change).then((data) =>
              download(`metrics-${change}.json`, data),
            )
          }
        >
          Экспорт
        </button>
      </div>

      <div className="tbl-wrap">
        <table className="m" data-testid="metrics-table">
          <thead>
            <tr>
              <th>Пункт</th>
              <th>Задача</th>
              <th>Состояние</th>
              <th className="num">Запусков</th>
              <th>Токены</th>
              <th className="num">Время</th>
              <th>Приёмка</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const acceptance = acceptanceLabel(item);
              return (
                <tr
                  key={item.id}
                  className={selected === item.key ? 'selected' : ''}
                  onClick={() => {
                    setSelected(item.key);
                    setCommand(item.acceptance.command ?? '');
                    setCheckOutput(null);
                  }}
                  data-testid={`metrics-row-${item.key}`}
                >
                  <td className="id">{item.key}</td>
                  <td className="task">{item.work}</td>
                  <td>
                    <span className="state">
                      <span
                        className={`dot ${item.acceptanceMismatch ? 'invalid' : STATE_DOT[item.state]}`}
                      />
                      {item.acceptanceMismatch ? 'расхождение' : STATE_LABEL[item.state]}
                    </span>
                  </td>
                  <td className="num">{item.runs.total}</td>
                  <td>
                    <span
                      className="bar"
                      title={
                        item.tokens === null
                          ? 'Запуски были, но расход не сообщён'
                          : `${item.key}: ${formatTokens(item.tokens)}, запусков ${item.runs.total}, успешных ${item.runs.success}`
                      }
                    >
                      <span className="track">
                        {item.tokens !== null && item.tokens > 0 && (
                          <i
                            className="fill"
                            style={{ width: `${Math.max(2, (item.tokens / maxTokens) * 100)}%` }}
                          />
                        )}
                      </span>
                      <span className={item.tokens === null ? 'val nd' : 'val'}>
                        {formatTokens(item.tokens)}
                      </span>
                    </span>
                  </td>
                  <td className="num">{formatDuration(item.timeInWorkMs)}</td>
                  <td>
                    <span className="state">
                      <span className={`dot ${acceptance.dot}`} />
                      {acceptance.text}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {removed.length > 0 && (
        <p className="empty" data-testid="removed-note">
          Удалённых из плана пунктов с сохранёнными метриками: {removed.length}. В сводку они не
          входят.
        </p>
      )}

      {current !== null && (
        <section className="item-detail" data-testid="item-detail">
          <p className="pane-title">
            Пункт {current.key} <span className="count">{STATE_LABEL[current.state]}</span>
          </p>
          <p className="work">{current.work}</p>

          <dl className="scenario-diff">
            <dt>Критерий приёмки</dt>
            <dd data-testid="criterion">{current.acceptance.criterion ?? 'не выделен из формулировки'}</dd>
            <dt>Взят в работу</dt>
            <dd>{current.firstStartedAt ?? '—'}</dd>
            <dt>Завершён</dt>
            <dd>
              {current.completedAt ??
                (current.doneBeforeTracking ? 'до начала учёта — время неизвестно' : '—')}
            </dd>
            <dt>Время цикла</dt>
            <dd>{formatDuration(current.cycleTimeMs)}</dd>
            <dt>Возвратов в работу</dt>
            <dd>{current.reopenCount}</dd>
            <dt>Затронуто файлов</dt>
            <dd>
              {current.files.length === 0
                ? '—'
                : inVsCode()
                  ? current.files.map((file, index) => (
                      <span key={file}>
                        {index > 0 && ', '}
                        <button type="button" className="linklike mono" onClick={() => openInEditor(file)}>
                          {file}
                        </button>
                      </span>
                    ))
                  : current.files.join(', ')}
            </dd>
          </dl>

          <div className="item-actions">
            {current.state === 'not-started' && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void act(() => startItem(change, current.key))}
                data-testid="start-item"
              >
                Взять в работу
              </button>
            )}
            {onAgent !== undefined && (
              <button
                type="button"
                className="btn"
                onClick={() => onAgent(current.key)}
                data-testid="item-agent"
              >
                {current.runs.total > 0 ? `Запуски агента (${current.runs.total})` : 'Запустить агента'}
              </button>
            )}
          </div>

          <form
            className="acceptance-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(() => bindAcceptance(change, current.key, command));
            }}
          >
            <label htmlFor="acceptance-command">Команда проверки приёмки</label>
            <div className="acceptance-row">
              <input
                id="acceptance-command"
                value={command}
                placeholder="например, npm test -- export"
                onChange={(event) => setCommand(event.target.value)}
              />
              <button type="submit" className="btn" disabled={busy || command.trim() === ''}>
                Привязать
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || current.acceptance.command === null}
                data-testid="run-acceptance"
                onClick={() => {
                  setBusy(true);
                  void runAcceptance(change, current.key)
                    .then(({ result, view: next }) => {
                      setView(next);
                      setCheckOutput(
                        `код ${result.exitCode}${result.timedOut ? ' (превышено время)' : ''} · ${formatDuration(result.durationMs)}\n${result.output}`,
                      );
                    })
                    .catch((problem: unknown) =>
                      setError(problem instanceof Error ? problem.message : String(problem)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Проверить
              </button>
            </div>
          </form>

          {checkOutput !== null && (
            <pre className="diff-preview" data-testid="check-output">
              {checkOutput}
            </pre>
          )}
        </section>
      )}

      {error !== null && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
