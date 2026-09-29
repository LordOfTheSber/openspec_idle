import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type ContextBundle,
  type ContextIssue,
  type ContextMap as ContextMapModel,
  contextBundle,
} from '@openspec-ide/core';
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
import { bundleKeys, parseNodeKey, selectionOf, togglePicked } from '../lib/contextSelection.js';
import { plural } from '../lib/format.js';
import { inVsCode, openInEditor } from '../lib/host.js';
import { readListPref, readPref, writeListPref, writePref } from '../lib/prefs.js';

type View = 'graph' | 'matrix';
const VIEWS: readonly View[] = ['graph', 'matrix'];
const SWITCH: readonly ('on' | 'off')[] = ['on', 'off'];

/** Щелчок с Ctrl, ⌘ или Shift добавляет узел в набор и без режима набора. */
type Activate = (key: string | null, toggle?: boolean) => void;

function withModifier(event: { readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}

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
  // Набор контекста: узлы в порядке выбора. Переживает переключение разделов.
  const [picked, setPicked] = useState<string[]>(() => readListPref('context-picked'));
  const [picking, setPicking] = useState(() => picked.length > 0);
  const [withDeps, setWithDeps] = useState(() => readPref('context-deps', SWITCH, 'on') === 'on');
  const [withModuleDomains, setWithModuleDomains] = useState(() => readPref('context-module-domains', SWITCH, 'on') === 'on');

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

  const updatePicked = useCallback((next: string[]) => {
    setPicked(next);
    writeListPref('context-picked', next);
  }, []);

  // Из набора уходят узлы, которых больше нет на карте.
  useEffect(() => {
    if (layout === null) return;
    const keys = new Set(layout.nodes.map((node) => node.key));
    if (picked.some((key) => !keys.has(key))) updatePicked(picked.filter((key) => keys.has(key)));
  }, [layout, picked, updatePicked]);

  const bundle = useMemo(
    () =>
      map === null || !picking
        ? null
        : contextBundle(map, selectionOf(picked), { dependencies: withDeps, moduleDomains: withModuleDomains }),
    [map, picking, picked, withDeps, withModuleDomains],
  );
  const included = bundle !== null && picked.length > 0 ? bundleKeys(bundle) : null;
  const pickedSet = useMemo(() => new Set(picking ? picked : []), [picking, picked]);

  const activate: Activate = (key, toggle = false) => {
    if (key === null) {
      if (!picking) setSelected(null);
      return;
    }
    if (picking || toggle) {
      updatePicked(togglePicked(picked, key));
      setPicking(true);
      return;
    }
    setSelected(key);
  };

  const pick = (key: string): void => {
    if (!picked.includes(key)) updatePicked([...picked, key]);
    setPicking(true);
  };

  const showOnMap = (key: string): void => {
    setPicking(false);
    setSelected(key);
  };

  function switchOption(key: string, value: boolean, set: (value: boolean) => void): void {
    set(value);
    writePref(key, value ? 'on' : 'off');
  }

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
        <button
          type="button"
          className={picking ? 'btn primary' : 'btn'}
          aria-pressed={picking}
          onClick={() => setPicking(!picking)}
          title="Собрать контекст из нескольких модулей, доменов и ADR щелчками по ним. Ctrl+щелчок по узлу работает и без режима."
          data-testid="context-pick-mode"
        >
          Набор контекста{picked.length > 0 && <> · {picked.length}</>}
        </button>
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
          <IssueList issues={map.issues} onSelect={showOnMap} />
        </details>
      )}

      {map.configured || map.domains.length > 0 ? (
        <div className="context-body">
          {view === 'graph' ? (
            <Graph
              layout={layout}
              selected={picking ? null : selected}
              hovered={hovered}
              picked={pickedSet}
              included={included}
              picking={picking}
              onActivate={activate}
              onHover={setHovered}
            />
          ) : (
            <Matrix
              map={map}
              selected={picking ? null : selected}
              picked={pickedSet}
              included={included}
              onActivate={activate}
            />
          )}
          {picking && bundle !== null ? (
            <SelectionPanel
              map={map}
              picked={picked}
              bundle={bundle}
              withDeps={withDeps}
              withModuleDomains={withModuleDomains}
              onDeps={(value) => switchOption('context-deps', value, setWithDeps)}
              onModuleDomains={(value) => switchOption('context-module-domains', value, setWithModuleDomains)}
              onRemove={(key) => updatePicked(togglePicked(picked, key))}
              onClear={() => updatePicked([])}
              onClose={() => setPicking(false)}
            />
          ) : (
            selected !== null && (
              <Details map={map} selected={selected} picked={picked} onSelect={setSelected} onPick={pick} />
            )
          )}
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
  picked,
  included,
  picking,
  onActivate,
  onHover,
}: {
  readonly layout: ContextLayout;
  readonly selected: string | null;
  readonly hovered: string | null;
  /** Узлы, выбранные в набор. */
  readonly picked: ReadonlySet<string>;
  /** Все узлы набора, включая добавленные по связям; `null` — набора нет. */
  readonly included: ReadonlySet<string> | null;
  readonly picking: boolean;
  readonly onActivate: Activate;
  readonly onHover: (key: string | null) => void;
}) {
  // Наведение показывает соседей узла; без него в режиме набора подсвечен набор.
  const focus = hovered ?? selected;
  const near = focus === null ? included : neighbourhood(layout, focus);
  const edgeActive = (from: string, to: string): boolean =>
    focus !== null ? from === focus || to === focus : included !== null && included.has(from) && included.has(to);
  const highlighting = focus !== null || included !== null;

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
        onClick={() => onActivate(null)}
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
                highlighting && !edgeActive(edge.from, edge.to) ? 'faded' : '',
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
              picked={picked.has(node.key)}
              faded={near !== null && !near.has(node.key)}
              onActivate={onActivate}
              onHover={onHover}
            />
          ))}
        </g>
      </svg>

      <p className="context-legend">
        <span className="swatch module" /> модуль <span className="swatch domain" /> домен <span className="swatch adr" /> ADR{' '}
        <span className="line depends" /> depends_on <span className="line unresolved" /> не найдено
        {picking ? (
          <span className="context-legend-hint">· щелчок добавляет узел в набор или убирает его</span>
        ) : (
          <span className="context-legend-hint">· Ctrl+щелчок — в набор контекста</span>
        )}
      </p>
    </div>
  );
}

function GraphNode({
  node,
  selected,
  picked,
  faded,
  onActivate,
  onHover,
}: {
  readonly node: LayoutNode;
  readonly selected: boolean;
  readonly picked: boolean;
  readonly faded: boolean;
  readonly onActivate: Activate;
  readonly onHover: (key: string | null) => void;
}) {
  const classes = [
    'ctx-node',
    node.kind,
    node.resolved ? '' : 'unresolved',
    selected ? 'selected' : '',
    picked ? 'picked' : '',
    faded ? 'faded' : '',
  ]
    .filter((name) => name !== '')
    .join(' ');
  return (
    <g
      className={classes}
      transform={`translate(${node.x},${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${KIND_LABEL[node.kind]} ${node.label}`}
      aria-pressed={selected || picked}
      data-testid={`ctx-node-${node.key}`}
      data-picked={picked ? 'true' : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onActivate(node.key, withModifier(event));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(node.key, withModifier(event));
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
        {picked ? ' — в наборе' : ''}
      </title>
      <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} />
      <text x={10} y={NODE_HEIGHT / 2 + 4}>
        {picked ? `✓ ${short(node.label)}` : short(node.label)}
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
  picked,
  included,
  onActivate,
}: {
  readonly map: ContextMapModel;
  readonly selected: string | null;
  readonly picked: ReadonlySet<string>;
  readonly included: ReadonlySet<string> | null;
  readonly onActivate: Activate;
}) {
  const marks = (key: string, unresolved = false): string =>
    [
      unresolved ? 'unresolved' : '',
      selected === key ? 'selected' : '',
      picked.has(key) ? 'picked' : included?.has(key) === true ? 'included' : '',
    ]
      .filter((name) => name !== '')
      .join(' ');
  const label = (key: string, text: string): string => (picked.has(key) ? `✓ ${text}` : text);
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
                className={marks(nodeKey('domain', domain.id), domain.specPath === null) || undefined}
              >
                <button
                  type="button"
                  className="linkish"
                  onClick={(event) => onActivate(nodeKey('domain', domain.id), withModifier(event))}
                  title={domain.id}
                  data-testid={`ctx-col-${domain.id}`}
                >
                  <span className="vertical">{label(nodeKey('domain', domain.id), domain.id)}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {map.modules.map((module) => (
            <tr key={module.id} className={marks(nodeKey('module', module.id)) || undefined}>
              <th scope="row">
                <button
                  type="button"
                  className="linkish"
                  onClick={(event) => onActivate(nodeKey('module', module.id), withModifier(event))}
                  data-testid={`ctx-row-${module.id}`}
                >
                  {label(nodeKey('module', module.id), module.id)}
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

/** Упорядоченный список файлов контекста с копированием путей строками `@путь`. */
function BundleFiles({ title, note, files }: { readonly title: string; readonly note: string; readonly files: readonly string[] }) {
  const [copied, setCopied] = useState(false);
  const joined = files.join('\n');
  useEffect(() => setCopied(false), [joined]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(files.map((file) => `@${file}`).join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="ctx-bundle" data-testid="context-bundle">
      <p className="pane-title">
        {title} <span className="count">{files.length}</span>
      </p>
      <p className="muted">{note}</p>
      {files.length > 0 && (
        <ol>
          {files.map((file) => (
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
      )}
      <button type="button" className="btn" onClick={() => void copy()} disabled={files.length === 0} data-testid="context-copy">
        {copied ? 'Скопировано' : 'Копировать пути (@файл)'}
      </button>
    </div>
  );
}

const PICKED_ORDER: readonly ContextNodeKind[] = ['module', 'domain', 'adr'];

/** Набор контекста из нескольких модулей, доменов и ADR. */
function SelectionPanel({
  map,
  picked,
  bundle,
  withDeps,
  withModuleDomains,
  onDeps,
  onModuleDomains,
  onRemove,
  onClear,
  onClose,
}: {
  readonly map: ContextMapModel;
  readonly picked: readonly string[];
  readonly bundle: ContextBundle;
  readonly withDeps: boolean;
  readonly withModuleDomains: boolean;
  readonly onDeps: (value: boolean) => void;
  readonly onModuleDomains: (value: boolean) => void;
  readonly onRemove: (key: string) => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}) {
  const nodes = picked
    .map((key) => ({ key, node: parseNodeKey(key) }))
    .filter((item): item is { key: string; node: NonNullable<ReturnType<typeof parseNodeKey>> } => item.node !== null)
    .sort((a, b) => PICKED_ORDER.indexOf(a.node.kind) - PICKED_ORDER.indexOf(b.node.kind));
  const label = (kind: ContextNodeKind, id: string): string =>
    kind === 'adr' ? (map.adrs.find((adr) => adr.path === id)?.id ?? id) : id;
  const parts = [
    bundle.modules.length > 0 ? `модули: ${bundle.modules.join(', ')}` : '',
    bundle.domains.length > 0 ? plural(bundle.domains.length, ['спека', 'спеки', 'спек']) : '',
    bundle.adrs.length > 0 ? `${bundle.adrs.length} ADR` : '',
  ].filter((part) => part !== '');

  return (
    <aside className="context-details context-selection" data-testid="context-selection">
      <header>
        <span className="chip">набор</span> <b>Контекст из выбранного</b>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={onClose} aria-label="Закрыть набор">
          ✕
        </button>
      </header>
      {nodes.length === 0 ? (
        <p className="muted" data-testid="context-selection-empty">
          Щёлкайте по модулям, доменам и ADR на графе или по строкам и столбцам матрицы — они попадут в набор. Повторный
          щелчок убирает узел из набора.
        </p>
      ) : (
        <>
          <span className="ctx-chips">
            {nodes.map(({ key, node }) => (
              <button
                key={key}
                type="button"
                className={`ctx-chip ${node.kind} removable`}
                onClick={() => onRemove(key)}
                title={`Убрать ${node.id} из набора`}
                data-testid={`context-picked-${key}`}
              >
                {label(node.kind, node.id)} ✕
              </button>
            ))}
          </span>
          <div className="ctx-options">
            <label>
              <input type="checkbox" checked={withDeps} onChange={(event) => onDeps(event.target.checked)} data-testid="context-opt-deps" />{' '}
              зависимости модулей по depends_on
            </label>
            <label>
              <input
                type="checkbox"
                checked={withModuleDomains}
                onChange={(event) => onModuleDomains(event.target.checked)}
                data-testid="context-opt-module-domains"
              />{' '}
              спеки доменов модулей
            </label>
          </div>
          <BundleFiles
            title="Контекст для работы"
            note={`Общий контекст${parts.length > 0 ? `, ${parts.join(', ')}` : ''}.`}
            files={bundle.files}
          />
          <button type="button" className="btn small ctx-clear" onClick={onClear} data-testid="context-clear">
            Очистить набор
          </button>
        </>
      )}
    </aside>
  );
}

function Details({
  map,
  selected,
  picked,
  onSelect,
  onPick,
}: {
  readonly map: ContextMapModel;
  readonly selected: string;
  readonly picked: readonly string[];
  readonly onSelect: (key: string | null) => void;
  readonly onPick: (key: string) => void;
}) {
  const separator = selected.indexOf(':');
  const kind = selected.slice(0, separator) as ContextNodeKind;
  const id = selected.slice(separator + 1);
  const inSet = picked.includes(selected);

  const close = (
    <button type="button" className="btn small" onClick={() => onSelect(null)} aria-label="Закрыть">
      ✕
    </button>
  );
  const add = (
    <button
      type="button"
      className="btn small"
      onClick={() => onPick(selected)}
      title="Добавить в набор контекста вместе с другими модулями и доменами"
      data-testid="context-pick"
    >
      {inSet ? '✓ В наборе' : '+ В набор'}
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
    const bundle = contextBundle(map, { modules: [module.id] });
    return (
      <aside className="context-details" data-testid="context-details">
        <header>
          <span className="chip">модуль</span> <b className="mono">{module.id}</b>
          <span className="spacer" />
          {add}
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
        <BundleFiles
          title="Контекст для работы над модулем"
          note={`Общий контекст, модуль и его зависимости по depends_on (${bundle.modules.join(' → ')}), спеки их доменов и ADR.`}
          files={bundle.files}
        />
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
          {add}
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
        {add}
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

