import { useCallback, useEffect, useState } from 'react';
import type {
  DeltaRequirement,
  DeltaView,
  RequirementComparison,
} from '@openspec-ide/core';
import { fetchComparison, fetchDeltas } from '../lib/api.js';
import { ArchivePreview } from './ArchivePreview.js';

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

type DeltasTab = 'deltas' | 'after-archive';

/**
 * Раздел дельт change: что change объявляет и — на второй вкладке — что станет
 * с основными спеками после архивации. Предпросмотр строится только при
 * открытии своей вкладки: это прогон CLI на временной копии проекта.
 */
export function Deltas({ change, revision }: { readonly change: string; readonly revision: number }) {
  const [tab, setTab] = useState<DeltasTab>('deltas');

  return (
    <div className="deltas-section">
      <div className="tabs" role="tablist" aria-label="Вид дельт">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'deltas'}
          onClick={() => setTab('deltas')}
          data-testid="tab-deltas"
        >
          Дельты
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'after-archive'}
          onClick={() => setTab('after-archive')}
          data-testid="tab-after-archive"
        >
          После архивации
        </button>
      </div>
      {tab === 'deltas' ? (
        <DeltaList change={change} revision={revision} />
      ) : (
        <ArchivePreview change={change} revision={revision} />
      )}
    </div>
  );
}

function DeltaList({ change, revision }: { readonly change: string; readonly revision: number }) {
  const [views, setViews] = useState<readonly DeltaView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    capability: string;
    requirement: DeltaRequirement;
  } | null>(null);
  const [comparison, setComparison] = useState<RequirementComparison | null>(null);

  useEffect(() => {
    let current = true;
    void fetchDeltas(change)
      .then((result) => {
        if (current) setViews(result.views);
      })
      .catch((problem: unknown) => {
        if (current) setError(problem instanceof Error ? problem.message : String(problem));
      });
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

  if (views === null) return <p className="empty">Загрузка дельт…</p>;

  if (views.length === 0) {
    return (
      <p className="empty" data-testid="no-deltas">
        Изменение «{change}» не содержит дельт спеков.
      </p>
    );
  }

  return (
    <div className="deltas" data-testid="deltas">
      {views.map((view) => (
        <section key={view.capability}>
          <p className="pane-title">
            {view.capability}
            <span className="count">
              {view.requirementCount} треб. · {view.scenarioCount} сцен.
            </span>
          </p>

          {view.purpose !== null && <p className="purpose">{view.purpose}</p>}

          {view.groups.map((group) => (
            <div
              key={group.operation}
              className={`dgroup ${OPERATION_CLASS[group.operation] ?? ''}`}
              data-testid={`group-${group.operation}`}
            >
              <header>
                <span className="glyph">{OPERATION_GLYPH[group.operation]}</span>
                {OPERATION_LABEL[group.operation]}
                <span className="n">
                  {group.requirements.length} треб.
                  {group.scenarioCount > 0 && ` · ${group.scenarioCount} сцен.`}
                </span>
              </header>
              <ul>
                {group.requirements.map((requirement) => (
                  <li key={`${requirement.line}-${requirement.name}`}>
                    <button
                      type="button"
                      className="requirement-link"
                      onClick={() => void openComparison(view.capability, requirement)}
                      data-testid={`requirement-${requirement.name}`}
                    >
                      {requirement.name}
                    </button>

                    {requirement.missingFields.length > 0 && (
                      <span className="incomplete" data-testid="incomplete">
                        не хватает: {requirement.missingFields.join(', ')}
                      </span>
                    )}

                    {requirement.reason !== null && (
                      <span className="field">Причина: {requirement.reason}</span>
                    )}
                    {requirement.migration !== null && (
                      <span className="field">Миграция: {requirement.migration}</span>
                    )}
                    {requirement.renamedFrom !== null && (
                      <span className="field">
                        {requirement.renamedFrom} → {requirement.renamedTo}
                      </span>
                    )}
                    {requirement.scenarios.length > 0 && (
                      <span className="sc">{requirement.scenarios.length} сцен.</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}

      {selected !== null && (
        <section className="comparison" data-testid="comparison">
          <p className="pane-title">
            Сравнение с основным спеком <span className="count">{selected.requirement.name}</span>
          </p>
          {comparison === null ? (
            <p className="empty">Сравнение готовится…</p>
          ) : comparison.missingInMainSpec ? (
            <div className="notice error" data-testid="missing-in-main">
              <p>Требование не найдено в основном спеке — заголовок не совпадает.</p>
              {comparison.similarNames.length > 0 && (
                <p>Похожие заголовки: {comparison.similarNames.join(', ')}</p>
              )}
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
                <dd data-testid="lost-scenarios">
                  {comparison.removedScenarios.join(', ') || '—'}
                </dd>
              </dl>
              {comparison.removedScenarios.length > 0 && (
                <p className="notice error" data-testid="lost-warning">
                  MODIFIED заменяет требование целиком, поэтому пропущенные сценарии будут
                  потеряны при архивации.
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
