import { useCallback, useEffect, useRef, useState } from 'react';
import { Detail } from './components/Detail.js';
import { Board } from './components/Board.js';
import { CapabilityMapView } from './components/CapabilityMapView.js';
import { Deltas } from './components/Deltas.js';
import { EditorPane } from './components/EditorPane.js';
import { SpecView } from './components/SpecView.js';
import { Search } from './components/Search.js';
import { Tree, type Selection } from './components/Tree.js';
import { eventsUrl, fetchWorkspace, type WorkspaceResponse } from './lib/api.js';
import {
  type ConnectionState,
  WorkspaceConnection,
  eventSourceTransport,
} from './lib/connection.js';

type Section = 'explorer' | 'deltas' | 'board' | 'search';

const SECTION_TITLE: Record<Section, string> = {
  explorer: 'Обозреватель',
  deltas: 'Дельты',
  board: 'Доска',
  search: 'Поиск',
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'подключение…',
  connected: 'наблюдение за файлами',
  disconnected: 'нет связи с сервером',
};

export function App() {
  const [section, setSection] = useState<Section>('explorer');
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
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
      connect: () => eventSourceTransport(eventsUrl(), ['connected', 'workspace-changed']),
      onState: setConnection,
      onEvent: (event) => {
        if (event.type === 'workspace-changed') void reload();
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

  return (
    <div className="app">
      <nav className="rail" aria-label="Разделы">
        <button
          type="button"
          aria-current={section === 'explorer'}
          aria-label="Обозреватель"
          title="Обозреватель"
          onClick={() => setSection('explorer')}
        >
          Об
        </button>
        <button
          type="button"
          aria-current={section === 'deltas'}
          aria-label="Дельты"
          title="Дельты"
          onClick={() => setSection('deltas')}
        >
          Дл
        </button>
        <button
          type="button"
          aria-current={section === 'board'}
          aria-label="Доска"
          title="Доска"
          onClick={() => setSection('board')}
        >
          Дс
        </button>
        <button
          type="button"
          aria-current={section === 'search'}
          aria-label="Поиск"
          title="Поиск"
          onClick={() => setSection('search')}
        >
          По
        </button>
      </nav>

      <div className="stage">
        <header className="toolbar">
          <h1>{SECTION_TITLE[section]}</h1>
          <span className="crumbs">
            {workspace?.state === 'ready' ? workspace.root : 'рабочее пространство не определено'}
          </span>
        </header>

        <div className="panes">
          <div className="pane">
            <p className="pane-title">Рабочее пространство</p>
            {tree === null ? (
              <p className="empty">Загрузка…</p>
            ) : (
              <Tree tree={tree} selection={selection} onSelect={setSelection} />
            )}
          </div>

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

            {section === 'search' ? (
              <Search />
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
