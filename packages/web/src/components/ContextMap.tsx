import { useCallback, useEffect, useMemo, useState } from 'react';
import { type ContextIssue, type ContextMap as ContextMapModel, contextBundle } from '@openspec-ide/core';
import { fetchContextMap } from '../lib/api.js';
import {
  type ContextLayout,
  type ContextNodeKind,
  type LayoutNode,
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutContextMap,
  neighbourhood,
  nodeKey,
} from '../lib/contextLayout.js';
import { plural } from '../lib/format.js';
import { inVsCode, openInEditor } from '../lib/host.js';
import { readPref, writePref } from '../lib/prefs.js';

type View = 'graph' | 'matrix';
const VIEWS: readonly View[] = ['graph', 'matrix'];

const KIND_LABEL: Record<ContextNodeKind, string> = { adr: 'ADR', module: 'Модуль', domain: 'Домен' };

/** Длинные имена в узле графа обрезаются; полное имя — во всплывающей подсказке. */
const MAX_LABEL = 26;

function short(label: string): string {
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

/**
 * Раздел «Контекст»: модули из `openspec/context/modules/`, домены — спеки
 * из `openspec/specs/`, ADR из `openspec/context/adr/` и связи между ними.
 * Граф показывает связи многие-ко-многим, матрица — то же таблицей.
 */
export function ContextMap({ revision }: { readonly revision: number }) {
  const [map, setMap] = useState<ContextMapModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => readPref('context-view', VIEWS, 'graph'));
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMap(await fetchContextMap());
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const layout = useMemo(() => (map === null ? null : layoutContextMap(map)), [map]);

  // Выбранный узел мог исчезнуть после правки файлов.
  useEffect(() => {
    if (selected !== null && layout !== null && !layout.nodes.some((node) => node.key === selected)) setSelected(null);
  }, [layout, selected]);

  function chooseView(next: View): void {
    setView(next);
    writePref('context-view', next);
  }

  if (error !== null && map === null) {
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  }
  if (map === null || layout === null) return <p className="empty">Загрузка карты контекста…</p>;

  const errors = map.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = map.issues.length - errors;

  return (
    <div className="context-map" data-testid="context-map">
      <div className="context-toolbar">
        <span className="context-summary" data-testid="context-summary">
          {plural(map.modules.length, ['модуль', 'модуля', 'модулей'])} ·{' '}
          {plural(map.domains.length, ['домен', 'домена', 'доменов'])} ·{' '}
          {plural(map.links.length, ['связь', 'связи', 'связей'])}
          {map.adrs.length > 0 && <> · {map.adrs.length} ADR</>}
        </span>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="Вид">
          <button type="button" aria-pressed={view === 'graph'} onClick={() => chooseView('graph')} data-testid="context-view-graph">
            Граф
          </button>
          <button type="button" aria-pressed={view === 'matrix'} onClick={() => chooseView('matrix')} data-testid="context-view-matrix">
            Матрица
          </button>
        </div>
        <button type="button" className="btn" onClick={() => void load()} data-testid="context-reload">
          Обновить
        </button>
      </div>

      {!map.configured && <NotConfigured />}

      {map.issues.length > 0 && (
        <details className="context-issues" open={errors > 0} data-testid="context-issues">
          <summary>
            {errors > 0 && <span className="chip bad">{plural(errors, ['ошибка', 'ошибки', 'ошибок'])}</span>}
            {warnings > 0 && (
              <span className="chip warn">{plural(warnings, ['предупреждение', 'предупреждения', 'предупреждений'])}</span>
            )}
          </summary>
          <IssueList issues={map.issues} onSelect={setSelected} />
        </details>
      )}

      {map.configured || map.domains.length > 0 ? (
        <div className="context-body">
          {view === 'graph' ? (
            <Graph layout={layout} selected={selected} hovered={hovered} onSelect={setSelected} onHover={setHovered} />
          ) : (
            <Matrix map={map} selected={selected} onSelect={setSelected} />
          )}
          {selected !== null && <Details map={map} selected={selected} onSelect={setSelected} />}
        </div>
      ) : (
        <p className="empty">В проекте нет ни модулей, ни спеков.</p>
      )}
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="notice info" data-testid="context-not-configured">
      <p>
        Модули ещё не описаны. Заведите папку модуля <code>openspec/context/modules/&lt;модуль&gt;/</code> с файлами{' '}
        <code>context.md</code> (сам контекст) и <code>index.md</code> — в его frontmatter перечислите домены:
      </p>
      <pre className="context-sample">{`---
module: sds-master
description: Хранение данных сессии in-memory, жизненный цикл сессии, репликация
domains: [session-lifecycle, session-data, replication]   # папки из openspec/specs/
code_paths: [sds-master/src/main/java, sds-master-api]
depends_on: [sds-router]
---`}</pre>
      <p>
        Решения — в <code>openspec/context/adr/*.md</code> с полями <code>modules</code> и <code>domains</code>. Общий
        контекст проекта — файлы <code>openspec/context/*.md</code>.
      </p>
    </div>
  );
}

function IssueList({ issues, onSelect }: { readonly issues: readonly ContextIssue[]; readonly onSelect: (key: string) => void }) {
  const vscode = inVsCode();
  return (
    <ul className="structure-issues">
      {issues.map((issue, index) => (
        <li key={`${issue.kind}-${issue.path}-${index}`} data-testid={`context-issue-${issue.kind}`}>
          <span className={issue.severity === 'error' ? 'chip bad' : 'chip warn'}>
            {issue.severity === 'error' ? 'ошибка' : 'внимание'}
          </span>
          <span className="body">
            <span>{issue.message}</span>
            <span className="where">
              {issue.path}
              {issue.line !== null && `:${issue.line}`}
            </span>
          </span>
          {issue.module !== undefined && (
            <button type="button" className="btn small" onClick={() => onSelect(nodeKey('module', issue.module ?? ''))}>
              На карте
            </button>
          )}
          {issue.module === undefined && issue.domain !== undefined && (
            <button type="button" className="btn small" onClick={() => onSelect(nodeKey('domain', issue.domain ?? ''))}>
              На карте
            </button>
          )}
          {vscode && (
            <button type="button" className="btn small" onClick={() => openInEditor(issue.path, issue.line)}>
              Открыть
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Graph({
  layout,
  selected,
  hovered,
  onSelect,
  onHover,
}: {
  readonly layout: ContextLayout;
  readonly selected: string | null;
  readonly hovered: string | null;
  readonly onSelect: (key: string | null) => void;
  readonly onHover: (key: string | null) => void;
}) {
  const focus = hovered ?? selected;
  const near = focus === null ? null : neighbourhood(layout, focus);
  const edgeActive = (from: string, to: string): boolean => focus !== null && (from === focus || to === focus);

  return (
    <div className="context-graph-wrap">
      <svg
        className="context-graph"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="Граф связей модулей, доменов и ADR"
        data-testid="context-graph"
        onClick={() => onSelect(null)}
      >
        <defs>
          <marker id="ctx-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="ctx-arrow" />
          </marker>
        </defs>

        {layout.columns.map((column) => (
          <text key={column.kind} x={column.x} y={16} className="ctx-column">
            {column.title}
          </text>
        ))}

        <g>
          {layout.edges.map((edge) => (
            <path
              key={edge.key}
              d={edge.path}
              className={[
                'ctx-edge',
                edge.kind,
                edge.resolved ? '' : 'unresolved',
                edge.cyclic ? 'cyclic' : '',
                edgeActive(edge.from, edge.to) ? 'active' : '',
                focus !== null && !edgeActive(edge.from, edge.to) ? 'faded' : '',
              ]
                .filter((name) => name !== '')
                .join(' ')}
              markerEnd={edge.kind === 'depends' ? 'url(#ctx-arrow)' : undefined}
              data-testid={`ctx-edge-${edge.key}`}
            />
          ))}
        </g>

        <g>
          {layout.nodes.map((node) => (
            <GraphNode
              key={node.key}
              node={node}
              selected={node.key === selected}
              faded={near !== null && !near.has(node.key)}
              onSelect={onSelect}
              onHover={onHover}
            />
          ))}
        </g>
      </svg>

      <p className="context-legend">
        <span className="swatch module" /> модуль <span className="swatch domain" /> домен <span className="swatch adr" /> ADR{' '}
        <span className="line depends" /> depends_on <span className="line unresolved" /> не найдено
      </p>
    </div>
  );
}

function GraphNode({
  node,
  selected,
  faded,
  onSelect,
  onHover,
}: {
  readonly node: LayoutNode;
  readonly selected: boolean;
  readonly faded: boolean;
  readonly onSelect: (key: string) => void;
  readonly onHover: (key: string | null) => void;
}) {
  const classes = ['ctx-node', node.kind, node.resolved ? '' : 'unresolved', selected ? 'selected' : '', faded ? 'faded' : '']
    .filter((name) => name !== '')
    .join(' ');
  return (
    <g
      className={classes}
      transform={`translate(${node.x},${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${KIND_LABEL[node.kind]} ${node.label}`}
      aria-pressed={selected}
      data-testid={`ctx-node-${node.key}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.key);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.key);
        }
      }}
      onMouseEnter={() => onHover(node.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.key)}
      onBlur={() => onHover(null)}
    >
      <title>
        {KIND_LABEL[node.kind]} {node.label}
        {node.resolved ? '' : ' — не найден'}
      </title>
      <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} />
      <text x={10} y={NODE_HEIGHT / 2 + 4}>
        {short(node.label)}
      </text>
      {node.degree > 0 && (
        <text x={NODE_WIDTH - 8} y={NODE_HEIGHT / 2 + 4} className="ctx-degree" textAnchor="end">
          {node.degree}
        </text>
      )}
    </g>
  );
}

function Matrix({
  map,
  selected,
  onSelect,
}: {
  readonly map: ContextMapModel;
  readonly selected: string | null;
  readonly onSelect: (key: string) => void;
}) {
  const linked = new Set(map.links.map((link) => `${link.module}\u0000${link.domain}`));
  if (map.modules.length === 0) return <p className="empty">Модулей нет — строить матрицу не из чего.</p>;
  return (
    <div className="context-matrix-wrap">
      <table className="context-matrix" data-testid="context-matrix">
        <thead>
          <tr>
            <th scope="col">Модуль \ домен</th>
            {map.domains.map((domain) => (
              <th
                key={domain.id}
                scope="col"
                className={[domain.specPath === null ? 'unresolved' : '', selected === nodeKey('domain', domain.id) ? 'selected' : '']
                  .filter((name) => name !== '')
                  .join(' ')}
              >
                <button type="button" className="linkish" onClick={() => onSelect(nodeKey('domain', domain.id))} title={domain.id}>
                  <span className="vertical">{domain.id}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {map.modules.map((module) => (
            <tr key={module.id} className={selected === nodeKey('module', module.id) ? 'selected' : undefined}>
              <th scope="row">
                <button type="button" className="linkish" onClick={() => onSelect(nodeKey('module', module.id))}>
                  {module.id}
                </button>
              </th>
              {map.domains.map((domain) => {
                const on = linked.has(`${module.id}\u0000${domain.id}`);
                return (
                  <td
                    key={domain.id}
                    className={on ? (domain.specPath === null ? 'on unresolved' : 'on') : undefined}
                    aria-label={on ? `${module.id} — ${domain.id}` : undefined}
                    data-testid={on ? `ctx-cell-${module.id}-${domain.id}` : undefined}
                  >
                    {on ? '●' : ''}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="totals">
            <th scope="row">модулей</th>
            {map.domains.map((domain) => (
              <td key={domain.id} className={domain.modules.length === 0 ? 'zero' : undefined}>
                {domain.modules.length}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function FileButton({ path, label }: { readonly path: string | null; readonly label: string }) {
  const vscode = inVsCode();
  if (path === null) return <span className="chip bad">{label}: нет файла</span>;
  return vscode ? (
    <button type="button" className="btn small" onClick={() => openInEditor(path)} title={path}>
      {label}
    </button>
  ) : (
    <span className="mono ctx-path" title={path}>
      {path}
    </span>
  );
}

function Chips({
  kind,
  ids,
  map,
  onSelect,
}: {
  readonly kind: ContextNodeKind;
  readonly ids: readonly string[];
  readonly map: ContextMapModel;
  readonly onSelect: (key: string) => void;
}) {
  if (ids.length === 0) return <span className="muted">—</span>;
  const known = (id: string): boolean =>
    kind === 'module'
      ? map.modules.some((module) => module.id === id)
      : kind === 'domain'
        ? map.domains.some((domain) => domain.id === id && domain.specPath !== null)
        : true;
  const label = (id: string): string => (kind === 'adr' ? (map.adrs.find((adr) => adr.path === id)?.id ?? id) : id);
  return (
    <span className="ctx-chips">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          className={known(id) ? `ctx-chip ${kind}` : `ctx-chip ${kind} unresolved`}
          onClick={() => onSelect(nodeKey(kind, id))}
          title={known(id) ? id : `${id} — не найден`}
        >
          {label(id)}
        </button>
      ))}
    </span>
  );
}

function Details({
  map,
  selected,
  onSelect,
}: {
  readonly map: ContextMapModel;
  readonly selected: string;
  readonly onSelect: (key: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const separator = selected.indexOf(':');
  const kind = selected.slice(0, separator) as ContextNodeKind;
  const id = selected.slice(separator + 1);
  useEffect(() => setCopied(false), [selected]);

  const close = (
    <button type="button" className="btn small" onClick={() => onSelect(null)} aria-label="Закрыть">
      ✕
    </button>
  );

  if (kind === 'module') {
    const module = map.modules.find((item) => item.id === id);
    if (module === undefined) {
      return (
        <aside className="context-details" data-testid="context-details">
          <header>
            <span className="chip bad">не описан</span> <b className="mono">{id}</b>
            <span className="spacer" />
            {close}
          </header>
          <p className="empty">
            На модуль ссылаются, но папки <code>openspec/context/modules/</code> с <code>module: {id}</code> нет.
          </p>
        </aside>
      );
    }
    const bundle = contextBundle(map, module.id);
    const copy = async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(bundle.files.map((file) => `@${file}`).join('\n'));
        setCopied(true);
      } catch {
        setCopied(false);
      }
    };
    return (
      <aside className="context-details" data-testid="context-details">
        <header>
          <span className="chip">модуль</span> <b className="mono">{module.id}</b>
          <span className="spacer" />
          {close}
        </header>
        {module.description !== null && <p>{module.description}</p>}
        <div className="ctx-files">
          <FileButton path={module.hasIndex ? module.indexPath : null} label="index.md" />
          <FileButton path={module.contextPath} label="context.md" />
        </div>
        <dl className="ctx-kv">
          <dt>Домены</dt>
          <dd>
            <Chips kind="domain" ids={module.domains} map={map} onSelect={onSelect} />
          </dd>
          <dt>Зависит от</dt>
          <dd>
            <Chips kind="module" ids={module.dependsOn} map={map} onSelect={onSelect} />
          </dd>
          <dt>Зависят от него</dt>
          <dd>
            <Chips kind="module" ids={module.dependents} map={map} onSelect={onSelect} />
          </dd>
          <dt>ADR</dt>
          <dd>
            <Chips kind="adr" ids={module.adrs} map={map} onSelect={onSelect} />
          </dd>
          <dt>Код</dt>
          <dd>
            {module.codePaths.length === 0 ? (
              <span className="muted">—</span>
            ) : (
              <ul className="ctx-code">
                {module.codePaths.map((code) => (
                  <li key={code.path} className={code.exists ? undefined : 'missing'}>
                    <span className="mono">{code.path}</span>
                    {!code.exists && <span className="chip warn">не найден</span>}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
        <div className="ctx-bundle" data-testid="context-bundle">
          <p className="pane-title">
            Контекст для работы над модулем <span className="count">{bundle.files.length}</span>
          </p>
          <p className="muted">
            Общий контекст, модуль и его зависимости по depends_on ({bundle.modules.join(' → ')}), спеки их доменов и ADR.
          </p>
          <ol>
            {bundle.files.map((file) => (
              <li key={file} className="mono">
                {inVsCode() ? (
                  <button type="button" className="linkish" onClick={() => openInEditor(file)}>
                    {file}
                  </button>
                ) : (
                  file
                )}
              </li>
            ))}
          </ol>
          <button type="button" className="btn" onClick={() => void copy()} data-testid="context-copy">
            {copied ? 'Скопировано' : 'Копировать пути (@файл)'}
          </button>
        </div>
      </aside>
    );
  }

  if (kind === 'domain') {
    const domain = map.domains.find((item) => item.id === id);
    if (domain === undefined) return null;
    return (
      <aside className="context-details" data-testid="context-details">
        <header>
          <span className="chip">домен</span> <b className="mono">{domain.id}</b>
          <span className="spacer" />
          {close}
        </header>
        <div className="ctx-files">
          <FileButton path={domain.specPath} label="spec.md" />
        </div>
        <dl className="ctx-kv">
          <dt>Модули</dt>
          <dd>
            <Chips kind="module" ids={domain.modules} map={map} onSelect={onSelect} />
          </dd>
          <dt>ADR</dt>
          <dd>
            <Chips kind="adr" ids={domain.adrs} map={map} onSelect={onSelect} />
          </dd>
        </dl>
        {domain.modules.length === 0 && domain.specPath !== null && (
          <p className="notice warn">Домен не относится ни к одному модулю.</p>
        )}
      </aside>
    );
  }

  const adr = map.adrs.find((item) => item.path === id);
  if (adr === undefined) return null;
  return (
    <aside className="context-details" data-testid="context-details">
      <header>
        <span className="chip">ADR</span> <b>{adr.title}</b>
        <span className="spacer" />
        {close}
      </header>
      <div className="ctx-files">
        <FileButton path={adr.path} label={`${adr.id}.md`} />
        {adr.status !== null && <span className="chip">{adr.status}</span>}
      </div>
      <dl className="ctx-kv">
        <dt>Модули</dt>
        <dd>
          <Chips kind="module" ids={adr.modules} map={map} onSelect={onSelect} />
        </dd>
        <dt>Домены</dt>
        <dd>
          <Chips kind="domain" ids={adr.domains} map={map} onSelect={onSelect} />
        </dd>
      </dl>
    </aside>
  );
}

