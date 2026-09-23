import { useCallback, useEffect, useRef, useState } from 'react';
import { Agent } from './components/Agent.js';
import { Detail } from './components/Detail.js';
import { Board } from './components/Board.js';
import { CapabilityMapView } from './components/CapabilityMapView.js';
import { Deltas } from './components/Deltas.js';
import { EditorPane } from './components/EditorPane.js';
import { Metrics } from './components/Metrics.js';
import { Processes } from './components/Processes.js';
import { Settings } from './components/Settings.js';
import { AGENT_EVENT_TYPES, publishAgentEvent } from './lib/agentFeed.js';
import { SpecView } from './components/SpecView.js';
import { Search } from './components/Search.js';
import { Tree, type Selection } from './components/Tree.js';
import { type CliInfo, eventsUrl, fetchHealth, fetchWorkspace, type WorkspaceResponse } from './lib/api.js';
import { desktopBridge } from './lib/desktop.js';
import { ModuleFilter } from './components/ModuleFilter.js';
import { ModuleMetricsView } from './components/ModuleMetricsView.js';
import { Modules } from './components/Modules.js';
import { ModuleSpecView, parseRequirementHash } from './components/ModuleSpecView.js';
import {
  type ConnectionState,
  WorkspaceConnection,
  eventSourceTransport,
} from './lib/connection.js';

type Section =
  | 'explorer'
  | 'deltas'
  | 'board'
  | 'metrics'
  | 'modules'
  | 'agent'
  | 'processes'
  | 'search'
  | 'settings';

const SECTION_TITLE: Record<Section, string> = {
  explorer: 'Обозреватель',
  deltas: 'Дельты',
  board: 'Доска',
  metrics: 'Метрики',
  modules: 'Модули',
  agent: 'Агент',
  processes: 'Процессы',
  search: 'Поиск',
  settings: 'Настройки',
};

/** Разделы на панели слева — в порядке сочетаний Ctrl+1…9 десктопного приложения. */
const RAIL: readonly { readonly id: Section; readonly glyph: string }[] = [
  { id: 'explorer', glyph: 'Об' },
  { id: 'deltas', glyph: 'Дл' },
  { id: 'board', glyph: 'Дс' },
  { id: 'metrics', glyph: 'Мт' },
  { id: 'modules', glyph: 'Мд' },
  { id: 'agent', glyph: 'Аг' },
  { id: 'processes', glyph: 'Пр' },
  { id: 'search', glyph: 'По' },
  { id: 'settings', glyph: 'Нс' },
];

/** Разделы, где действует фильтр по модулям. */
const FILTERED: ReadonlySet<Section> = new Set(['board', 'search', 'metrics']);

/** Разделы на всю ширину — без дерева слева. */
const SINGLE_PANE: ReadonlySet<Section> = new Set(['processes', 'settings', 'modules']);

const CLI_SOURCE: Record<CliInfo['source'], string> = {
  project: 'из репозитория',
  path: 'из PATH',
  bundled: 'встроенный',
};

function isSection(value: string): value is Section {
  return Object.hasOwn(SECTION_TITLE, value);
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'подключение…',
  connected: 'наблюдение за файлами',
  disconnected: 'нет связи с сервером',
};

export function App() {
  const [section, setSection] = useState<Section>('explorer');
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  // Адрес требования (`#spec=…&req=…`) открывает спеку сразу.
  const [selection, setSelection] = useState<Selection | null>(() => {
    const target = parseRequirementHash(window.location.hash);
    return target === null ? null : { kind: 'capability', id: target.capability, anchor: target.anchor };
  });
  const [codeRevision, setCodeRevision] = useState(0);

  // Адрес требования, вставленный в уже открытое окно, тоже открывает спеку.
  useEffect(() => {
    const onHash = (): void => {
      const target = parseRequirementHash(window.location.hash);
      if (target === null) return;
      setSelection({ kind: 'capability', id: target.capability, anchor: target.anchor });
      setSection('explorer');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  // Счётчик изменений на диске — разделам, которые читают данные сами.
  const [revision, setRevision] = useState(0);
  // Пункт плана, с которым открыта панель агента из метрик.
  const [agentItem, setAgentItem] = useState<string | null>(null);
  const connectionRef = useRef<WorkspaceConnection | null>(null);
  const [cli, setCli] = useState<CliInfo | null>(null);
  // Фильтр по модулям общий для доски, поиска и метрик и помнится между
  // запусками для этого репозитория.
  const [moduleFilter, setModuleFilterState] = useState<readonly string[]>([]);

  // Меню «Вид» десктопного приложения переключает разделы.
  useEffect(
    () =>
      desktopBridge()?.onSection((next) => {
        if (!isSection(next)) return;
        if (next === 'agent') setAgentItem(null);
        setSection(next);
      }),
    [],
  );

  useEffect(() => {
    fetchHealth()
      .then((health) => setCli(health.cli))
      .catch(() => setCli(null));
  }, []);

  const reload = useCallback(async () => {
    try {
      setWorkspace(await fetchWorkspace());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void reload();

    const instance = new WorkspaceConnection({
      connect: () =>
        eventSourceTransport(eventsUrl(), ['connected', 'workspace-changed', 'code-index-changed', ...AGENT_EVENT_TYPES]),
      onState: setConnection,
      onEvent: (event) => {
        if (event.type === 'code-index-changed') setCodeRevision((current) => current + 1);
        if (event.type === 'workspace-changed') {
          setRevision((current) => current + 1);
          void reload();
        }
        if (event.type.startsWith('agent-')) {
          publishAgentEvent(event);
          // Агент мог изменить файлы: дерево и статусы перечитываются.
          if (event.type === 'agent-finished') void reload();
        }
      },
      // После разрыва часть событий потеряна безвозвратно, поэтому состояние
      // перечитывается целиком.
      onResync: () => void reload(),
    });
    connectionRef.current = instance;
    instance.start();

    return () => {
      instance.stop();
      connectionRef.current = null;
    };
  }, [reload]);

  const tree = workspace?.state === 'ready' ? workspace.tree : null;
  const modulesView = workspace?.state === 'ready' ? workspace.modules : null;
  const moduleIds = modulesView?.map.modules.map((module) => module.id) ?? [];
  const activeFilter = moduleFilter.filter((id) => moduleIds.includes(id));
  const filterKey = workspace?.state === 'ready' ? `openspec-ide:module-filter:${workspace.root}` : null;

  useEffect(() => {
    if (filterKey === null) return;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(filterKey) ?? '[]');
      if (Array.isArray(saved)) setModuleFilterState(saved.filter((item): item is string => typeof item === 'string'));
    } catch {
      // Хранилище недоступно — фильтр живёт до перезагрузки.
    }
  }, [filterKey]);

  const setModuleFilter = useCallback(
    (next: readonly string[]) => {
      setModuleFilterState(next);
      if (filterKey === null) return;
      try {
        localStorage.setItem(filterKey, JSON.stringify(next));
      } catch {
        // см. выше
      }
    },
    [filterKey],
  );

  const selectedChange =
    selection?.kind === 'change' ? selection.id : selection?.kind === 'artifact' ? (selection.parent ?? null) : null;

  return (
    <div className="app">
      <nav className="rail" aria-label="Разделы">
        {RAIL.map((entry) => (
          <button
            type="button"
            key={entry.id}
            aria-current={section === entry.id}
            aria-label={SECTION_TITLE[entry.id]}
            title={SECTION_TITLE[entry.id]}
            onClick={() => {
              if (entry.id === 'agent') setAgentItem(null);
              setSection(entry.id);
            }}
          >
            {entry.glyph}
          </button>
        ))}
      </nav>

      <div className="stage">
        <header className="toolbar">
          <h1>{SECTION_TITLE[section]}</h1>
          {FILTERED.has(section) && modulesView !== null && (
            <ModuleFilter modules={modulesView.map.modules} value={activeFilter} onChange={setModuleFilter} />
          )}
          <span className="crumbs">
            {workspace?.state === 'ready' ? workspace.root : 'рабочее пространство не определено'}
          </span>
        </header>

        <div className={SINGLE_PANE.has(section) ? 'panes single' : 'panes'}>
          {!SINGLE_PANE.has(section) && (
            <div className="pane">
              <p className="pane-title">Рабочее пространство</p>
              {tree === null ? (
                <p className="empty">Загрузка…</p>
              ) : (
                <Tree tree={tree} modules={modulesView} selection={selection} onSelect={setSelection} />
              )}
            </div>
          )}

          <div className="pane">
            {loadError !== null && (
              <p className="notice error" role="alert">
                {loadError}
              </p>
            )}

            {workspace?.state === 'not-initialized' && (
              <p className="notice info" data-testid="not-initialized">
                {workspace.message} Выполните <code>{workspace.hint}</code>.
              </p>
            )}

            {workspace?.state === 'cli-missing' && (
              <p className="notice error" data-testid="cli-missing">
                {workspace.notice.title}. Установите <code>{workspace.notice.tool}</code>:{' '}
                <code>{workspace.notice.install}</code>.
              </p>
            )}

            {workspace?.state === 'ready' &&
              workspace.errors.map((error) => (
                <p className="notice error" key={error}>
                  {error}
                </p>
              ))}

            {section === 'settings' ? (
              workspace?.state === 'ready' ? (
                <Settings />
              ) : null
            ) : section === 'agent' ? (
              selection?.kind === 'change' || selection?.kind === 'artifact' ? (
                <Agent
                  key={selection.parent ?? selection.id}
                  change={selection.parent ?? selection.id}
                  initialItem={agentItem}
                />
              ) : (
                <p className="empty">Выберите изменение в дереве слева, чтобы запустить агента по его артефакту или пункту плана.</p>
              )
            ) : section === 'processes' ? (
              workspace?.state === 'ready' ? (
                <Processes revision={revision} onChanged={() => void reload()} />
              ) : null
            ) : section === 'modules' ? (
              tree !== null && modulesView !== null ? (
                <Modules
                  view={modulesView}
                  tree={tree}
                  focusChange={selectedChange}
                  revision={revision + codeRevision}
                  onOpenChange={(change) => {
                    setSelection({ kind: 'change', id: change });
                    setSection('explorer');
                  }}
                  onOpenSpec={(capability) => {
                    setSelection({ kind: 'capability', id: capability });
                    setSection('explorer');
                  }}
                  onChanged={() => void reload()}
                />
              ) : null
            ) : section === 'search' ? (
              <Search moduleFilter={activeFilter} />
            ) : section === 'metrics' ? (
              activeFilter.length > 0 && selectedChange === null ? (
                <ModuleMetricsView
                  modules={activeFilter}
                  revision={revision}
                  onOpenChange={(change) => setSelection({ kind: 'change', id: change })}
                />
              ) : selection?.kind === 'change' || selection?.kind === 'artifact' ? (
                <Metrics
                  change={selection.parent ?? selection.id}
                  onAgent={(key) => {
                    setAgentItem(key);
                    setSection('agent');
                  }}
                />
              ) : (
                <p className="empty">
                  Выберите изменение в дереве слева, чтобы увидеть его метрики, или модули в фильтре — для сводки по ним.
                </p>
              )
            ) : section === 'board' ? (
              <Board
                schemas={tree?.schemas ?? []}
                modules={modulesView?.map.modules ?? []}
                moduleFilter={activeFilter}
                revision={revision}
                onChanged={() => void reload()}
              />
            ) : section === 'deltas' ? (
              selection?.kind === 'change' || selection?.kind === 'artifact' ? (
                <Deltas change={selection.parent ?? selection.id} modules={modulesView} />
              ) : selection?.kind === 'capability' ? (
                <SpecView capability={selection.id} />
              ) : (
                <>
                  <p className="pane-title">Карта связей</p>
                  <CapabilityMapView />
                </>
              )
            ) : tree === null ? null : selection?.kind === 'artifact' ? (
              (() => {
                const change = tree.changes.find((item) => item.name === selection.parent);
                if (change === undefined) return <p className="empty">Изменение не найдено.</p>;
                const artifact = change.artifacts.find((item) => item.id === selection.id);
                const file = selection.file ?? artifact?.files[0] ?? null;
                return (
                  <EditorPane
                    key={`${change.name}/${selection.id}/${file ?? ''}`}
                    change={change}
                    artifactId={selection.id}
                    file={file}
                    revealLine={null}
                  />
                );
              })()
            ) : selection?.kind === 'capability' ? (
              <ModuleSpecView
                key={selection.id}
                capability={selection.id}
                initialAnchor={selection.anchor ?? null}
                revision={revision + codeRevision}
                onOpenChange={(change) => setSelection({ kind: 'change', id: change })}
                onOpenSpec={(capability, anchor) => setSelection({ kind: 'capability', id: capability, anchor })}
                onOpenSettings={() => setSection('settings')}
              />
            ) : (
              <Detail
                tree={tree}
                selection={selection}
                modules={modulesView}
                onSelect={setSelection}
                onShowImpact={() => setSection('modules')}
              />
            )}
          </div>
        </div>

        <footer className="statusbar">
          <span>
            корень <b>{workspace?.state === 'ready' ? workspace.root : '—'}</b>
          </span>
          {tree !== null && (
            <span>
              изменений <b>{tree.changes.length}</b> · спеков <b>{tree.capabilities.length}</b> ·
              процессов <b>{tree.schemas.length}</b>
            </span>
          )}
          <span className="spacer" />
          {cli !== null && (
            <span data-testid="cli-source" title={cli.bin}>
              CLI openspec <b>{cli.version ?? '?'}</b> · {CLI_SOURCE[cli.source]}
            </span>
          )}
          <span
            className={connection === 'connected' ? 'ok' : connection === 'connecting' ? 'warn' : 'err'}
            data-testid="connection-state"
            data-state={connection}
          >
            ● {CONNECTION_LABEL[connection]}
          </span>
        </footer>
      </div>
    </div>
  );
}
