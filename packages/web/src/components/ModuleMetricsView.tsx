import { useEffect, useState } from 'react';
import { fetchModuleMetrics, type ModuleMetrics } from '../lib/api.js';
import { formatDuration, formatTokens } from '../lib/format.js';

/** Сводка метрик по changes выбранных модулей. */
export function ModuleMetricsView({
  modules,
  revision,
  onOpenChange,
}: {
  readonly modules: readonly string[];
  readonly revision: number;
  readonly onOpenChange: (change: string) => void;
}) {
  const [summary, setSummary] = useState<ModuleMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = modules.join(',');

  useEffect(() => {
    let current = true;
    void fetchModuleMetrics(key.split(','))
      .then((result) => {
        if (current) {
          setSummary(result);
          setError(null);
        }
      })
      .catch((problem: unknown) => {
        if (current) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      current = false;
    };
  }, [key, revision]);

  if (error !== null) return <p className="notice error">{error}</p>;
  if (summary === null) return <p className="empty">Загрузка сводки…</p>;

  return (
    <div className="module-metrics" data-testid="module-metrics">
      <p className="pane-title">
        Сводка по модулям <span className="count">{modules.join(', ')}</span>
      </p>
      <div className="kpis">
        <div>
          <b data-testid="module-metrics-changes">{summary.changes.length}</b>
          <span>активных changes</span>
        </div>
        <div>
          <b data-testid="module-metrics-items">
            {summary.complete}/{summary.total}
          </b>
          <span>пунктов плана</span>
        </div>
        <div>
          <b>{summary.tokensTotal === null ? 'нет данных' : formatTokens(summary.tokensTotal)}</b>
          <span>токенов</span>
        </div>
        <div>
          <b>{formatDuration(summary.agentTimeMs)}</b>
          <span>время агента</span>
        </div>
        <div>
          <b>
            {summary.runs}
            {summary.failedRuns > 0 ? ` (${summary.failedRuns} неуд.)` : ''}
          </b>
          <span>запусков</span>
        </div>
      </div>
      <table className="m">
        <thead>
          <tr>
            <th>Change</th>
            <th>Модули</th>
            <th>Пункты</th>
            <th>Токены</th>
            <th>Время агента</th>
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((row) => (
            <tr key={row.change} data-testid={`module-metrics-row-${row.change}`}>
              <td>
                <button type="button" className="link mono" onClick={() => onOpenChange(row.change)}>
                  {row.change}
                </button>
              </td>
              <td className="mono">{row.modules.join(', ')}</td>
              <td>
                {row.complete}/{row.total}
              </td>
              <td>{row.tokensTotal === null ? '—' : formatTokens(row.tokensTotal)}</td>
              <td>{formatDuration(row.agentTimeMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
