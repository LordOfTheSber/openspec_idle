import { Fragment, useCallback, useEffect, useState } from 'react';
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
import { PageActions } from '../lib/ui.js';
import { Icon, type IconName } from './Icon.js';

const STATE_LABEL: Record<ItemMetrics['state'], string> = {
  'not-started': 'не начата',
  'in-progress': 'в работе',
  done: 'готово',
  removed: 'удалена',
};

const STATE_CHIP: Record<ItemMetrics['state'], string> = {
  'not-started': 'chip',
  'in-progress': 'chip info',
  done: 'chip ok',
  removed: 'chip',
};

function acceptanceLabel(item: ItemMetrics): { text: string; tone: string; icon: IconName } {
  if (item.acceptance.criterion === null) return { text: 'нет критерия', tone: 'unknown', icon: 'circle' };
  if (item.acceptance.passed === true) return { text: 'пройдена', tone: 'ok', icon: 'checkCircle' };
  if (item.acceptance.passed === false) return { text: 'не пройдена', tone: 'bad', icon: 'error' };
  return { text: 'не запускалась', tone: 'unknown', icon: 'circle' };
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

export function Metrics({ change }: { readonly change: string }) {
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
  if (view === null) {
    return (
      <div className="page-skeleton" aria-busy="true" aria-label="Загрузка метрик">
        <div className="skeleton-grid four">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className="skeleton" style={{ height: 84 }} />
          ))}
        </div>
        <span className="skeleton" style={{ height: 220 }} />
      </div>
    );
  }

  if (!view.tracked) {
    return (
      <p className="notice info" data-testid="metrics-untracked">
        {view.reason}
      </p>
    );
  }

  const { summary, items, removed } = view;
  const maxTokens = Math.max(1, ...items.map((item) => item.tokens ?? 0));
  const hasTokens = summary.tokensTotal !== null;
  const hasRuns = summary.runs > 0;
  const hasTime = items.some((item) => item.timeInWorkMs !== null);
  const checked = items.filter((item) => item.acceptance.passed !== null).length;
  const noData = [
    ...(hasTokens ? [] : ['токены']),
    ...(hasRuns ? [] : ['запуски и время агента']),
    ...(hasTime ? [] : ['время в работе']),
  ];
  const columns = 4 + (hasRuns ? 1 : 0) + (hasTokens ? 1 : 0) + (hasTime ? 1 : 0);

  function select(item: ItemMetrics): void {
    if (selected === item.key) {
      setSelected(null);
      return;
    }
    setSelected(item.key);
    setCommand(item.acceptance.command ?? '');
    setCheckOutput(null);
  }

  return (
    <div className="metrics" data-testid="metrics">
      <PageActions>
        {view.trackedPath !== undefined &&
          (inVsCode() ? (
            <button type="button" className="linkish mono small" onClick={() => openInEditor(view.trackedPath)}>
              {view.trackedPath}
            </button>
          ) : (
            <span className="mono small muted">{view.trackedPath}</span>
          ))}
        <button
          type="button"
          className="btn"
          onClick={() => void fetchMetricsExport(change).then((data) => download(`metrics-${change}.json`, data))}
        >
          <Icon name="download" size={15} />
          Экспорт
        </button>
      </PageActions>

      {view.recovered && (
        <p className="notice info">Снимок метрик был пересобран из журнала событий — данные восстановлены.</p>
      )}

      <div className="tiles" data-testid="metrics-summary">
        <div className="tile">
          <div className="k">Выполнено</div>
          <div className="v">{formatShare(summary.doneShare)}</div>
          <div className="sub">
            {summary.complete} из {plural(summary.total, ['пункта', 'пунктов', 'пунктов'])}
          </div>
          <div className={summary.total > 0 && summary.complete === summary.total ? 'bar-line complete' : 'bar-line'}>
            <i style={{ width: `${Math.round((summary.doneShare ?? 0) * 100)}%` }} />
          </div>
        </div>
        <div className="tile">
          <div className="k">Приёмка проверена</div>
          <div className="v">
            {checked} из {summary.total - summary.withoutCriterion}
          </div>
          <div className="sub">у пунктов с критерием</div>
        </div>
        <div className="tile">
          <div className="k">Без критерия приёмки</div>
          <div className={summary.withoutCriterion > 0 ? 'v flag' : 'v'} data-testid="without-criterion">
            {summary.withoutCriterion}
          </div>
          <div className="sub">{summary.withoutCriterion > 0 ? 'план непроверяем там, где его нет' : 'у каждого пункта есть критерий'}</div>
        </div>
        <div className="tile">
          <div className="k">Расхождения</div>
          <div className={summary.acceptanceMismatches > 0 ? 'v flag' : 'v'} data-testid="mismatches">
            {summary.acceptanceMismatches}
          </div>
          <div className="sub">отмечены готовыми при красной проверке</div>
        </div>
        {hasTokens && (
          <div className="tile">
            <div className="k">Токенов всего</div>
            <div className="v" data-testid="tokens-total">
              {formatTokens(summary.tokensTotal)}
            </div>
            <div className="sub">
              по {plural(summary.itemsWithTokenData, ['пункту', 'пунктам', 'пунктам'])}, медиана {formatTokens(summary.tokensMedian)}
            </div>
          </div>
        )}
        {hasRuns && (
          <div className="tile">
            <div className="k">Время агента</div>
            <div className="v">{formatDuration(summary.agentTimeMs)}</div>
            <div className="sub">
              {plural(summary.runs, ['запуск', 'запуска', 'запусков'])},{' '}
              {plural(summary.failedRuns, ['неуспешный', 'неуспешных', 'неуспешных'])}
            </div>
          </div>
        )}
      </div>

      {noData.length > 0 && (
        <p className="no-data" data-testid="metrics-no-data">
          <Icon name="info" size={15} />
          Нет данных: {noData.join(', ')}. Они появятся, когда пункты начнут брать в работу и запускать. Пустые столбцы
          скрыты.
        </p>
      )}

      <div className="tbl-wrap">
        <table className="m" data-testid="metrics-table">
          <thead>
            <tr>
              <th className="chev" aria-hidden="true" />
              <th>Пункт</th>
              <th>Задача</th>
              <th>Состояние</th>
              {hasRuns && <th className="num">Запусков</th>}
              {hasTokens && <th>Токены</th>}
              {hasTime && <th className="num">Время</th>}
              <th>Приёмка</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const acceptance = acceptanceLabel(item);
              const open = selected === item.key;
              return (
                <Fragment key={item.id}>
                  <tr
                    className={open ? 'selected' : ''}
                    onClick={() => select(item)}
                    aria-expanded={open}
                    data-testid={`metrics-row-${item.key}`}
                  >
                    <td className="chev">
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="muted" />
                    </td>
                    <td className="id mono">{item.key}</td>
                    <td className="task">{item.work}</td>
                    <td>
                      <span className={item.acceptanceMismatch ? 'chip bad' : STATE_CHIP[item.state]}>
                        {item.acceptanceMismatch ? 'расхождение' : STATE_LABEL[item.state]}
                      </span>
                    </td>
                    {hasRuns && <td className="num">{item.runs.total}</td>}
                    {hasTokens && (
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
                              <i className="fill" style={{ width: `${Math.max(2, (item.tokens / maxTokens) * 100)}%` }} />
                            )}
                          </span>
                          <span className={item.tokens === null ? 'val nd' : 'val'}>{formatTokens(item.tokens)}</span>
                        </span>
                      </td>
                    )}
                    {hasTime && <td className="num">{formatDuration(item.timeInWorkMs)}</td>}
                    <td>
                      <span className={`status ${acceptance.tone}`}>
                        <Icon name={acceptance.icon} size={14} />
                        {acceptance.text}
                      </span>
                    </td>
                  </tr>
                  {open && (
                    <tr className="item-detail-row">
                      <td colSpan={columns}>
                        <ItemDetail
                          item={item}
                          change={change}
                          busy={busy}
                          command={command}
                          checkOutput={checkOutput}
                          onCommand={setCommand}
                          onStart={() => void act(() => startItem(change, item.key))}
                          onBind={() => void act(() => bindAcceptance(change, item.key, command))}
                          onRun={() => {
                            setBusy(true);
                            void runAcceptance(change, item.key)
                              .then(({ result, view: next }) => {
                                setView(next);
                                setCheckOutput(
                                  `код ${result.exitCode}${result.timedOut ? ' (превышено время)' : ''} · ${formatDuration(result.durationMs)}\n${result.output}`,
                                );
                              })
                              .catch((problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem)))
                              .finally(() => setBusy(false));
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {removed.length > 0 && (
        <p className="empty" data-testid="removed-note">
          Удалённых из плана пунктов с сохранёнными метриками: {removed.length}. В сводку они не входят.
        </p>
      )}

      {error !== null && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ItemDetail({
  item,
  busy,
  command,
  checkOutput,
  onCommand,
  onStart,
  onBind,
  onRun,
}: {
  readonly item: ItemMetrics;
  readonly change: string;
  readonly busy: boolean;
  readonly command: string;
  readonly checkOutput: string | null;
  readonly onCommand: (value: string) => void;
  readonly onStart: () => void;
  readonly onBind: () => void;
  readonly onRun: () => void;
}) {
  return (
    <section className="item-detail" data-testid="item-detail">
      <div className="item-detail-main">
        <p className="section-label">Критерий приёмки</p>
        <p className="criterion" data-testid="criterion">
          {item.acceptance.criterion ?? 'не выделен из формулировки'}
        </p>
        <form
          className="acceptance-form"
          onSubmit={(event) => {
            event.preventDefault();
            onBind();
          }}
        >
          <label htmlFor={`acceptance-${item.key}`} className="section-label">
            Команда проверки приёмки
          </label>
          <div className="acceptance-row">
            <label className="field-search grow">
              <Icon name="terminal" size={14} />
              <input
                id={`acceptance-${item.key}`}
                aria-label="Команда проверки приёмки"
                className="mono"
                value={command}
                placeholder="например, npm test -- export"
                onChange={(event) => onCommand(event.target.value)}
              />
            </label>
            <button type="submit" className="btn" disabled={busy || command.trim() === ''}>
              Привязать
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || item.acceptance.command === null}
              data-testid="run-acceptance"
              onClick={onRun}
            >
              <Icon name="play" size={13} />
              Проверить
            </button>
          </div>
          <p className="muted small">Команда запускается в корне проекта; код выхода 0 — пункт принят.</p>
        </form>
        {checkOutput !== null && (
          <pre className="diff-preview" data-testid="check-output">
            {checkOutput}
          </pre>
        )}
      </div>
      <div className="item-detail-side">
        <dl className="kv-list">
          <dt>Взят в работу</dt>
          <dd>{item.firstStartedAt ?? '—'}</dd>
          <dt>Завершён</dt>
          <dd>{item.completedAt ?? (item.doneBeforeTracking ? 'до начала учёта' : '—')}</dd>
          <dt>Время цикла</dt>
          <dd>{formatDuration(item.cycleTimeMs)}</dd>
          <dt>Возвратов в работу</dt>
          <dd>{item.reopenCount}</dd>
        </dl>
        <p className="section-label">Затронутые файлы · {item.files.length}</p>
        {item.files.length === 0 ? (
          <p className="empty small">—</p>
        ) : (
          <ul className="file-list">
            {item.files.map((file) => (
              <li key={file}>
                {inVsCode() ? (
                  <button type="button" className="linkish mono small" onClick={() => openInEditor(file)}>
                    {file}
                  </button>
                ) : (
                  <span className="mono small">{file}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {item.state === 'not-started' && (
          <button type="button" className="btn" disabled={busy} onClick={onStart} data-testid="start-item">
            <Icon name="play" size={13} />
            Взять в работу
          </button>
        )}
      </div>
    </section>
  );
}
