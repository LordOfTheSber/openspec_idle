import { useEffect, useMemo, useState } from 'react';
import {
  MODULE_KIND_LABEL,
  affectedConsumers,
  groupModules,
  moduleNeighbours,
  type WorkspaceTree,
} from '@openspec-ide/core';
import {
  fetchBrokenTags,
  fetchLinks,
  saveModules,
  type BrokenTag,
  type LinkGraph,
  type ModulesView,
} from '../lib/api.js';
import { Discovery } from './Discovery.js';
import { ModuleGraph, type ExtraEdge, type ModuleMark } from './ModuleGraph.js';

/**
 * Раздел «Модули»: список по группам, граф зависимостей и панель модуля.
 * Без карты — предложение обнаружить модули по манифестам сборки.
 */
export function Modules({
  view,
  tree,
  focusChange,
  revision = 0,
  onOpenChange,
  onOpenSpec,
  onChanged,
}: {
  readonly view: ModulesView;
  readonly tree: WorkspaceTree;
  /** Change, чьи затронутые потребители подсвечиваются на графе. */
  readonly focusChange: string | null;
  /** Счётчик изменений на диске: связи перечитываются. */
  readonly revision?: number;
  readonly onOpenChange: (change: string) => void;
  readonly onOpenSpec: (capability: string) => void;
  readonly onChanged: () => void;
}) {
  const { map, overlay } = view;
  const [selected, setSelected] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(!map.exists);
  const [links, setLinks] = useState<LinkGraph | null>(null);
  const [broken, setBroken] = useState<readonly BrokenTag[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void Promise.all([fetchLinks(), fetchBrokenTags()]).then(([graph, tags]) => {
      if (!current) return;
      setLinks(graph);
      setBroken(tags.tags);
    });
    return () => {
      current = false;
    };
  }, [revision, map]);

  const extraEdges: ExtraEdge[] = (links?.edges ?? []).map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: `${edge.count} ссыл.`,
    kind: edge.mismatch ? 'mismatch' : 'link',
  }));
  const mismatches = (links?.edges ?? []).filter((edge) => edge.mismatch);

  async function addDependency(from: string, to: string): Promise<void> {
    setSaveError(null);
    try {
      await saveModules(
        map.modules.map((module) => ({
          ...module,
          path: module.path ?? '',
          dependsOn: module.id === from ? [...module.dependsOn, to] : module.dependsOn,
        })),
      );
      onChanged();
    } catch (problem) {
      setSaveError(problem instanceof Error ? problem.message : String(problem));
    }
  }

  useEffect(() => {
    if (!map.exists) setDiscovering(true);
  }, [map.exists]);

  const changesOf = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const [change, ids] of Object.entries(overlay.changes)) {
      for (const id of ids) (result[id] ??= []).push(change);
    }
    return result;
  }, [overlay.changes]);
  const specsOf = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const [capability, id] of Object.entries(overlay.capabilities)) {
      if (id !== null) (result[id] ??= []).push(capability);
    }
    return result;
  }, [overlay.capabilities]);
  const counts = useMemo(
    () => Object.fromEntries(Object.entries(changesOf).map(([id, list]) => [id, list.length])),
    [changesOf],
  );

  const marks = useMemo(() => {
    const result = new Map<string, ModuleMark>();
    const sources = focusChange === null ? [] : (overlay.changes[focusChange] ?? []);
    for (const id of sources) result.set(id, 'source');
    for (const consumer of affectedConsumers(sources, map.modules)) {
      result.set(consumer.id, consumer.depth === 1 ? 'direct' : 'transitive');
    }
    return result;
  }, [focusChange, map.modules, overlay.changes]);

  if (discovering) {
    return (
      <Discovery
        existing={map.exists ? map.modules : []}
        onCancel={map.exists ? () => setDiscovering(false) : null}
        onSaved={() => {
          setDiscovering(false);
          onChanged();
        }}
      />
    );
  }

  const module = map.modules.find((entry) => entry.id === selected) ?? null;
  const neighbours = module === null ? null : moduleNeighbours(module.id, map.modules);
  const outside = Object.entries(overlay.capabilities).filter(([, id]) => id === null).map(([path]) => path);

  return (
    <div className="modules-section" data-testid="modules">
      <div className="modules-toolbar">
        <span className="crumbs">
          {map.file} · модулей {map.modules.length}
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setDiscovering(true)} data-testid="rediscover">
          Обнаружить модули…
        </button>
      </div>

      {map.problems.length > 0 && (
        <div className="notice error" role="alert" data-testid="module-problems">
          <p>Ошибки карты модулей — остальные модули работают:</p>
          <ul className="failure-details">
            {map.problems.map((problem, index) => (
              <li key={index}>
                {problem.module === null ? 'карта' : <code>{problem.module}</code>} · <code>{problem.field}</code> — {problem.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {focusChange !== null && marks.size > 0 && (
        <p className="notice info impact-legend" data-testid="impact-legend">
          <span>
            Change <b>{focusChange}</b>:
          </span>
          <span className="impact-key source">его модули</span>
          <span className="impact-key direct">прямые потребители</span>
          <span className="impact-key transitive">транзитивные</span>
        </p>
      )}

      {mismatches.length > 0 && (
        <div className="notice info" data-testid="link-mismatches">
          <p>Требования ссылаются на модули, от которых модуль не зависит по карте:</p>
          <ul className="failure-details">
            {mismatches.map((edge) => (
              <li key={`${edge.from}->${edge.to}`} data-testid={`mismatch-${edge.from}-${edge.to}`}>
                <code>{edge.from}</code> → <code>{edge.to}</code> · ссылок {edge.count}{' '}
                <button type="button" className="link" onClick={() => void addDependency(edge.from, edge.to)} data-testid="add-dependency">
                  добавить зависимость в карту
                </button>
              </li>
            ))}
          </ul>
          {saveError !== null && <p className="small">{saveError}</p>}
        </div>
      )}

      {broken.length > 0 && (
        <div className="notice error" data-testid="broken-tags">
          <p>Метки в коде, которые не разрешаются до требования:</p>
          <ul className="failure-details">
            {broken.map((tag) => (
              <li key={`${tag.path}:${tag.line}`}>
                <code>
                  {tag.path}:{tag.line}
                </code>{' '}
                @spec {tag.module}: {tag.requirement} —{' '}
                {tag.reason === 'unknown-module' ? 'нет такого модуля' : 'нет такого требования'}
                {tag.suggestion !== null && (
                  <>
                    ; теперь оно называется <b>{tag.suggestion}</b>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="modules-body">
        <nav className="module-list" aria-label="Модули">
          {groupModules(map.modules).map((group) => (
            <div key={group.title}>
              <p className="grp">
                {group.title} <span className="count">{group.modules.length}</span>
              </p>
              {group.modules.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={`module-row ${selected === entry.id ? 'sel' : ''}`}
                  onClick={() => setSelected(entry.id)}
                  data-testid={`module-${entry.id}`}
                >
                  <span className={`kind ${entry.kind}`}>{entry.kind === 'service' ? 'S' : entry.kind === 'ui' ? 'U' : 'L'}</span>
                  <span className="mono">{entry.id}</span>
                  <span className="n">{counts[entry.id] ?? 0}</span>
                </button>
              ))}
            </div>
          ))}
          {outside.length > 0 && (
            <div>
              <p className="grp">
                Вне модулей <span className="count">{outside.length}</span>
              </p>
              {outside.map((path) => (
                <button type="button" key={path} className="module-row" onClick={() => onOpenSpec(path)}>
                  <span className="kind none">·</span>
                  <span className="mono">{path}</span>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="module-graph-wrap">
          <ModuleGraph
            modules={map.modules}
            selected={selected}
            marks={marks}
            counts={counts}
            extraEdges={extraEdges}
            onSelect={setSelected}
          />
        </div>

        <aside className="module-panel" data-testid="module-panel">
          {module === null || neighbours === null ? (
            <p className="empty">Выберите модуль в списке или на графе.</p>
          ) : (
            <>
              <p className="pane-title">
                {module.title} <span className="count">{MODULE_KIND_LABEL[module.kind]}</span>
              </p>
              <dl>
                <dt>id</dt>
                <dd className="mono">{module.id}</dd>
                <dt>Код</dt>
                <dd className="mono">{module.path ?? '—'}</dd>
                <dt>Спеки</dt>
                <dd className="mono">{module.specs}/…</dd>
              </dl>
              <p className="grp">Зависит от · {neighbours.dependsOn.length}</p>
              <ul className="chips-list" data-testid="module-depends">
                {neighbours.dependsOn.map((id) => (
                  <li key={id}>
                    <button type="button" className="chip" onClick={() => setSelected(id)}>
                      {id}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="grp">Потребители · {neighbours.consumers.length}</p>
              <ul className="chips-list" data-testid="module-consumers">
                {neighbours.consumers.map((id) => (
                  <li key={id}>
                    <button type="button" className="chip" onClick={() => setSelected(id)}>
                      {id}
                    </button>
                  </li>
                ))}
              </ul>
              {(links?.undocumented ?? []).some((entry) => entry.from === module.id) && (
                <>
                  <p className="grp">Зависимости без ссылок в спеках</p>
                  <p className="muted small" data-testid="module-undocumented">
                    {(links?.undocumented ?? [])
                      .filter((entry) => entry.from === module.id)
                      .map((entry) => entry.to)
                      .join(', ')}{' '}
                    — контракт между модулями не зафиксирован ни одним требованием.
                  </p>
                </>
              )}
              <p className="grp">Активные changes · {changesOf[module.id]?.length ?? 0}</p>
              <ul className="link-list" data-testid="module-changes">
                {(changesOf[module.id] ?? []).map((change) => (
                  <li key={change}>
                    <button type="button" className="link" onClick={() => onOpenChange(change)}>
                      {change}
                    </button>
                    {(overlay.changes[change]?.length ?? 0) > 1 && <span className="chip warn">сквозной</span>}
                  </li>
                ))}
              </ul>
              <p className="grp">Спеки · {specsOf[module.id]?.length ?? 0}</p>
              <ul className="link-list" data-testid="module-specs">
                {(specsOf[module.id] ?? []).map((capability) => (
                  <li key={capability}>
                    <button type="button" className="link mono" onClick={() => onOpenSpec(capability)}>
                      {capability}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
      {tree.changes.length === 0 && <p className="empty">Активных changes нет.</p>}
    </div>
  );
}
