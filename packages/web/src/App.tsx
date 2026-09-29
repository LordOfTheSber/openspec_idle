import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type SearchHit, isStaleBackend } from '@openspec-ide/core';
import { Detail } from './components/Detail.js';
import { Board, type BoardRequest, type BoardTarget } from './components/Board.js';
import { CapabilityMapView } from './components/CapabilityMapView.js';
import { ChangePicker, ChooseChange } from './components/ChangePicker.js';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette.js';
import { ContextMap } from './components/ContextMap.js';
import { Deltas, type DeltasTab } from './components/Deltas.js';
import { EditorPane } from './components/EditorPane.js';
import { Icon, type IconName } from './components/Icon.js';
import { Metrics } from './components/Metrics.js';
import { Processes } from './components/Processes.js';
import { SpecView } from './components/SpecView.js';
import { Structure } from './components/Structure.js';
import { Tree, type Selection } from './components/Tree.js';
import { eventsUrl, fetchHealth, fetchWorkspace, type WorkspaceResponse } from './lib/api.js';
import {
  type ConnectionState,
  WorkspaceConnection,
  eventSourceTransport,
} from './lib/connection.js';
import { messageStreamTransport, onNavigate, openInEditor, vscodeHost } from './lib/host.js';
import { ActionsTargetProvider, ToastProvider, useWidth } from './lib/ui.js';

type Section = 'explorer' | 'board' | 'deltas' | 'metrics' | 'context' | 'structure' | 'processes';

const SECTIONS: readonly { readonly id: Section; readonly title: string; readonly icon: IconName }[] = [
  { id: 'explorer', title: 'Обозреватель', icon: 'explorer' },
  { id: 'board', title: 'Доска', icon: 'board' },
  { id: 'deltas', title: 'Дельты', icon: 'diff' },
  { id: 'metrics', title: 'Метрики', icon: 'chart' },
  { id: 'context', title: 'Контекст', icon: 'context' },
  { id: 'structure', title: 'Структура', icon: 'structure' },
  { id: 'processes', title: 'Процессы', icon: 'workflow' },
];

const TITLE: Record<Section, string> = Object.fromEntries(SECTIONS.map((item) => [item.id, item.title])) as Record<
  Section,
  string
>;

/** Разделы, которые сами раскладывают страницу: колонки, панели справа. */
const FLUSH: ReadonlySet<Section> = new Set(['board', 'deltas', 'context', 'structure', 'processes']);

/** Уже этой ширины у вкладок разделов остаются только иконки. */
export const COMPACT_BELOW_PX = 720;

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Переподключение…',
  connected: 'Синхронизировано',
  disconnected: 'Нет связи',
};

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
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
  // Строка, к которой перейти во встроенном редакторе после перехода с доски.
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [palette, setPalette] = useState(false);
  const [deltasTab, setDeltasTab] = useState<DeltasTab>('deltas');
  const [boardRequest, setBoardRequest] = useState<BoardRequest | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const [appRef, width] = useWidth<HTMLDivElement>();
  const connectionRef = useRef<WorkspaceConnection | null>(null);
  // Бэкенд старше интерфейса — в VS Code так бывает до перезагрузки окна
  // после установки новой сборки.
  const [staleBackend, setStaleBackend] = useState(false);

  useEffect(() => {
    void fetchHealth()
      .then((health) => setStaleBackend(isStaleBackend(health)))
      .catch(() => undefined);
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
        host === null
          ? eventSourceTransport(eventsUrl(), ['connected', 'workspace-changed'])
          : messageStreamTransport(host),
      onState: setConnection,
      onEvent: (event) => {
        if (event.type === 'workspace-changed') {
          setRevision((current) => current + 1);
          void reload();
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
  // выбор в уже открытой панели. «Поиск» открывает палитру поверх раздела.
  useEffect(() => {
    if (host === null) return;
    const unsubscribe = onNavigate((next, nextSelection) => {
      if (nextSelection !== null) setSelection(nextSelection);
      if (next === 'search') {
        setPalette(true);
        return;
      }
      setSection(next);
    });
    host.post({ kind: 'ready' });
    return unsubscribe;
  }, [host]);

  // Ctrl+K / ⌘K — палитра поиска и команд из любого раздела.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tree = workspace?.state === 'ready' ? workspace.tree : null;
  const changes = useMemo(() => tree?.changes ?? [], [tree]);
  const selectedChange =
    selection?.kind === 'change' ? selection.id : selection?.kind === 'artifact' ? (selection.parent ?? null) : null;

  const chooseChange = (change: string): void => {
    setRevealLine(null);
    setSelection({ kind: 'change', id: change });
  };

  /** Переход с доски в раздел, показывающий один change. */
  const openForChange = (target: BoardTarget, change: string): void => {
    setSelection({ kind: 'change', id: change });
    if (target === 'trace') {
      setDeltasTab('trace');
      setSection('deltas');
      return;
    }
    if (target === 'deltas') setDeltasTab('deltas');
    setSection(target);
  };

  /**
   * Открывает артефакт change: в VS Code — файл в его редакторе, в браузере —
   * встроенный редактор (он же предложит создать отсутствующий артефакт).
   */
  const openArtifact = (change: string, artifactId: string, path: string | null): void => {
    if (host !== null) {
      if (path !== null) openInEditor(path);
      return;
    }
    setRevealLine(null);
    setSelection({ kind: 'artifact', id: artifactId, parent: change });
    setSection('explorer');
  };

  /** Открывает файл рабочего пространства на строке. */
  const openFile = (path: string, line: number | null): void => {
    if (host !== null) {
      openInEditor(path, line);
      return;
    }
    for (const change of tree?.changes ?? []) {
      const prefix = `openspec/changes/${change.name}/`;
      if (!path.startsWith(prefix)) continue;
      const artifact = change.artifacts.find((item) => item.files.includes(path.slice(prefix.length)));
      if (artifact === undefined) continue;
      setRevealLine(line);
      setSelection({ kind: 'artifact', id: artifact.id, parent: change.name });
      setSection('explorer');
      return;
    }
  };

  const openHit = (hit: SearchHit): void => {
    if (hit.kind === 'change') {
      chooseChange(hit.owner);
      setSection('board');
      setBoardRequest({ kind: 'detail', change: hit.owner, intent: 'none', nonce: Date.now() });
      return;
    }
    if (hit.kind === 'schema') {
      setSection('processes');
      return;
    }
    if (hit.file !== null && host !== null) {
      openInEditor(hit.file, hit.line);
      return;
    }
    if (hit.kind === 'capability' || (hit.file?.startsWith('openspec/specs/') ?? false)) {
      setSelection({ kind: 'capability', id: hit.owner });
      setSection('deltas');
      return;
    }
    if (hit.file !== null) openFile(hit.file, hit.line);
  };

  const select = (next: Selection): void => {
    setRevealLine(null);
    setSelection(next);
    if (host === null || next.kind !== 'artifact' || next.parent === undefined) return;
    const change = tree?.changes.find((item) => item.name === next.parent);
    const file = change?.artifacts.find((item) => item.id === next.id)?.files[0];
    if (file !== undefined) openInEditor(`openspec/changes/${next.parent}/${file}`);
  };

  const visibleSections = SECTIONS.filter((item) => host === null || item.id !== 'explorer');

  const commands: PaletteCommand[] = [
    ...visibleSections.map((item) => ({
      id: `go-${item.id}`,
      title: `Перейти: ${item.title}`,
      icon: item.icon,
      keywords: 'раздел открыть',
      run: () => setSection(item.id),
    })),
    {
      id: 'new-change',
      title: 'Создать change…',
      icon: 'plus',
      keywords: 'новое изменение',
      run: () => {
        setSection('board');
        setBoardRequest({ kind: 'create', nonce: Date.now() });
      },
    },
    { id: 'refresh', title: 'Обновить рабочее пространство', icon: 'refresh', run: () => void reload() },
    ...(selectedChange === null
      ? []
      : ([
          {
            id: 'validate',
            title: `Проверить ${selectedChange}`,
            icon: 'check',
            keywords: 'валидация validate',
            run: () => {
              setSection('board');
              setBoardRequest({ kind: 'detail', change: selectedChange, intent: 'validate', nonce: Date.now() });
            },
          },
          {
            id: 'archive',
            title: 'Архивировать change…',
            icon: 'archive',
            keywords: `архивация ${selectedChange}`,
            run: () => {
              setSection('board');
              setBoardRequest({ kind: 'detail', change: selectedChange, intent: 'archive', nonce: Date.now() });
            },
          },
          {
            id: 'trace',
            title: `Трассировка ${selectedChange}`,
            icon: 'trace',
            keywords: 'покрытие сценарии',
            run: () => openForChange('trace', selectedChange),
          },
        ] satisfies PaletteCommand[])),
  ];

  const compact = width !== null && width < COMPACT_BELOW_PX;
  const needsChange = section === 'metrics' || section === 'deltas';
  const ready = workspace?.state === 'ready';

  return (
    <div ref={appRef} className={compact ? 'app compact' : 'app'}>
      <header className="app-header">
        <span className="brand" aria-hidden="true">
          <Icon name="spec" size={14} />
        </span>
        <nav className="nav" aria-label="Разделы">
          {visibleSections.map((item) => (
            <button
              key={item.id}
              type="button"
              className="nav-item"
              aria-current={section === item.id ? 'page' : undefined}
              aria-label={item.title}
              title={item.title}
              onClick={() => setSection(item.id)}
              data-testid={`nav-${item.id}`}
            >
              <Icon name={item.icon} />
              <span className="nav-label">{item.title}</span>
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button
          type="button"
          className="search-trigger"
          onClick={() => setPalette(true)}
          aria-label="Поиск и команды (Ctrl+K)"
          data-testid="open-palette"
        >
          <Icon name="search" size={15} />
          <span className="label">Поиск и команды</span>
          <span className="kbd">Ctrl</span>
          <span className="kbd">K</span>
        </button>
        <span
          className={`sync ${connection}`}
          title={connection === 'connected' ? 'Изменения на диске подхватываются сразу' : CONNECTION_LABEL[connection]}
          data-testid="connection-state"
          data-state={connection}
        >
          <span className="dot" />
          <span className="sync-label">{CONNECTION_LABEL[connection]}</span>
        </span>
        <button type="button" className="icon-btn" aria-label="Обновить" title="Обновить" onClick={() => void reload()}>
          <Icon name="refresh" />
        </button>
      </header>

      <div className="app-main">
        {section === 'explorer' && (
          <aside className="explorer-tree" aria-label="Рабочее пространство">
            <p className="pane-title">Рабочее пространство</p>
            {tree === null ? <TreeSkeleton /> : <Tree tree={tree} selection={selection} onSelect={select} />}
          </aside>
        )}

        <main className="page">
          <div className="toolbar">
            <h1>{TITLE[section]}</h1>
            {needsChange && ready && (
              <ChangePicker changes={changes} value={selectedChange} onChange={chooseChange} />
            )}
            <div className="page-actions" ref={setActionsTarget} />
          </div>

          <Notices
            workspace={workspace}
            loadError={loadError}
            staleBackend={staleBackend}
            onRefresh={() => void reload()}
          />

          <ActionsTargetProvider value={actionsTarget}>
            <div className={FLUSH.has(section) && ready ? 'page-body flush' : 'page-body'}>
              {workspace === null && loadError === null ? (
                <PageSkeleton />
              ) : !ready ? null : section === 'processes' ? (
                <Processes revision={revision} onChanged={() => void reload()} />
              ) : section === 'structure' ? (
                <Structure revision={revision} />
              ) : section === 'context' ? (
                <ContextMap revision={revision} />
              ) : section === 'metrics' ? (
                selectedChange !== null ? (
                  <Metrics change={selectedChange} />
                ) : (
                  <ChooseChange changes={changes} what="его метрики" onChange={chooseChange} />
                )
              ) : section === 'board' ? (
                <Board
                  schemas={tree?.schemas ?? []}
                  revision={revision}
                  request={boardRequest}
                  onChanged={() => void reload()}
                  onNavigate={openForChange}
                  onOpenArtifact={openArtifact}
                  onOpenFile={openFile}
                />
              ) : section === 'deltas' ? (
                selectedChange !== null ? (
                  <Deltas
                    key={selectedChange}
                    change={selectedChange}
                    revision={revision}
                    tab={deltasTab}
                    onTab={setDeltasTab}
                    onOpenFile={openFile}
                  />
                ) : selection?.kind === 'capability' ? (
                  <div className="deltas-page">
                    <div className="deltas-main">
                      <SpecView capability={selection.id} />
                    </div>
                  </div>
                ) : (
                  <div className="deltas-page">
                    <div className="deltas-main">
                      <p className="pane-title">Карта связей спеков и changes</p>
                      <CapabilityMapView />
                    </div>
                  </div>
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
                      revealLine={revealLine}
                    />
                  );
                })()
              ) : (
                <Detail tree={tree} selection={selection} />
              )}
            </div>
          </ActionsTargetProvider>
        </main>
      </div>

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} onOpenHit={openHit} />}
    </div>
  );
}

function Notices({
  workspace,
  loadError,
  staleBackend,
  onRefresh,
}: {
  readonly workspace: WorkspaceResponse | null;
  readonly loadError: string | null;
  readonly staleBackend: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="page-notices">
      {staleBackend && (
        <div className="notice warn" role="alert" data-testid="stale-backend">
          <p>
            <b>Установлена новая сборка расширения.</b> В VS Code ещё работает прежний бэкенд, часть разделов
            будет отвечать ошибками.
          </p>
          <p>
            Перезагрузите окно: палитра команд → <code>Developer: Reload Window</code>. Если не помогло — закройте все
            окна VS Code и откройте проект заново, затем проверьте версию расширения OpenSpec IDE в разделе
            «Расширения».
          </p>
        </div>
      )}

      {loadError !== null && (
        <p className="notice error" role="alert">
          {loadError}
        </p>
      )}

      {workspace?.state === 'not-initialized' && (
        <div className="state-card" data-testid="not-initialized">
          <span className="state-icon info">
            <Icon name="folder" size={22} />
          </span>
          <h2>OpenSpec в проекте не заведён</h2>
          <p>
            {workspace.message} Выполните <code>{workspace.hint}</code> и обновите панель.
          </p>
          <button type="button" className="btn" onClick={onRefresh}>
            <Icon name="refresh" size={14} />
            Обновить
          </button>
        </div>
      )}

      {workspace?.state === 'cli-missing' && (
        <div className="state-card" data-testid="cli-missing">
          <span className="state-icon bad">
            <Icon name="plug" size={22} />
          </span>
          <h2>{workspace.notice.title}</h2>
          {workspace.notice.configured === null && (
            <p>
              Все операции над проектом идут через CLI. Установите <code>{workspace.notice.tool}</code>:{' '}
              <code>{workspace.notice.install}</code>.
            </p>
          )}
          <p data-testid="cli-missing-hint">{workspace.notice.hint}</p>
          <button type="button" className="btn" onClick={onRefresh}>
            <Icon name="refresh" size={14} />
            Искать снова
          </button>
          {workspace.notice.searched.length > 0 && (
            <details>
              <summary>Где искали ({workspace.notice.searched.length})</summary>
              <ul className="failure-details mono">
                {workspace.notice.searched.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {workspace?.state === 'ready' &&
        workspace.errors.map((error) => (
          <p className="notice error" key={error}>
            {error}
          </p>
        ))}
    </div>
  );
}

/** Скелетон раздела до первого ответа бэкенда. */
export function PageSkeleton() {
  return (
    <div className="page-skeleton" aria-busy="true" aria-label="Загрузка">
      <div className="skeleton-row">
        {[0, 1, 2, 3, 4].map((index) => (
          <span key={index} className="skeleton" style={{ width: 96, height: 26, borderRadius: 13 }} />
        ))}
      </div>
      <div className="skeleton-grid">
        {[0, 1, 2].map((index) => (
          <div key={index} className="skeleton-col">
            <span className="skeleton" style={{ width: '60%', height: 14 }} />
            <span className="skeleton" style={{ height: 96 }} />
            <span className="skeleton" style={{ height: 96 }} />
          </div>
        ))}
      </div>
      <span className="muted skeleton-note">
        <Icon name="refresh" size={13} /> Читаю проект через CLI OpenSpec…
      </span>
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div className="tree-skeleton" aria-busy="true" aria-label="Загрузка">
      {[70, 55, 62, 48, 66, 40].map((width, index) => (
        <span key={index} className="skeleton" style={{ width: `${width}%`, height: 12 }} />
      ))}
    </div>
  );
}
