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
import { eventsUrl, fetchWorkspace, type WorkspaceResponse } from './lib/api.js';
import {
  type ConnectionState,
  WorkspaceConnection,
  eventSourceTransport,
} from './lib/connection.js';
import { messageStreamTransport, onNavigate, openInEditor, vscodeHost } from './lib/host.js';

type Section = 'explorer' | 'deltas' | 'board' | 'metrics' | 'agent' | 'settings' | 'processes' | 'search';

const SECTION_TITLE: Record<Section, string> = {
  explorer: 'Обозреватель',
  deltas: 'Дельты',
  board: 'Доска',
  metrics: 'Метрики',
  agent: 'Агент',
  settings: 'Настройки',
  processes: 'Процессы',
  search: 'Поиск',
};

const RAIL: readonly { section: Section; short: string }[] = [
  { section: 'explorer', short: 'Об' },
  { section: 'deltas', short: 'Дл' },
  { section: 'board', short: 'Дс' },
  { section: 'metrics', short: 'Мт' },
  { section: 'agent', short: 'Аг' },
  { section: 'settings', short: 'Нс' },
  { section: 'processes', short: 'Пр' },
  { section: 'search', short: 'По' },
];

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'подключение…',
  connected: 'наблюдение за файлами',
  disconnected: 'нет связи с сервером',
};

export function App() {
  // В панели VS Code артефакты редактируются в редакторе VS Code, поэтому
  // раздела «Обозреватель» со встроенным редактором там нет.
  const host = vscodeHost();
  const [section, setSection] = useState<Section>(host === null ? 'explorer' : 'board');
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  // Счётчик изменений на диске — разделам, которые читают данные сами.
  const [revision, setRevision] = useState(0);
  // Пункт плана, с которым открыта панель агента из метрик.
  const [agentItem, setAgentItem] = useState<string | null>(null);
  const connectionRef = useRef<WorkspaceConnection | null>(null);

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
        host === null
          ? eventSourceTransport(eventsUrl(), ['connected', 'workspace-changed', ...AGENT_EVENT_TYPES])
          : messageStreamTransport(host),
      onState: setConnection,
      onEvent: (event) => {
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
  }, [reload, host]);

  // Команды палитры и контекстное меню дерева VS Code переключают раздел и
  // выбор в уже открытой панели.
  useEffect(() => {
    if (host === null) return;
    const unsubscribe = onNavigate((next, nextSelection) => {
      if (next !== 'agent') setAgentItem(null);
      setSection(next);
      if (nextSelection !== null) setSelection(nextSelection);
    });
    host.post({ kind: 'ready' });
    return unsubscribe;
  }, [host]);

  const tree = workspace?.state === 'ready' ? workspace.tree : null;

  const select = (next: Selection): void => {
    setSelection(next);
    if (host === null || next.kind !== 'artifact' || next.parent === undefined) return;
    const change = tree?.changes.find((item) => item.name === next.parent);
    const file = change?.artifacts.find((item) => item.id === next.id)?.files[0];
    if (file !== undefined) openInEditor(`openspec/changes/${next.parent}/${file}`);
  };

  return (
    <div className="app">
      <nav className="rail" aria-label="Разделы">
        {RAIL.filter((entry) => host === null || entry.section !== 'explorer').map((entry) => (
          <button
            key={entry.section}
            type="button"
            aria-current={section === entry.section}
            aria-label={SECTION_TITLE[entry.section]}
            title={SECTION_TITLE[entry.section]}
            onClick={() => {
              if (entry.section === 'agent') setAgentItem(null);
              setSection(entry.section);
            }}
          >
            {entry.short}
          </button>
        ))}
      </nav>

      <div className="stage">
        <header className="toolbar">
          <h1>{SECTION_TITLE[section]}</h1>
          <span className="crumbs">
            {workspace?.state === 'ready' ? workspace.root : 'рабочее пространство не определено'}
          </span>
        </header>

        <div className={section === 'processes' || section === 'settings' ? 'panes single' : 'panes'}>
          {section !== 'processes' && section !== 'settings' && (
            <div className="pane">
              <p className="pane-title">Рабочее пространство</p>
              {tree === null ? (
                <p className="empty">Загрузка…</p>
              ) : (
                <Tree tree={tree} selection={selection} onSelect={select} />
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
            ) : section === 'search' ? (
              <Search />
            ) : section === 'metrics' ? (
              selection?.kind === 'change' || selection?.kind === 'artifact' ? (
                <Metrics
                  change={selection.parent ?? selection.id}
                  onAgent={(key) => {
                    setAgentItem(key);
                    setSection('agent');
                  }}
                />
              ) : (
                <p className="empty">Выберите изменение в дереве слева, чтобы увидеть его метрики.</p>
              )
            ) : section === 'board' ? (
              <Board schemas={tree?.schemas ?? []} onChanged={() => void reload()} />
            ) : section === 'deltas' ? (
              selection?.kind === 'change' || selection?.kind === 'artifact' ? (
                <Deltas change={selection.parent ?? selection.id} />
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
                return (
                  <EditorPane
                    key={`${change.name}/${selection.id}`}
                    change={change}
                    artifactId={selection.id}
                    file={artifact?.files[0] ?? null}
                    revealLine={null}
                  />
                );
              })()
            ) : (
              <Detail tree={tree} selection={selection} />
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
