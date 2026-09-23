import { useEffect, useState } from 'react';
import { fetchSpec, type SpecResponse } from '../lib/api.js';

/** Структурный просмотр основного спека capability. */
export function SpecView({ capability }: { readonly capability: string }) {
  const [spec, setSpec] = useState<SpecResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let current = true;
    setSpec(null);
    void fetchSpec(capability)
      .then((result) => {
        if (current) setSpec(result);
      })
      .catch((problem: unknown) => {
        if (current) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      current = false;
    };
  }, [capability]);

  if (error !== null) {
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  }
  if (spec === null) return <p className="empty">Загрузка спека…</p>;
  if (spec.spec === null) {
    return (
      <p className="empty" data-testid="spec-missing">
        У capability «{capability}» ещё нет основного спека. Он появится после архивации
        изменения, которое её вводит.
      </p>
    );
  }

  const { purpose, purposeIsPlaceholder, requirements, scenarioCount } = spec.spec;

  function toggle(name: string): void {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="spec-view" data-testid="spec-view">
      <p className="pane-title">
        {capability}
        <span className="count">
          {requirements.length} треб. · {scenarioCount} сцен.
        </span>
      </p>

      {purpose === null ? (
        <p className="empty">Назначение capability не описано.</p>
      ) : purposeIsPlaceholder ? (
        <p className="notice error" data-testid="purpose-placeholder">
          Назначение осталось заглушкой, которую проставила архивация. Его нужно заполнить в
          основном спеке: <code>openspec/specs/{capability}/spec.md</code>.
        </p>
      ) : (
        <p className="purpose">{purpose}</p>
      )}

      <ul className="spec-requirements">
        {requirements.map((requirement) => {
          const isCollapsed = collapsed.has(requirement.name);
          return (
            <li key={`${requirement.line}-${requirement.name}`}>
              <button
                type="button"
                className="requirement-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(requirement.name)}
                data-testid={`spec-requirement-${requirement.name}`}
              >
                <span className="tw">{isCollapsed ? '▸' : '▾'}</span>
                <span className="nm">{requirement.name}</span>
                <span className="tail">{requirement.scenarios.length} сцен.</span>
              </button>

              {!isCollapsed && (
                <div className="requirement-body">
                  {requirement.description !== '' && <p>{requirement.description}</p>}
                  <ul className="spec-scenarios">
                    {requirement.scenarios.map((scenario) => (
                      <li key={`${scenario.line}-${scenario.name}`}>{scenario.name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
