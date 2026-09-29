import { useCallback, useEffect, useState } from 'react';
import type {
  CapabilityMap,
  DeltaRequirement,
  DeltaView,
  RequirementComparison,
} from '@openspec-ide/core';
import { fetchCapabilityMap, fetchComparison, fetchDeltas } from '../lib/api.js';
import { parseStep } from '../lib/traceLayout.js';
import { ArchivePreview } from './ArchivePreview.js';
import { Icon } from './Icon.js';
import { Trace } from './Trace.js';

const OPERATION_LABEL: Record<string, string> = {
  ADDED: 'Добавлено',
  MODIFIED: 'Изменено',
  REMOVED: 'Удалено',
  RENAMED: 'Переименовано',
};

const OPERATION_GLYPH: Record<string, string> = {
  ADDED: '+',
  MODIFIED: '~',
  REMOVED: '−',
  RENAMED: '→',
};

const OPERATION_CLASS: Record<string, string> = {
  ADDED: 'added',
  MODIFIED: 'modified',
  REMOVED: 'removed',
  RENAMED: 'renamed',
};

const OPERATION_CHIP: Record<string, string> = { ADDED: 'ok', MODIFIED: 'warn', REMOVED: 'bad', RENAMED: 'info' };
const OPERATIONS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'] as const;

export type DeltasTab = 'deltas' | 'trace' | 'after-archive';

/**
 * Раздел дельт change: что change объявляет, как сценарии закрыты планом и —
 * на третьей вкладке — что станет с основными спеками после архивации.
 * Предпросмотр строится только при открытии своей вкладки: это прогон CLI на
 * временной копии проекта.
 */
export function Deltas({
  change,
  revision,
  tab,
  onTab,
  onOpenFile,
}: {
  readonly change: string;
  readonly revision: number;
  readonly tab: DeltasTab;
  readonly onTab: (tab: DeltasTab) => void;
  readonly onOpenFile: (path: string, line: number | null) => void;
}) {
  return (
    <div className="deltas-section">
      <div className="tabs section-tabs" role="tablist" aria-label="Вид дельт">
        <button type="button" role="tab" aria-selected={tab === 'deltas'} onClick={() => onTab('deltas')} data-testid="tab-deltas">
          Дельты change
        </button>
        <button type="button" role="tab" aria-selected={tab === 'trace'} onClick={() => onTab('trace')} data-testid="tab-trace">
          <Icon name="trace" size={14} />
          Трассировка
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'after-archive'}
          onClick={() => onTab('after-archive')}
          data-testid="tab-after-archive"
        >
          После архивации
        </button>
      </div>
      {tab === 'deltas' ? (
        <DeltaList change={change} revision={revision} />
      ) : tab === 'trace' ? (
        <Trace change={change} revision={revision} onOpenFile={onOpenFile} />
      ) : (
        <div className="deltas-page">
          <div className="deltas-main">
            <ArchivePreview change={change} revision={revision} />
          </div>
        </div>
      )}
    </div>
  );
}

function DeltaList({ change, revision }: { readonly change: string; readonly revision: number }) {
  const [views, setViews] = useState<readonly DeltaView[] | null>(null);
  const [map, setMap] = useState<CapabilityMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<{
    capability: string;
    requirement: DeltaRequirement;
  } | null>(null);
  const [comparison, setComparison] = useState<RequirementComparison | null>(null);

  useEffect(() => {
    let current = true;
    void fetchDeltas(change)
      .then((result) => {
        if (!current) return;
        setViews(result.views);
        // Раскрыто первое требование — чтобы сценарии были видны сразу.
        const first = result.views[0]?.groups[0]?.requirements[0];
        const firstView = result.views[0];
        if (first !== undefined && firstView !== undefined) {
          setOpen((currentOpen) => (currentOpen.size > 0 ? currentOpen : new Set([`${firstView.capability}/${first.name}`])));
        }
      })
      .catch((problem: unknown) => {
        if (current) setError(problem instanceof Error ? problem.message : String(problem));
      });
    void fetchCapabilityMap()
      .then((result) => {
        if (current) setMap(result);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [change, revision]);

  const openComparison = useCallback(
    async (capability: string, requirement: DeltaRequirement) => {
      setSelected({ capability, requirement });
      setComparison(null);
      const result = await fetchComparison(change, capability, requirement.name);
      setComparison(result.comparison);
    },
    [change],
  );

  if (error !== null) {
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  }

  if (views === null) {
    return (
      <div className="page-skeleton" aria-busy="true" aria-label="Загрузка дельт">
        <span className="skeleton" style={{ height: 44 }} />
        <span className="skeleton" style={{ height: 160 }} />
        <span className="skeleton" style={{ height: 44 }} />
      </div>
    );
  }

  if (views.length === 0) {
    return (
      <div className="deltas-page">
        <div className="deltas-main">
          <p className="empty" data-testid="no-deltas">
            Изменение «{change}» не содержит дельт спеков.
          </p>
        </div>
      </div>
    );
  }

  const totals = OPERATIONS.map((operation) => ({
    operation,
    count: views.reduce(
      (sum, view) => sum + (view.groups.find((group) => group.operation === operation)?.requirements.length ?? 0),
      0,
    ),
  }));
  const overlaps = (map?.nodes ?? [])
    .filter((node) => views.some((view) => view.capability === node.capability))
    .map((node) => ({ node, others: node.links.filter((link) => link.change !== change) }))
    .filter((entry) => entry.others.length > 0);
  const toggle = (key: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="deltas-page">
      <div className="deltas-main" data-testid="deltas">
        <div className="delta-totals" data-testid="delta-totals">
          {totals.map(({ operation, count }) => (
            <span key={operation} className={count > 0 ? `chip ${OPERATION_CHIP[operation]}` : 'chip faded'}>
              {OPERATION_GLYPH[operation]} {count} {OPERATION_LABEL[operation]?.toLocaleLowerCase('ru-RU')}
            </span>
          ))}
        </div>

        {views.map((view) => (
          <section key={view.capability} className="delta-cap">
            <header className="delta-cap-head">
              <Icon name="spec" size={16} className="muted" />
              <h2 className="mono">{view.capability}</h2>
              <span className="muted small">
                {view.requirementCount} треб. · {view.scenarioCount} сцен.
              </span>
            </header>

            {view.purpose !== null && <p className="purpose">{view.purpose}</p>}

            {view.groups.map((group) => (
              <div
                key={group.operation}
                className={`dgroup ${OPERATION_CLASS[group.operation] ?? ''}`}
                data-testid={`group-${group.operation}`}
              >
                <header>
                  <span className={`chip ${OPERATION_CHIP[group.operation]}`}>
                    {OPERATION_GLYPH[group.operation]} {OPERATION_LABEL[group.operation]}
                  </span>
                  <span className="n">
                    {group.requirements.length} треб.
                    {group.scenarioCount > 0 && ` · ${group.scenarioCount} сцен.`}
                  </span>
                </header>
                <ul>
                  {group.requirements.map((requirement) => {
                    const key = `${view.capability}/${requirement.name}`;
                    const expanded = open.has(key);
                    return (
                      <li key={`${requirement.line}-${requirement.name}`} className="req">
                        <div className="req-row">
                          <button
                            type="button"
                            className="icon-btn small"
                            aria-expanded={expanded}
                            aria-label={expanded ? 'Свернуть сценарии' : 'Показать сценарии'}
                            onClick={() => toggle(key)}
                            disabled={requirement.scenarios.length === 0}
                            data-testid={`expand-${requirement.name}`}
                          >
                            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
                          </button>
                          <button
                            type="button"
                            className="requirement-link"
                            onClick={() => void openComparison(view.capability, requirement)}
                            title="Сравнить с основным спеком"
                            data-testid={`requirement-${requirement.name}`}
                          >
                            {requirement.name}
                          </button>
                          {requirement.missingFields.length > 0 && (
                            <span className="chip bad" data-testid="incomplete">
                              не хватает: {requirement.missingFields.join(', ')}
                            </span>
                          )}
                          <span className="spacer" />
                          {requirement.scenarios.length > 0 && (
                            <span className="sc muted small">{requirement.scenarios.length} сцен.</span>
                          )}
                        </div>
                        {(requirement.reason !== null || requirement.migration !== null || requirement.renamedFrom !== null) && (
                          <div className="req-fields">
                            {requirement.reason !== null && <span className="field">Причина: {requirement.reason}</span>}
                            {requirement.migration !== null && (
                              <span className="field">Миграция: {requirement.migration}</span>
                            )}
                            {requirement.renamedFrom !== null && (
                              <span className="field">
                                {requirement.renamedFrom} → {requirement.renamedTo}
                              </span>
                            )}
                          </div>
                        )}
                        {expanded && (
                          <div className="req-scenarios">
                            {requirement.scenarios.map((scenario) => (
                              <div key={scenario.line} className="scenario-card">
                                <div className="scenario-name">{scenario.name}</div>
                                <dl className="steps">
                                  {scenario.steps.map((step, index) => {
                                    const parsed = parseStep(step);
                                    return [
                                      <dt key={`t${index}`} className="mono">
                                        {parsed.label}
                                      </dt>,
                                      <dd key={`d${index}`}>{parsed.text}</dd>,
                                    ];
                                  })}
                                </dl>
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </div>

      <aside className="deltas-aside">
        {selected !== null ? (
          <section className="comparison" data-testid="comparison">
            <div className="aside-head">
              <p className="section-label">Сравнение с основным спеком</p>
              <button type="button" className="icon-btn" aria-label="Закрыть сравнение" onClick={() => setSelected(null)}>
                <Icon name="x" />
              </button>
            </div>
            <p className="comparison-name">{selected.requirement.name}</p>
            {comparison === null ? (
              <p className="empty">Сравнение готовится…</p>
            ) : comparison.missingInMainSpec ? (
              <div className="notice error" data-testid="missing-in-main">
                <p>Требование не найдено в основном спеке — заголовок не совпадает.</p>
                {comparison.similarNames.length > 0 && <p>Похожие заголовки: {comparison.similarNames.join(', ')}</p>}
              </div>
            ) : (
              <>
                <div className="diff">
                  {comparison.description.map((line, position) => (
                    <div
                      key={`${line.kind}-${position}`}
                      className={`row ${line.kind === 'added' ? 'plus' : line.kind === 'removed' ? 'minus' : 'ctx'}`}
                    >
                      <span>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
                      <span>{line.text}</span>
                    </div>
                  ))}
                </div>
                <dl className="scenario-diff">
                  <dt>Сценарии сохранены</dt>
                  <dd>{comparison.keptScenarios.join(', ') || '—'}</dd>
                  <dt>Добавлены</dt>
                  <dd>{comparison.addedScenarios.join(', ') || '—'}</dd>
                  <dt>Потеряны</dt>
                  <dd data-testid="lost-scenarios">{comparison.removedScenarios.join(', ') || '—'}</dd>
                </dl>
                {comparison.removedScenarios.length > 0 && (
                  <p className="notice error" data-testid="lost-warning">
                    MODIFIED заменяет требование целиком, поэтому пропущенные сценарии будут потеряны при архивации.
                  </p>
                )}
              </>
            )}
          </section>
        ) : (
          <>
            {overlaps.map(({ node, others }) => (
              <div key={node.capability} className="notice warn overlap" data-testid={`overlap-${node.capability}`}>
                <p>
                  <Icon name="alert" size={15} className="warn-icon" /> <b>Пересечение по </b>
                  <span className="mono">{node.capability}</span>
                </p>
                <p>
                  Этот спек меняет ещё {others.map((link) => link.change).join(', ')}. Архивируйте по очереди и сверяйте
                  предпросмотр.
                  {others.some((link) => link.conflictingRequirements.length > 0) && (
                    <>
                      {' '}
                      Общие требования:{' '}
                      {[...new Set(others.flatMap((link) => link.conflictingRequirements))].join(', ')}.
                    </>
                  )}
                </p>
              </div>
            ))}
            <p className="section-label">
              Спеки этого change <span className="badge">{views.length}</span>
            </p>
            <ul className="detail-rows">
              {views.map((view) => {
                const node = map?.nodes.find((entry) => entry.capability === view.capability);
                return (
                  <li key={view.capability} className="cap-row">
                    <span className="mono">{view.capability}</span>
                    {node !== undefined && !node.exists && <span className="chip accent">новая</span>}
                    <span className="spacer" />
                    {view.groups.map((group) => (
                      <span key={group.operation} className={`chip ${OPERATION_CHIP[group.operation]}`}>
                        {OPERATION_GLYPH[group.operation]}
                        {group.requirements.length}
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
            <p className="muted small">Щёлкните требование, чтобы сравнить его с основным спеком.</p>
          </>
        )}
      </aside>
    </div>
  );
}
