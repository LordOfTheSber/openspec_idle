import { useEffect, useRef, useState } from 'react';
import type { BoardCard, DeltaView } from '@openspec-ide/core';
import {
  type TrackedItemsResponse,
  type TraceResponse,
  archiveChange,
  fetchDeltas,
  fetchItems,
  fetchTrace,
  fetchValidation,
  toggleItem,
} from '../lib/api.js';
import { formatAge, plural } from '../lib/format.js';
import { readiness } from '../lib/readiness.js';
import { buildThread } from '../lib/thread.js';
import { ArchivePreview, type PreviewState } from './ArchivePreview.js';
import type { BoardProps } from './Board.js';
import { Icon } from './Icon.js';
import { Problems, type ValidationState } from './Problems.js';
import { Thread } from './Thread.js';

/** С чем открыта панель: просто детали, сразу проверка или сразу архивация. */
export type DetailIntent = 'none' | 'validate' | 'archive';

type DetailTab = 'overview' | 'plan' | 'checks';

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
  const [tab, setTab] = useState<DetailTab>(intent === 'validate' ? 'checks' : 'overview');
  const [items, setItems] = useState<TrackedItemsResponse | null>(null);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [deltas, setDeltas] = useState<readonly DeltaView[] | null>(null);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [confirming, setConfirming] = useState(intent === 'archive');
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' });
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<{ message: string; output: string } | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string> | null>(null);
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
    void fetchTrace(card.change)
      .then((result) => {
        if (current) setTrace(result);
      })
      .catch(() => undefined);
    void fetchDeltas(card.change)
      .then((result) => {
        if (current) setDeltas(result.views);
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
    setTab('checks');
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
  const thread = buildThread(card);
  const validationErrors =
    validation !== null && !validation.running && validation.error === null
      ? validation.entries.filter((entry) => entry.level === 'ERROR').length
      : card.validationUnknown
        ? null
        : card.errorCount;
  const coverage =
    trace === null ? null : { covered: trace.trace.covered.length, total: trace.trace.scenarios.length };
  const ready = readiness({
    artifacts: { done: card.artifacts.filter((artifact) => artifact.done).length, total: card.artifacts.length },
    plan: items === null ? card.progress : items.path === null ? null : { complete: items.complete, total: items.total },
    validationErrors,
    coverage,
    preview: preview.kind === 'done' ? preview.preview.outcome : null,
  });
  const isOpen = (key: string): boolean => openGroups?.has(key) ?? true;

  return (
    <section
      className={`change-detail ${overlay ? 'overlay' : 'side'}`}
      data-testid="change-detail"
      aria-label={`Изменение ${card.change}`}
    >
      <header className="detail-head">
        <div className="detail-title">
          <h2 className="mono">{card.change}</h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Закрыть панель изменения"
            title="Закрыть (Esc)"
            onClick={onClose}
            data-testid="detail-close"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="detail-chips">
          <span className={card.column === 'to-archive' ? 'chip ok' : 'chip'}>
            <span className="dot" aria-hidden="true" />
            {columnTitle}
          </span>
          <span className="chip">
            <Icon name="workflow" size={12} />
            {card.schema}
          </span>
          {age !== null && (
            <span className="chip">
              <Icon name="clock" size={12} />
              изменён {age}
            </span>
          )}
        </div>
        <div className="detail-thread">
          <Thread card={card} thread={thread} labels onOpen={(id, path) => onOpenArtifact(card.change, id, path)} />
        </div>
        <div className="change-actions">
          <button
            type="button"
            className={card.column === 'to-archive' ? 'btn primary' : 'btn'}
            onClick={() => setConfirming(true)}
            data-testid="archive"
          >
            <Icon name="archive" size={15} />
            Архивировать…
          </button>
          <button type="button" className="btn" onClick={() => void validate()} data-testid="detail-validate">
            <Icon name="check" size={15} />
            Проверить
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn"
            aria-label="Дельты"
            title="Дельты этого change"
            onClick={() => onNavigate('deltas', card.change)}
            data-testid="detail-deltas"
          >
            <Icon name="diff" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Метрики"
            title="Метрики этого change"
            onClick={() => onNavigate('metrics', card.change)}
            data-testid="detail-metrics"
          >
            <Icon name="chart" />
          </button>
        </div>
        <div className="tabs" role="tablist" aria-label="Разделы изменения">
          <button type="button" role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')} data-testid="detail-tab-overview">
            Обзор
          </button>
          <button type="button" role="tab" aria-selected={tab === 'plan'} onClick={() => setTab('plan')} data-testid="detail-tab-plan">
            План
            {items !== null && items.total > 0 && (
              <span className={items.complete === items.total ? 'badge ok' : 'badge'}>
                {items.complete}/{items.total}
              </span>
            )}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'checks'} onClick={() => setTab('checks')} data-testid="detail-tab-checks">
            Проверка
            {validationErrors !== null && validationErrors > 0 && <span className="badge bad">{validationErrors}</span>}
          </button>
          <button type="button" role="tab" aria-selected={false} onClick={() => onNavigate('trace', card.change)} data-testid="detail-trace">
            Трассировка
            {coverage !== null && coverage.total > 0 && (
              <span className={coverage.covered === coverage.total ? 'badge ok' : 'badge warn'}>
                {coverage.covered}/{coverage.total}
              </span>
            )}
          </button>
        </div>
      </header>

      <div className="detail-body">
        {error !== null && (
          <div className="notice error" role="alert" data-testid="board-error">
            <p>{error.message}</p>
            {error.output !== '' && <pre className="diff-preview">{error.output}</pre>}
          </div>
        )}

        {confirming && (
          <div className="archive-confirm" data-testid="archive-confirm">
            <p className="section-label">Архивация и изменения основных спеков</p>
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

        {tab === 'overview' && (
          <>
            <div className="readiness" data-testid="readiness">
              <Ring passed={ready.passed} total={ready.checks.length} />
              <div className="readiness-body">
                <b>
                  {ready.passed === ready.checks.length ? 'Готов к архивации' : 'Готовность к архивации'} · {ready.passed} из{' '}
                  {ready.checks.length}
                </b>
                <ul>
                  {ready.checks.map((check) => (
                    <li key={check.id} className={`status ${check.state === 'ok' ? 'ok' : check.state === 'fail' ? 'warn' : 'unknown'}`} data-testid={`readiness-${check.id}`}>
                      <Icon name={check.state === 'ok' ? 'check' : check.state === 'fail' ? 'alert' : 'circle'} size={13} />
                      <span className="t">{check.label}</span>
                      <span className="d">{check.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="detail-block">
              <p className="section-label">
                Артефакты{' '}
                <span className={thread.next === null ? 'badge ok' : 'badge'}>
                  {card.artifacts.filter((artifact) => artifact.done).length}/{card.artifacts.length}
                </span>
              </p>
              <ul className="detail-rows">
                {card.artifacts.map((artifact) => {
                  const missing = artifact.path === null || artifact.path === undefined;
                  return (
                    <li key={artifact.id}>
                      <button
                        type="button"
                        className="detail-row row-hover"
                        onClick={() => onOpenArtifact(card.change, artifact.id, artifact.path ?? null)}
                        data-testid={`detail-artifact-${artifact.id}`}
                      >
                        <Icon
                          name={missing ? 'circle' : 'checkCircle'}
                          className={missing ? 'muted' : 'ok-icon'}
                          size={16}
                        />
                        <span className="name">{artifact.id}</span>
                        <span className="spacer" />
                        <span className="mono muted small">{missing ? 'не создан' : artifact.path?.split('/').pop()}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            {deltas !== null && deltas.length > 0 && (
              <div className="detail-block">
                <p className="section-label">
                  Меняет спеки <span className="badge">{deltas.length}</span>
                </p>
                <ul className="detail-rows">
                  {deltas.map((view) => (
                    <li key={view.capability}>
                      <button type="button" className="detail-row row-hover" onClick={() => onNavigate('deltas', card.change)}>
                        <Icon name="spec" size={16} className="muted" />
                        <span className="mono name">{view.capability}</span>
                        <span className="spacer" />
                        {view.groups.map((group) => (
                          <span key={group.operation} className={`chip ${OPERATION_CHIP[group.operation]}`}>
                            {OPERATION_GLYPH[group.operation]}
                            {group.requirements.length}
                          </span>
                        ))}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {tab === 'plan' && (
          <div className="detail-block">
            {items !== null && items.path === null ? (
              <p className="empty">Схема этого изменения не объявила отслеживаемый артефакт.</p>
            ) : items !== null && items.items.length === 0 ? (
              <p className="empty">В отслеживаемом артефакте пока нет пунктов.</p>
            ) : (
              <div data-testid="items">
                {groups.map((group) => {
                  const done = group.items.filter((item) => item.done).length;
                  const open = isOpen(group.key);
                  return (
                    <div className="item-group" key={group.key}>
                      {group.title !== null && (
                        <button
                          type="button"
                          className="group-title"
                          aria-expanded={open}
                          onClick={() =>
                            setOpenGroups((current) => {
                              const next = new Set(current ?? groups.map((entry) => entry.key));
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            })
                          }
                        >
                          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                          <span>{group.title}</span>
                          <span className={done === group.items.length ? 'badge ok' : 'badge'}>
                            {done}/{group.items.length}
                          </span>
                        </button>
                      )}
                      {open && (
                        <ul className="items">
                          {group.items.map((item) => (
                            <li key={item.line}>
                              <label className="row-hover">
                                <input
                                  type="checkbox"
                                  checked={item.done}
                                  onChange={(event) => void toggle(item.line, event.target.checked)}
                                  data-testid={`item-${item.declaredNumber ?? item.line}`}
                                />
                                {item.declaredNumber !== null && <span className="num mono">{item.declaredNumber}</span>}
                                <span>{item.text}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'checks' && (
          <div className="detail-block checks">
            <div className="check-card" data-testid="detail-validation">
              <div className="check-head">
                <Icon
                  name={validationErrors === null ? 'circle' : validationErrors === 0 ? 'checkCircle' : 'error'}
                  size={18}
                  className={validationErrors === null ? 'muted' : validationErrors === 0 ? 'ok-icon' : 'bad-icon'}
                />
                <div className="check-text">
                  <b>Валидация</b>
                  <span className="muted small mono">openspec validate --strict</span>
                </div>
                <button type="button" className="btn small" onClick={() => void validate()}>
                  <Icon name="refresh" size={13} />
                  {validation === null ? 'Запустить' : 'Повторить'}
                </button>
              </div>
              {validation !== null ? (
                <Problems state={validation} onOpen={(file, line) => onOpenFile(file, line)} />
              ) : (
                <p className="empty">
                  {card.validationUnknown
                    ? 'Проверка ещё не выполнялась.'
                    : card.errorCount > 0
                      ? `При последней проверке: ${plural(card.errorCount, ['ошибка', 'ошибки', 'ошибок'])}.`
                      : 'Последняя проверка прошла без ошибок.'}
                </p>
              )}
            </div>
            <div className="check-card">
              <div className="check-head">
                <Icon name="compare" size={18} className="muted" />
                <div className="check-text">
                  <b>Предпросмотр архивации</b>
                  <span className="muted small">прогон CLI на временной копии проекта</span>
                </div>
                {!previewing && !confirming && (
                  <button type="button" className="btn small" onClick={() => setPreviewing(true)} data-testid="detail-preview">
                    Построить
                  </button>
                )}
              </div>
              {previewing && !confirming && <ArchivePreview change={card.change} revision={revision} onState={setPreview} />}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const OPERATION_CHIP: Record<string, string> = { ADDED: 'ok', MODIFIED: 'warn', REMOVED: 'bad', RENAMED: 'info' };
const OPERATION_GLYPH: Record<string, string> = { ADDED: '+', MODIFIED: '~', REMOVED: '−', RENAMED: '→' };

/** Кольцо готовности: доля выполненных условий. */
function Ring({ passed, total }: { readonly passed: number; readonly total: number }) {
  const radius = 21;
  const length = 2 * Math.PI * radius;
  const complete = passed === total;
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" className="ring" aria-hidden="true">
      <circle cx="26" cy="26" r={radius} className="ring-track" />
      <circle
        cx="26"
        cy="26"
        r={radius}
        className={complete ? 'ring-value complete' : 'ring-value'}
        strokeDasharray={`${(length * passed) / Math.max(1, total)} ${length}`}
        transform="rotate(-90 26 26)"
      />
      {complete ? (
        <path d="m19 26.5 4.5 4.5 9-9.5" className="ring-check" />
      ) : (
        <text x="26" y="27" textAnchor="middle" dominantBaseline="middle" className="ring-text">
          {passed}/{total}
        </text>
      )}
    </svg>
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
