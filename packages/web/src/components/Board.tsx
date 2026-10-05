import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardCard, BoardColumn, Board as BoardModel, ChangeDrift, DriftReport, QualityOverview, TreeSchema } from '@openspec-ide/core';
import { createArtifactFile, createChange, fetchBoard, fetchDrift, fetchQuality } from '../lib/api.js';
import { formatAge, plural } from '../lib/format.js';
import { COLUMN_TITLE, columnTitle } from '../lib/phase.js';
import { readPref, writePref } from '../lib/prefs.js';
import { buildThread, threadCaption } from '../lib/thread.js';
import { PageActions, useNotify, useWidth } from '../lib/ui.js';
import { ChangeDetail, type DetailIntent } from './ChangeDetail.js';
import { Icon } from './Icon.js';
import { Thread } from './Thread.js';

export { COLUMN_TITLE };

/** Режим раскладки доски. */
type BoardMode = 'auto' | 'columns' | 'list';

const MODES: readonly BoardMode[] = ['auto', 'columns', 'list'];
const MODE_LABEL: Record<BoardMode, string> = { auto: 'Авто', columns: 'Колонки', list: 'Список' };
const MODE_ICON = { auto: 'auto', columns: 'columns', list: 'list' } as const;

/** Уже этой ширины доска в режиме «Авто» показывается списком. */
export const LIST_BELOW_PX = 640;
/** Начиная с этой ширины панель деталей стоит рядом с доской, а не поверх неё. */
export const DETAIL_SIDE_FROM_PX = 1100;

/** Разделы, в которые можно перейти с доски. */
export type BoardTarget = 'deltas' | 'metrics' | 'trace' | 'quality';

/** Запрос к доске извне — из палитры команд. */
export type BoardRequest =
  | { readonly kind: 'create'; readonly nonce: number }
  | { readonly kind: 'detail'; readonly change: string; readonly intent: DetailIntent; readonly nonce: number };

export interface BoardProps {
  readonly schemas: readonly TreeSchema[];
  /** Счётчик изменений на диске: доска перечитывает данные при его смене. */
  readonly revision: number;
  readonly request?: BoardRequest | null;
  readonly onChanged: () => void;
  /** Открыть раздел панели для change. */
  readonly onNavigate: (section: BoardTarget, change: string) => void;
  /** Открыть артефакт change: в VS Code — файл в редакторе, в браузере — встроенный редактор. */
  readonly onOpenArtifact: (change: string, artifactId: string, path: string | null) => void;
  /** Открыть файл рабочего пространства на строке. */
  readonly onOpenFile: (path: string, line: number | null) => void;
}

export function Board({ schemas, revision, request = null, onChanged, onNavigate, onOpenArtifact, onOpenFile }: BoardProps) {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [drift, setDrift] = useState<DriftReport | null>(null);
  const [quality, setQuality] = useState<QualityOverview | null>(null);
  const [error, setError] = useState<{ message: string; output: string } | null>(null);
  const [selected, setSelected] = useState<{ change: string; intent: DetailIntent } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSchema, setNewSchema] = useState('');
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<BoardMode>(() => readPref('board-mode', MODES, 'auto'));
  const [showEmpty, setShowEmpty] = useState(() => readPref('board-empty', ['show', 'collapse'], 'collapse') === 'show');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [paneRef, width] = useWidth<HTMLDivElement>();
  const notify = useNotify();
  const handled = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
      // Отчёт о пересечениях читает историю git — после доски, чтобы её не задерживать.
      void fetchDrift()
        .then(setDrift)
        .catch(() => setDrift(null));
      // Качество спеков читает код модулей — тоже после доски.
      void fetchQuality()
        .then(setQuality)
        .catch(() => setQuality(null));
    } catch (problem) {
      setError({ message: problem instanceof Error ? problem.message : String(problem), output: '' });
    }
  }, []);

  // Перечитывается и по своим действиям, и по изменению файлов в обход IDE:
  // отметка пункта в редакторе VS Code должна двигать карточку сама.
  useEffect(() => {
    void reload();
  }, [reload, revision]);

  // Запрос из палитры команд: создать change или открыть его панель.
  useEffect(() => {
    if (request === null || handled.current === request.nonce) return;
    handled.current = request.nonce;
    if (request.kind === 'create') setCreating(true);
    else setSelected({ change: request.change, intent: request.intent });
  }, [request]);

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

  function showError(problem: unknown): void {
    const payload = problem as { message?: string; output?: string };
    setError({
      message: payload.message ?? String(problem),
      output: typeof payload.output === 'string' ? payload.output : '',
    });
  }

  async function create(): Promise<void> {
    setError(null);
    try {
      const name = newName.trim();
      await createChange(name, newSchema === '' ? undefined : newSchema);
      setNewName('');
      setCreating(false);
      setBoard(await fetchBoard());
      onChanged();
      notify({ kind: 'ok', title: 'Change создан', detail: name });
    } catch (problem) {
      showError(problem);
    }
  }

  async function createArtifact(change: string, artifact: string, capabilityPath?: string): Promise<void> {
    setError(null);
    try {
      const created = await createArtifactFile(change, artifact, capabilityPath);
      notify({ kind: 'ok', title: `Создан ${artifact}`, detail: created.path });
      await reload();
      onChanged();
      onOpenArtifact(change, artifact, created.path);
    } catch (problem) {
      showError(problem);
    }
  }

  function revealPhase(column: BoardColumn, count: number): void {
    if (count === 0) {
      setExpanded((current) => new Set([...current, column.id]));
      return;
    }
    document.querySelector(`[data-testid="column-${CSS.escape(column.id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  const counts = new Map((board?.columns ?? []).map((column) => [column.id, visible.filter((item) => item.column === column.id).length]));

  const cardProps = {
    drift,
    quality,
    selected: selected?.change ?? null,
    onSelect: select,
    onOpenArtifact,
    onCreateArtifact: (change: string, artifact: string, capabilityPath?: string) =>
      void createArtifact(change, artifact, capabilityPath),
  };

  return (
    <div
      ref={paneRef}
      className={`board-pane ${card !== undefined ? (detailBeside ? 'with-detail' : 'with-overlay') : ''}`}
      data-mode={effective}
    >
      <PageActions>
        <label className="field-search board-filter">
          <Icon name="filter" size={14} />
          <input
            type="search"
            value={filter}
            placeholder="Фильтр по имени"
            aria-label="Фильтр по имени изменения"
            onChange={(event) => setFilter(event.target.value)}
            data-testid="board-filter"
          />
        </label>
        <div className="segmented" role="group" aria-label="Раскладка доски">
          {MODES.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={mode === item}
              onClick={() => chooseMode(item)}
              title={item === 'auto' ? 'Колонки или список — по ширине панели' : undefined}
              data-testid={`board-mode-${item}`}
            >
              <Icon name={MODE_ICON[item]} size={14} />
              <span className="seg-label">{MODE_LABEL[item]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost" aria-pressed={showEmpty} onClick={toggleEmpty} data-testid="toggle-empty">
          <Icon name="eye" size={15} />
          Пустые фазы
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => setCreating((value) => !value)}
          aria-expanded={creating}
          data-testid="new-change"
        >
          <Icon name="plus" size={15} />
          Новое изменение
        </button>
      </PageActions>

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
            className="mono"
            value={newName}
            placeholder="имя-изменения"
            aria-label="Имя изменения"
            autoFocus
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
          <button type="button" className="btn ghost" onClick={() => setCreating(false)}>
            Отмена
          </button>
        </form>
      )}

      {error !== null && (
        <div className="notice error board-error" role="alert" data-testid="board-error">
          <p>{error.message}</p>
          {error.output !== '' && <pre className="diff-preview">{error.output}</pre>}
        </div>
      )}

      {board === null && error === null && <BoardSkeleton />}

      {board !== null && (
        <>
          <PhaseStrip columns={board.columns} counts={counts} onReveal={revealPhase} />
          <div className="board-body">
            <div className="board-scroll">
              {board.cards.length === 0 ? (
                <div className="state-card" data-testid="board-empty">
                  <span className="state-icon info">
                    <Icon name="board" size={22} />
                  </span>
                  <h2>Активных изменений нет</h2>
                  <p>Change — это предложение изменения в <code>openspec/changes/</code>. Создайте первый.</p>
                  <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                    <Icon name="plus" size={14} />
                    Новое изменение
                  </button>
                </div>
              ) : effective === 'columns' ? (
                <ColumnsView
                  columns={board.columns}
                  cards={visible}
                  showEmpty={showEmpty}
                  expanded={expanded}
                  {...cardProps}
                />
              ) : (
                <ListView columns={board.columns} cards={visible} showEmpty={showEmpty} {...cardProps} />
              )}

              {needle !== '' && visible.length === 0 && board.cards.length > 0 && (
                <p className="empty" data-testid="board-filter-empty">
                  Нет изменений, имя которых содержит «{filter.trim()}».
                </p>
              )}
            </div>

            {card !== undefined && selected !== null && (
              <ChangeDetail
                key={`${card.change}:${selected.intent}`}
                card={card}
                columnTitle={columnTitle(card.column)}
                drift={drift?.changes[card.change] ?? null}
                quality={quality}
                intent={selected.intent}
                revision={revision}
                overlay={!detailBeside}
                onClose={() => setSelected(null)}
                onNavigate={onNavigate}
                onOpenArtifact={onOpenArtifact}
                onOpenFile={onOpenFile}
                onChanged={async () => {
                  await reload();
                  onChanged();
                }}
                onArchived={async () => {
                  setSelected(null);
                  notify({ kind: 'ok', title: 'Change архивирован', detail: card.change });
                  await reload();
                  onChanged();
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Полоса всех фаз со счётчиками — вместо свёрнутых полос пустых колонок. */
function PhaseStrip({
  columns,
  counts,
  onReveal,
}: {
  readonly columns: readonly BoardColumn[];
  readonly counts: ReadonlyMap<string, number>;
  readonly onReveal: (column: BoardColumn, count: number) => void;
}) {
  const group = (items: readonly BoardColumn[]) =>
    items.map((column, index) => {
      const count = counts.get(column.id) ?? 0;
      return (
        <span key={column.id} className="phase-step">
          {index > 0 && <span className="phase-link" aria-hidden="true" />}
          <button
            type="button"
            className={`phase-chip ${count > 0 ? 'filled' : 'empty'} ${column.isArtifact ? 'artifact' : 'work'}`}
            onClick={() => onReveal(column, count)}
            title={count === 0 ? `${columnTitle(column.id)}: пусто — показать колонку` : `${columnTitle(column.id)}: ${count}`}
            data-testid={`phase-${column.id}`}
          >
            <span className="dot" aria-hidden="true" />
            <span className={column.isArtifact ? 'mono' : undefined}>{columnTitle(column.id)}</span>
            <span className="badge">{count}</span>
          </button>
        </span>
      );
    });
  const artifacts = columns.filter((column) => column.isArtifact);
  const work = columns.filter((column) => !column.isArtifact);
  return (
    <div className="phase-strip" role="navigation" aria-label="Фазы процесса" data-testid="phase-strip">
      <span className="phase-group-label">Артефакты</span>
      {group(artifacts)}
      <span className="phase-divider" aria-hidden="true" />
      <span className="phase-group-label">Реализация</span>
      {group(work)}
    </div>
  );
}

interface CardListProps {
  readonly cards: readonly BoardCard[];
  /** Пересечения, устаревание и ожидание архивации; `null` — отчёт ещё не получен. */
  readonly drift: DriftReport | null;
  /** Качество спеков; `null` — сводка ещё не получена. */
  readonly quality: QualityOverview | null;
  readonly selected: string | null;
  readonly onSelect: (change: string, intent?: DetailIntent) => void;
  readonly onOpenArtifact: BoardProps['onOpenArtifact'];
  readonly onCreateArtifact: (change: string, artifact: string, capabilityPath?: string) => void;
}

function ColumnsView({
  columns,
  cards,
  showEmpty,
  expanded,
  ...rest
}: CardListProps & {
  readonly columns: readonly BoardColumn[];
  readonly showEmpty: boolean;
  readonly expanded: ReadonlySet<string>;
}) {
  const shown = columns
    .map((column) => ({ column, cards: cards.filter((item) => item.column === column.id) }))
    .filter((entry) => entry.cards.length > 0 || showEmpty || expanded.has(entry.column.id));

  return (
    <div className="board" data-testid="board" style={{ gridTemplateColumns: `repeat(${Math.max(1, shown.length)}, minmax(240px, 1fr))` }}>
      {shown.map(({ column, cards: inColumn }) => {
        const title = columnTitle(column.id);
        return (
          <section className="col" key={column.id} data-testid={`column-${column.id}`} aria-label={title}>
            <header>
              <span className={`dot ${column.isArtifact ? 'artifact' : 'work'}`} aria-hidden="true" />
              <h3 title={title} className={column.isArtifact ? 'mono' : undefined}>
                {title}
              </h3>
              <span className="badge">{inColumn.length}</span>
            </header>
            {inColumn.length === 0 && <p className="empty col-empty">Пусто</p>}
            {inColumn.map((item) => (
              <Card key={item.change} card={item} {...rest} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function ListView({
  columns,
  cards,
  showEmpty,
  ...rest
}: CardListProps & { readonly columns: readonly BoardColumn[]; readonly showEmpty: boolean }) {
  const entries = columns.map((column) => ({ column, cards: cards.filter((item) => item.column === column.id) }));
  const empty = entries.filter((entry) => entry.cards.length === 0);
  return (
    <div className="board-list" data-testid="board">
      {entries
        .filter((entry) => entry.cards.length > 0 || showEmpty)
        .map(({ column, cards: inColumn }) => {
          const title = columnTitle(column.id);
          return (
            <section key={column.id} className="phase" data-testid={`column-${column.id}`}>
              <header>
                <h3 className={column.isArtifact ? 'mono' : undefined}>{title}</h3>
                <span className="badge">{inColumn.length}</span>
              </header>
              {inColumn.map((item) => (
                <Card key={item.change} card={item} {...rest} row />
              ))}
            </section>
          );
        })}
      {!showEmpty && empty.length > 0 && (
        <p className="empty empty-phases" data-testid="empty-phases">
          Пустые фазы: {empty.map((entry) => columnTitle(entry.column.id)).join(', ')}
        </p>
      )}
    </div>
  );
}

function Card({
  card,
  drift: report,
  quality,
  selected,
  onSelect,
  onOpenArtifact,
  onCreateArtifact,
  row = false,
}: Omit<CardListProps, 'cards'> & { readonly card: BoardCard; readonly row?: boolean }) {
  const [capability, setCapability] = useState<string | null>(null);
  const drift = report?.changes[card.change] ?? null;
  const age = formatAge(card.lastModified);
  const thread = buildThread(card);
  const next = thread.next === null ? undefined : card.artifacts.find((artifact) => artifact.id === thread.next);

  return (
    <article
      className={`card ${selected === card.change ? 'lift' : ''} ${row ? 'row-card' : ''}`}
      data-testid={`card-${card.change}`}
      onClick={() => onSelect(card.change)}
    >
      <div className="card-head">
        <button
          type="button"
          className="card-title mono"
          aria-pressed={selected === card.change}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(card.change);
          }}
          data-testid={`card-open-${card.change}`}
        >
          {card.change}
        </button>
        {card.waivers.length > 0 && (
          <span
            className="chip warn"
            data-testid="card-waiver"
            title={card.waivers.map((waiver) => `${waiver.rule}: ${waiver.reason}`).join('\n')}
          >
            отказ SDD
          </span>
        )}
      </div>
      {drift !== null && <DriftChips drift={drift} />}
      <QualityChip quality={quality} change={card.change} />
      <div className="card-meta">
        <span>{card.schema}</span>
        {age !== null && (
          <span title={card.lastModified ?? undefined} data-testid="card-age">
            изменён {age}
          </span>
        )}
      </div>

      <Thread card={card} thread={thread} onOpen={(id, path) => onOpenArtifact(card.change, id, path)} />
      <p className="card-caption">{threadCaption(card, thread)}</p>

      <div className="card-foot">
        <button
          type="button"
          className={`status ${card.errorCount > 0 ? 'bad' : card.validationUnknown ? 'unknown' : 'ok'}`}
          title={card.errorCount > 0 ? 'Показать замечания проверки' : 'Запустить проверку'}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(card.change, 'validate');
          }}
          data-testid={`card-validity-${card.change}`}
        >
          <Icon name={card.errorCount > 0 ? 'error' : card.validationUnknown ? 'circle' : 'checkCircle'} size={14} />
          {card.validationUnknown
            ? 'не проверялся'
            : card.errorCount > 0
              ? plural(card.errorCount, ['ошибка', 'ошибки', 'ошибок'])
              : 'проверка пройдена'}
        </button>
        <span className="spacer" />
        {next !== undefined && capability === null && (
          <button
            type="button"
            className="btn small"
            title={`Создать ${next.id} по шаблону схемы`}
            onClick={(event) => {
              event.stopPropagation();
              if (next.perCapability === true) setCapability('');
              else onCreateArtifact(card.change, next.id);
            }}
            data-testid={`card-create-${card.change}`}
          >
            <Icon name="filePlus" size={14} />
            {next.id}
          </button>
        )}
        {card.column === 'to-archive' && (
          <button
            type="button"
            className="btn small"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(card.change, 'archive');
            }}
            data-testid={`card-archive-${card.change}`}
          >
            <Icon name="archive" size={14} />
            Архивировать
          </button>
        )}
      </div>

      {next !== undefined && capability !== null && (
        <form
          className="card-capability"
          onClick={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            if (capability.trim() === '') return;
            onCreateArtifact(card.change, next.id, capability.trim());
            setCapability(null);
          }}
        >
          <input
            className="mono"
            value={capability}
            placeholder="путь capability"
            aria-label={`Путь capability для ${next.id}`}
            autoFocus
            onChange={(event) => setCapability(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setCapability(null);
              }
            }}
          />
          <button type="submit" className="btn small primary" disabled={capability.trim() === ''}>
            Создать
          </button>
        </form>
      )}
    </article>
  );
}

function BoardSkeleton() {
  return (
    <div className="page-skeleton board-skeleton" aria-busy="true" aria-label="Загрузка доски">
      <div className="skeleton-row">
        {[0, 1, 2, 3, 4].map((index) => (
          <span key={index} className="skeleton" style={{ width: 110, height: 28, borderRadius: 14 }} />
        ))}
      </div>
      <div className="skeleton-grid">
        {[0, 1, 2].map((index) => (
          <div key={index} className="skeleton-col">
            <span className="skeleton" style={{ width: '50%', height: 14 }} />
            <span className="skeleton" style={{ height: 120 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Чип качества спеков на карточке — только при ошибках или предупреждениях. */
function QualityChip({ quality, change }: { readonly quality: QualityOverview | null; readonly change: string }) {
  const counts = quality?.changes.find((item) => item.name === change);
  if (counts === undefined || counts.error + counts.warning === 0) return null;
  const parts = [
    counts.error > 0 ? plural(counts.error, ['ошибка', 'ошибки', 'ошибок']) : null,
    counts.warning > 0 ? plural(counts.warning, ['предупреждение', 'предупреждения', 'предупреждений']) : null,
    counts.info > 0 ? plural(counts.info, ['сведение', 'сведения', 'сведений']) : null,
  ].filter((part): part is string => part !== null);
  return (
    <div className="card-flags">
      <span className={counts.error > 0 ? 'chip bad' : 'chip warn'} data-testid={`card-quality-${change}`} title={`Качество дельт и артефактов: ${parts.join(', ')}`}>
        <Icon name="shield" size={12} />
        качество {counts.error + counts.warning}
      </span>
    </div>
  );
}

/** Отметки пересечения, устаревания и ожидания архивации на карточке. */
function DriftChips({ drift }: { readonly drift: ChangeDrift }) {
  const sure = drift.stale.filter((item) => item.certainty === 'stale');
  if (drift.overlaps.length === 0 && drift.stale.length === 0 && drift.forgottenDays === null) return null;
  return (
    <div className="card-flags">
      {drift.overlaps.length > 0 && (
        <span
          className="chip warn"
          data-testid="card-overlap"
          title={drift.overlaps
            .map((item) => `«${item.requirement}» — также ${item.others.map((other) => other.change).join(', ')}`)
            .join('\n')}
        >
          <Icon name="alert" size={12} />
          пересечение
        </span>
      )}
      {drift.stale.length > 0 && (
        <span
          className="chip warn"
          data-testid="card-stale"
          title={drift.stale.map((item) => `«${item.requirement}» (${item.capability})`).join('\n')}
        >
          <Icon name="alert" size={12} />
          {sure.length > 0 ? 'дельта устарела' : 'возможно устарела'}
        </span>
      )}
      {drift.forgottenDays !== null && (
        <span className="chip info" data-testid="card-forgotten" title="Всё сделано, но change не архивирован">
          <Icon name="archive" size={12} />
          ждёт архивации {drift.forgottenDays} дн.
        </span>
      )}
    </div>
  );
}
