import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BoardCard, BoardColumn, Board as BoardModel, TreeSchema } from '@openspec-ide/core';
import { createChange, fetchBoard } from '../lib/api.js';
import { formatAge } from '../lib/format.js';
import { readPref, writePref } from '../lib/prefs.js';
import { ChangeDetail, type DetailIntent } from './ChangeDetail.js';

export const COLUMN_TITLE: Record<string, string> = {
  ready: 'Готово к работе',
  'in-progress': 'В работе',
  'to-archive': 'Готово к архивации',
};

/** Режим раскладки доски. */
type BoardMode = 'auto' | 'columns' | 'list';

const MODES: readonly BoardMode[] = ['auto', 'columns', 'list'];
const MODE_LABEL: Record<BoardMode, string> = { auto: 'Авто', columns: 'Колонки', list: 'Список' };

/** Уже этой ширины доска в режиме «Авто» показывается списком. */
export const LIST_BELOW_PX = 640;
/** Начиная с этой ширины панель деталей стоит рядом с доской, а не поверх неё. */
export const DETAIL_SIDE_FROM_PX = 1100;

/** Разделы, в которые можно перейти с доски. */
export type BoardTarget = 'deltas' | 'metrics' | 'agent';

export interface BoardProps {
  readonly schemas: readonly TreeSchema[];
  /** Счётчик изменений на диске: доска перечитывает данные при его смене. */
  readonly revision: number;
  readonly onChanged: () => void;
  /** Открыть раздел панели для change. */
  readonly onNavigate: (section: BoardTarget, change: string) => void;
  /** Открыть артефакт change: в VS Code — файл в редакторе, в браузере — встроенный редактор. */
  readonly onOpenArtifact: (change: string, artifactId: string, path: string | null) => void;
  /** Открыть файл рабочего пространства на строке. */
  readonly onOpenFile: (path: string, line: number | null) => void;
  /** Сгенерировать артефакт change агентом с замыслом автора. */
  readonly onGenerate: (change: string, artifact: string, brief: string | null) => void;
}

export function Board({ schemas, revision, onChanged, onNavigate, onOpenArtifact, onOpenFile, onGenerate }: BoardProps) {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [error, setError] = useState<{ message: string; output: string } | null>(null);
  const [selected, setSelected] = useState<{ change: string; intent: DetailIntent } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSchema, setNewSchema] = useState('');
  const [newBrief, setNewBrief] = useState('');
  const [generateFirst, setGenerateFirst] = useState(true);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<BoardMode>(() => readPref('board-mode', MODES, 'auto'));
  const [showEmpty, setShowEmpty] = useState(() => readPref('board-empty', ['show', 'collapse'], 'collapse') === 'show');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [width, setWidth] = useState<number | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
    } catch (problem) {
      setError({ message: problem instanceof Error ? problem.message : String(problem), output: '' });
    }
  }, []);

  // Перечитывается и по своим действиям, и по изменению файлов в обход IDE:
  // отметка пункта в редакторе VS Code должна двигать карточку сама.
  useEffect(() => {
    void reload();
  }, [reload, revision]);

  // Ширина — самой доски, а не окна: в VS Code панель занимает часть окна.
  useLayoutEffect(() => {
    const element = paneRef.current;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selected === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  function chooseMode(next: BoardMode): void {
    setMode(next);
    writePref('board-mode', next);
  }

  function toggleEmpty(): void {
    setShowEmpty((value) => {
      writePref('board-empty', value ? 'collapse' : 'show');
      return !value;
    });
    setExpanded(new Set());
  }

  async function create(): Promise<void> {
    setError(null);
    try {
      const name = newName.trim();
      await createChange(name, newSchema === '' ? undefined : newSchema);
      const brief = newBrief.trim();
      setNewName('');
      setNewBrief('');
      setCreating(false);
      const next = await fetchBoard();
      setBoard(next);
      onChanged();
      // С замыслом change сразу получает первый артефакт от агента — тот, в
      // колонке которого стоит его карточка.
      const first = next.cards.find((card) => card.change === name)?.column;
      if (brief !== '' && generateFirst && first !== undefined && next.columns.some((column) => column.id === first && column.isArtifact)) {
        onGenerate(name, first, brief);
      }
    } catch (problem) {
      const payload = problem as { message?: string; output?: string };
      setError({
        message: payload.message ?? String(problem),
        output: typeof payload.output === 'string' ? payload.output : '',
      });
    }
  }

  const effective: Exclude<BoardMode, 'auto'> =
    mode === 'auto' ? (width !== null && width < LIST_BELOW_PX ? 'list' : 'columns') : mode;
  const needle = filter.trim().toLocaleLowerCase();
  const visible = (board?.cards ?? []).filter(
    (card) => needle === '' || card.change.toLocaleLowerCase().includes(needle),
  );
  const card = selected === null ? undefined : board?.cards.find((item) => item.change === selected.change);
  const detailBeside = width !== null && width >= DETAIL_SIDE_FROM_PX;
  const select = (change: string, intent: DetailIntent = 'none'): void => setSelected({ change, intent });

  return (
    <div
      ref={paneRef}
      className={`board-pane ${card !== undefined ? (detailBeside ? 'with-detail' : 'with-overlay') : ''}`}
      data-mode={effective}
    >
      <div className="board-toolbar">
        <button
          type="button"
          className="btn primary"
          onClick={() => setCreating((value) => !value)}
          data-testid="new-change"
        >
          Новое изменение
        </button>
        <input
          className="board-filter"
          type="search"
          value={filter}
          placeholder="фильтр по имени"
          aria-label="Фильтр по имени изменения"
          onChange={(event) => setFilter(event.target.value)}
          data-testid="board-filter"
        />
        <div className="segmented" role="group" aria-label="Раскладка доски">
          {MODES.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={mode === item}
              onClick={() => chooseMode(item)}
              data-testid={`board-mode-${item}`}
            >
              {MODE_LABEL[item]}
            </button>
          ))}
        </div>
        <button type="button" className="btn" aria-pressed={showEmpty} onClick={toggleEmpty} data-testid="toggle-empty">
          {showEmpty ? 'Свернуть пустые' : 'Показать пустые'}
        </button>
        <span className="crumbs">фаза выводится из файлов — карточку не перетащить</span>
      </div>

      {creating && (
        <form
          className="new-change-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            id="new-change-name"
            value={newName}
            placeholder="имя-изменения"
            aria-label="Имя изменения"
            onChange={(event) => setNewName(event.target.value)}
          />
          <select
            id="new-change-schema"
            value={newSchema}
            aria-label="Схема процесса"
            onChange={(event) => setNewSchema(event.target.value)}
          >
            <option value="">схема по умолчанию</option>
            {schemas.map((schema) => (
              <option key={schema.name} value={schema.name}>
                {schema.name}
                {schema.isDefault ? ' (умолч.)' : ''}
              </option>
            ))}
          </select>
          <button type="submit" className="btn primary">
            Создать
          </button>
          <textarea
            className="new-change-brief"
            rows={3}
            value={newBrief}
            placeholder="Замысел: что и зачем меняем (необязательно) — по нему агент напишет первый артефакт"
            aria-label="Замысел изменения"
            data-testid="new-change-brief"
            onChange={(event) => setNewBrief(event.target.value)}
          />
          {newBrief.trim() !== '' && (
            <label className="inline-check">
              <input
                type="checkbox"
                checked={generateFirst}
                onChange={(event) => setGenerateFirst(event.target.checked)}
                data-testid="new-change-generate"
              />
              Сгенерировать первый артефакт агентом
            </label>
          )}
        </form>
      )}

      {error !== null && (
        <div className="notice error" role="alert" data-testid="board-error">
          <p>{error.message}</p>
          {error.output !== '' && <pre className="diff-preview">{error.output}</pre>}
        </div>
      )}

      {board === null && error === null && <p className="empty">Загрузка доски…</p>}

      {board !== null && (
        <div className="board-body">
          {effective === 'columns' ? (
            <ColumnsView
              columns={board.columns}
              cards={visible}
              collapseEmpty={!showEmpty}
              expanded={expanded}
              onExpand={(id) => setExpanded((current) => new Set([...current, id]))}
              selected={selected?.change ?? null}
              onSelect={select}
              onOpenArtifact={onOpenArtifact}
            />
          ) : (
            <ListView
              columns={board.columns}
              cards={visible}
              selected={selected?.change ?? null}
              onSelect={select}
              onOpenArtifact={onOpenArtifact}
            />
          )}

          {needle !== '' && visible.length === 0 && (
            <p className="empty" data-testid="board-filter-empty">
              Нет изменений, имя которых содержит «{filter.trim()}».
            </p>
          )}

          {card !== undefined && selected !== null && (
            <ChangeDetail
              key={`${card.change}:${selected.intent}`}
              card={card}
              columnTitle={COLUMN_TITLE[card.column] ?? card.column}
              intent={selected.intent}
              revision={revision}
              overlay={!detailBeside}
              onClose={() => setSelected(null)}
              onNavigate={onNavigate}
              onOpenArtifact={onOpenArtifact}
              onOpenFile={onOpenFile}
              onGenerate={(artifact) => onGenerate(card.change, artifact, null)}
              onChanged={async () => {
                await reload();
                onChanged();
              }}
              onArchived={async () => {
                setSelected(null);
                await reload();
                onChanged();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface CardListProps {
  readonly cards: readonly BoardCard[];
  readonly selected: string | null;
  readonly onSelect: (change: string, intent?: DetailIntent) => void;
  readonly onOpenArtifact: BoardProps['onOpenArtifact'];
}

function ColumnsView({
  columns,
  cards,
  collapseEmpty,
  expanded,
  onExpand,
  ...rest
}: CardListProps & {
  readonly columns: readonly BoardColumn[];
  readonly collapseEmpty: boolean;
  readonly expanded: ReadonlySet<string>;
  readonly onExpand: (id: string) => void;
}) {
  const layout = columns.map((column) => {
    const inColumn = cards.filter((item) => item.column === column.id);
    return { column, cards: inColumn, collapsed: collapseEmpty && inColumn.length === 0 && !expanded.has(column.id) };
  });

  return (
    <div
      className="board"
      data-testid="board"
      style={{
        gridTemplateColumns: layout
          .map((entry) => (entry.collapsed ? '36px' : 'minmax(190px, 340px)'))
          .join(' '),
      }}
    >
      {layout.map(({ column, cards: inColumn, collapsed }) => {
        const title = COLUMN_TITLE[column.id] ?? column.id;
        if (collapsed) {
          return (
            <button
              type="button"
              key={column.id}
              className="col-strip"
              data-testid={`column-${column.id}`}
              data-collapsed="true"
              title={`${title}: пусто — развернуть`}
              aria-label={`${title}, пусто. Развернуть колонку`}
              onClick={() => onExpand(column.id)}
            >
              <span className="n">0</span>
              <span className="label">{title}</span>
            </button>
          );
        }
        return (
          <div className="col" key={column.id} data-testid={`column-${column.id}`}>
            <header>
              <h3 title={title}>{title}</h3>
              <span className="n">{inColumn.length}</span>
            </header>
            {inColumn.map((item) => (
              <Card key={item.change} card={item} {...rest} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ListView({ columns, cards, ...rest }: CardListProps & { readonly columns: readonly BoardColumn[] }) {
  return (
    <div className="board-list" data-testid="board">
      {columns.map((column) => {
        const inColumn = cards.filter((item) => item.column === column.id);
        const title = COLUMN_TITLE[column.id] ?? column.id;
        return (
          <section
            key={column.id}
            className={`phase ${inColumn.length === 0 ? 'empty-phase' : ''}`}
            data-testid={`column-${column.id}`}
          >
            <header>
              <h3>{title}</h3>
              <span className="n">{inColumn.length}</span>
            </header>
            {inColumn.map((item) => (
              <Card key={item.change} card={item} {...rest} row />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Card({
  card,
  selected,
  onSelect,
  onOpenArtifact,
  row = false,
}: Omit<CardListProps, 'cards'> & { readonly card: BoardCard; readonly row?: boolean }) {
  const age = formatAge(card.lastModified);
  const progress = card.progress;
  const hasProgress = progress !== null && progress.total > 0;

  return (
    <article
      className={`card ${selected === card.change ? 'lift' : ''} ${row ? 'row-card' : ''}`}
      data-testid={`card-${card.change}`}
      onClick={() => onSelect(card.change)}
    >
      <div className="card-head">
        <button
          type="button"
          className="card-title"
          aria-pressed={selected === card.change}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(card.change);
          }}
          data-testid={`card-open-${card.change}`}
        >
          {card.change}
        </button>
        {age !== null && (
          <span className="age" title={card.lastModified ?? undefined} data-testid="card-age">
            изменён {age}
          </span>
        )}
      </div>

      <div className="chips">
        <span className="chip">{card.schema}</span>
        {card.waivers.length > 0 && (
          <span
            className="chip warn"
            data-testid="card-waiver"
            title={card.waivers.map((waiver) => `${waiver.rule}: ${waiver.reason}`).join('\n')}
          >
            ⊘ отказ SDD
          </span>
        )}
        {card.artifacts.map((artifact) =>
          artifact.path !== null && artifact.path !== undefined ? (
            <button
              type="button"
              key={artifact.id}
              className={artifact.done ? 'chip on' : 'chip no'}
              title={`Открыть ${artifact.path}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenArtifact(card.change, artifact.id, artifact.path ?? null);
              }}
              data-testid={`card-artifact-${card.change}-${artifact.id}`}
            >
              {artifact.id}
            </button>
          ) : (
            <span key={artifact.id} className="chip no" title="ещё не создан">
              {artifact.id}
            </span>
          ),
        )}
      </div>

      {hasProgress && (
        <div className="meter">
          <i style={{ width: `${Math.round((progress.complete / progress.total) * 100)}%` }} />
        </div>
      )}

      <div className="foot">
        <span>{hasProgress ? `${progress.complete}/${progress.total} пунктов` : 'нет пунктов'}</span>
        <button
          type="button"
          className={`validity ${card.errorCount > 0 ? 'err' : card.validationUnknown ? 'unknown' : 'ok'}`}
          title={card.errorCount > 0 ? 'Показать замечания проверки' : 'Запустить проверку'}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(card.change, 'validate');
          }}
          data-testid={`card-validity-${card.change}`}
        >
          {card.validationUnknown
            ? 'не проверялся'
            : card.errorCount > 0
              ? `${card.errorCount} ош.`
              : 'валиден'}
        </button>
      </div>

      {card.column === 'to-archive' && (
        <button
          type="button"
          className="btn primary card-archive"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(card.change, 'archive');
          }}
          data-testid={`card-archive-${card.change}`}
        >
          Архивировать…
        </button>
      )}
    </article>
  );
}
