import { useEffect, useRef, useState } from 'react';
import type { BoardCard } from '@openspec-ide/core';
import {
  type TrackedItemsResponse,
  archiveChange,
  fetchItems,
  fetchValidation,
  toggleItem,
} from '../lib/api.js';
import { formatAge } from '../lib/format.js';
import { ArchivePreview, type PreviewState } from './ArchivePreview.js';
import type { BoardProps } from './Board.js';
import { Problems, type ValidationState } from './Problems.js';

/** С чем открыта панель: просто детали, сразу проверка или сразу архивация. */
export type DetailIntent = 'none' | 'validate' | 'archive';

interface ChangeDetailProps {
  readonly card: BoardCard;
  readonly columnTitle: string;
  readonly intent: DetailIntent;
  readonly revision: number;
  /** Панель раскрыта поверх доски, а не рядом с ней. */
  readonly overlay: boolean;
  readonly onClose: () => void;
  readonly onNavigate: BoardProps['onNavigate'];
  readonly onOpenArtifact: BoardProps['onOpenArtifact'];
  readonly onOpenFile: BoardProps['onOpenFile'];
  /** Файлы change изменились действием панели — доску нужно перечитать. */
  readonly onChanged: () => Promise<void>;
  readonly onArchived: () => Promise<void>;
}

/** Панель деталей change рядом с доской. */
export function ChangeDetail({
  card,
  columnTitle,
  intent,
  revision,
  overlay,
  onClose,
  onNavigate,
  onOpenArtifact,
  onOpenFile,
  onChanged,
  onArchived,
}: ChangeDetailProps) {
  const [items, setItems] = useState<TrackedItemsResponse | null>(null);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [confirming, setConfirming] = useState(intent === 'archive');
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' });
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<{ message: string; output: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let current = true;
    void fetchItems(card.change)
      .then((result) => {
        if (current) setItems(result);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [card.change, revision]);

  useEffect(() => {
    if (intent === 'validate') void validate();
    // Проверка по намерению запускается один раз — при открытии панели.
  }, []);

  // Esc сначала закрывает подтверждение архивации, потом саму панель.
  useEffect(() => {
    if (!confirming) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setConfirming(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [confirming]);

  async function validate(): Promise<void> {
    setValidation({ entries: [], valid: false, error: null, stale: false, running: true });
    try {
      const run = await fetchValidation(card.change);
      if (run.superseded) return;
      setValidation({ entries: run.entries, valid: run.valid, error: run.error, stale: false, running: false });
      await onChanged();
    } catch (problem) {
      setValidation({
        entries: [],
        valid: false,
        error: problem instanceof Error ? problem.message : String(problem),
        stale: false,
        running: false,
      });
    }
  }

  /**
   * Переключает пункт сразу, не дожидаясь ответа сервера.
   *
   * Без этого чекбокс не реагирует на клик всё время запроса: он управляемый,
   * а состояние приходит только с ответом. При отказе отметка возвращается на
   * место, а причина показывается.
   */
  async function toggle(line: number, done: boolean): Promise<void> {
    const previous = items;
    setItems((current) =>
      current === null
        ? current
        : {
            ...current,
            items: current.items.map((item) => (item.line === line ? { ...item, done } : item)),
            complete: current.complete + (done ? 1 : -1),
          },
    );
    try {
      setItems(await toggleItem(card.change, line, done));
      await onChanged();
    } catch (problem) {
      setItems(previous);
      showError(problem);
    }
  }

  async function archive(): Promise<void> {
    setArchiving(true);
    setError(null);
    try {
      await archiveChange(card.change);
      await onArchived();
    } catch (problem) {
      showError(problem);
      setArchiving(false);
    }
  }

  function showError(problem: unknown): void {
    const payload = problem as { message?: string; output?: string };
    setError({
      message: payload.message ?? String(problem),
      output: typeof payload.output === 'string' ? payload.output : '',
    });
  }

  const unfinished = items === null ? 0 : items.total - items.complete;
  const age = formatAge(card.lastModified);
  const archivable = preview.kind === 'done' && preview.preview.outcome === 'ready';
  const groups = groupItems(items);

  return (
    <section
      className={`change-detail ${overlay ? 'overlay' : 'side'}`}
      data-testid="change-detail"
      aria-label={`Изменение ${card.change}`}
    >
      <header className="detail-head">
        <div className="title">
          <p className="name">{card.change}</p>
          <p className="meta">
            <span className="chip">{card.schema}</span>
            <span>{columnTitle}</span>
            {age !== null && <span>изменён {age}</span>}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="icon-btn"
          aria-label="Закрыть панель изменения"
          title="Закрыть (Esc)"
          onClick={onClose}
          data-testid="detail-close"
        >
          ×
        </button>
      </header>

      <div className="change-actions">
        <button type="button" className="btn" onClick={() => void validate()} data-testid="detail-validate">
          Проверить
        </button>
        <button type="button" className="btn" onClick={() => onNavigate('deltas', card.change)} data-testid="detail-deltas">
          Дельты
        </button>
        <button type="button" className="btn" onClick={() => onNavigate('metrics', card.change)} data-testid="detail-metrics">
          Метрики
        </button>
        <button type="button" className="btn" onClick={() => onNavigate('agent', card.change)} data-testid="detail-agent">
          Агент
        </button>
        <span className="spacer" />
        <button
          type="button"
          className={card.column === 'to-archive' ? 'btn primary' : 'btn'}
          onClick={() => setConfirming(true)}
          data-testid="archive"
        >
          Архивировать…
        </button>
      </div>

      {error !== null && (
        <div className="notice error" role="alert" data-testid="board-error">
          <p>{error.message}</p>
          {error.output !== '' && <pre className="diff-preview">{error.output}</pre>}
        </div>
      )}

      {confirming && (
        <div className="archive-confirm" data-testid="archive-confirm">
          <p className="pane-title">Архивация и изменения основных спеков</p>
          {unfinished > 0 && (
            <p className="notice warn">
              У изменения «{card.change}» не выполнено пунктов: {unfinished}. Архивировать всё равно?
            </p>
          )}
          <ArchivePreview change={card.change} revision={revision} onState={setPreview} />
          <div className="conflict-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!archivable || archiving}
              title={archivable ? undefined : 'Архивация станет доступна, когда предпросмотр покажет, что она пройдёт'}
              data-testid="archive-confirmed"
              onClick={() => void archive()}
            >
              {archiving ? 'Архивирую…' : 'Архивировать'}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {card.waivers.length > 0 && (
        <div className="notice info" data-testid="change-waivers">
          <span>Схема «{card.schema}» отказалась от правил SDD:</span>
          <ul className="failure-details">
            {card.waivers.map((waiver) => (
              <li key={waiver.rule}>
                <code>{waiver.rule}</code> — {waiver.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {validation !== null && (
        <div className="detail-block" data-testid="detail-validation">
          <p className="pane-title">Проверка</p>
          <Problems state={validation} onOpen={(file, line) => onOpenFile(file, line)} />
        </div>
      )}

      <div className="detail-block">
        <p className="pane-title">Артефакты</p>
        <ul className="detail-artifacts">
          {card.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <span
                className={`dot ${artifact.path === null || artifact.path === undefined ? 'missing' : artifact.done ? 'done' : 'invalid'}`}
                aria-hidden="true"
              />
              <button
                type="button"
                className="linkish"
                onClick={() => onOpenArtifact(card.change, artifact.id, artifact.path ?? null)}
                data-testid={`detail-artifact-${artifact.id}`}
              >
                {artifact.id}
              </button>
              <span className="state">{artifact.path === null || artifact.path === undefined ? 'не создан' : artifact.path.split('/').pop()}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="detail-block">
        <p className="pane-title">
          План {items !== null && items.total > 0 && <span className="count">{items.complete}/{items.total}</span>}
        </p>
        {items !== null && items.path === null ? (
          <p className="empty">Схема этого изменения не объявила отслеживаемый артефакт.</p>
        ) : items !== null && items.items.length === 0 ? (
          <p className="empty">В отслеживаемом артефакте пока нет пунктов.</p>
        ) : (
          <div data-testid="items">
            {groups.map((group) => (
              <div className="item-group" key={group.key}>
                {group.title !== null && <p className="group-title">{group.title}</p>}
                <ul className="items">
                  {group.items.map((item) => (
                    <li key={item.line}>
                      <label>
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={(event) => void toggle(item.line, event.target.checked)}
                          data-testid={`item-${item.declaredNumber ?? item.line}`}
                        />
                        {item.declaredNumber !== null && <span className="num">{item.declaredNumber}</span>}
                        <span>{item.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Пункты по группам `## N. …` в порядке файла. */
function groupItems(items: TrackedItemsResponse | null): {
  key: string;
  title: string | null;
  items: TrackedItemsResponse['items'][number][];
}[] {
  if (items === null) return [];
  const titles = new Map((items.groups ?? []).map((group) => [group.number, `${group.number}. ${group.title}`]));
  const result: { key: string; title: string | null; items: TrackedItemsResponse['items'][number][] }[] = [];
  for (const item of items.items) {
    const last = result[result.length - 1];
    if (last !== undefined && last.key === String(item.group)) {
      last.items.push(item);
    } else {
      result.push({ key: String(item.group), title: titles.get(item.group) ?? null, items: [item] });
    }
  }
  return result;
}
