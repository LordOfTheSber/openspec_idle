import { useCallback, useEffect, useState } from 'react';
import { groupModules, matchesModuleFilter, type ModuleDef, type TreeSchema } from '@openspec-ide/core';
import {
  archiveChange,
  createChange,
  fetchBoard,
  fetchItems,
  toggleItem,
  type ModuleBoard,
  type TrackedItemsResponse,
} from '../lib/api.js';

const COLUMN_TITLE: Record<string, string> = {
  ready: 'Готово к работе',
  'in-progress': 'В работе',
  'to-archive': 'Готово к архивации',
};

export function Board({
  schemas,
  modules,
  moduleFilter,
  revision,
  onChanged,
}: {
  readonly schemas: readonly TreeSchema[];
  readonly modules: readonly ModuleDef[];
  readonly moduleFilter: readonly string[];
  /** Счётчик изменений на диске: доска перечитывается. */
  readonly revision: number;
  readonly onChanged: () => void;
}) {
  const [board, setBoard] = useState<ModuleBoard | null>(null);
  const [newModules, setNewModules] = useState<readonly string[]>([]);
  const [error, setError] = useState<{ message: string; output: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<TrackedItemsResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSchema, setNewSchema] = useState('');
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
    } catch (problem) {
      setError({
        message: problem instanceof Error ? problem.message : String(problem),
        output: '',
      });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  useEffect(() => {
    if (selected === null) {
      setItems(null);
      return;
    }
    void fetchItems(selected).then(setItems);
  }, [selected]);

  /**
   * Переключает пункт сразу, не дожидаясь ответа сервера.
   *
   * Без этого чекбокс не реагирует на клик всё время запроса: он управляемый,
   * а состояние приходит только с ответом. При отказе отметка возвращается на
   * место, а причина показывается.
   */
  async function toggle(change: string, line: number, done: boolean): Promise<void> {
    const previous = items;
    setItems((current) =>
      current === null
        ? current
        : {
            ...current,
            items: current.items.map((item) =>
              item.line === line ? { ...item, done } : item,
            ),
            complete: current.complete + (done ? 1 : -1),
          },
    );

    try {
      setItems(await toggleItem(change, line, done));
      await reload();
      onChanged();
    } catch (problem) {
      setItems(previous);
      const payload = problem as { message?: string; output?: string };
      setError({
        message: payload.message ?? String(problem),
        output: typeof payload.output === 'string' ? payload.output : '',
      });
    }
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      await reload();
      onChanged();
    } catch (problem) {
      const payload = problem as { message?: string; output?: string };
      setError({
        message: payload.message ?? String(problem),
        output: typeof payload.output === 'string' ? payload.output : '',
      });
    }
  }

  if (board === null && error === null) return <p className="empty">Загрузка доски…</p>;

  const card = selected === null ? null : board?.cards.find((item) => item.change === selected);
  const unfinished = items === null ? 0 : items.total - items.complete;

  return (
    <div className="board-pane">
      <div className="board-toolbar">
        <button
          type="button"
          className="btn primary"
          onClick={() => setCreating((value) => !value)}
          data-testid="new-change"
        >
          Новое изменение
        </button>
        <span className="crumbs">
          фаза выводится из файлов — карточку нельзя перетащить вручную
        </span>
      </div>

      {creating && (
        <form
          className="new-change-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => createChange(newName, newSchema === '' ? undefined : newSchema, newModules)).then(
              () => {
                setNewName('');
                setNewModules([]);
                setCreating(false);
              },
            );
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
          {modules.length > 0 && (
            <fieldset className="new-change-modules" data-testid="new-change-modules">
              <legend>Модули change — запишутся в .openspec.yaml; несколько — сквозной change</legend>
              {groupModules(modules).map((group) => (
                <span key={group.title} className="module-group">
                  <span className="muted">{group.title}:</span>
                  {group.modules.map((module) => (
                    <label key={module.id}>
                      <input
                        type="checkbox"
                        checked={newModules.includes(module.id)}
                        onChange={(event) =>
                          setNewModules((current) =>
                            event.target.checked ? [...current, module.id] : current.filter((id) => id !== module.id),
                          )
                        }
                        data-testid={`new-change-module-${module.id}`}
                      />
                      <span className="mono">{module.id}</span>
                    </label>
                  ))}
                </span>
              ))}
            </fieldset>
          )}
        </form>
      )}

      {error !== null && (
        <div className="notice error" role="alert" data-testid="board-error">
          <p>{error.message}</p>
          {error.output !== '' && <pre className="diff-preview">{error.output}</pre>}
        </div>
      )}

      {board !== null && (
        <div className="board" data-testid="board">
          {board.columns.map((column) => {
            const cards = board.cards.filter(
              (item) => item.column === column.id && matchesModuleFilter(item.modules, moduleFilter),
            );
            return (
              <div className="col" key={column.id} data-testid={`column-${column.id}`}>
                <header>
                  <h3>{COLUMN_TITLE[column.id] ?? column.id}</h3>
                  <span className="n">{cards.length}</span>
                </header>
                {cards.map((item) => (
                  <button
                    type="button"
                    className={`card ${selected === item.change ? 'lift' : ''}`}
                    key={item.change}
                    onClick={() => setSelected(item.change)}
                    data-testid={`card-${item.change}`}
                  >
                    <h4>{item.change}</h4>
                    {item.modules.length > 0 && (
                      <div className="chips modules" data-testid="card-modules">
                        {item.modules.map((id) => (
                          <span key={id} className="chip module">
                            {id}
                          </span>
                        ))}
                        {item.modules.length > 1 && <span className="chip warn">сквозной</span>}
                      </div>
                    )}
                    <div className="chips">
                      <span className="chip">{item.schema}</span>
                      {item.waivers.length > 0 && (
                        <span
                          className="chip warn"
                          data-testid="card-waiver"
                          title={item.waivers.map((waiver) => `${waiver.rule}: ${waiver.reason}`).join('\n')}
                        >
                          ⊘ отказ SDD
                        </span>
                      )}
                      {item.artifacts.map((artifact) => (
                        <span
                          key={artifact.id}
                          className={artifact.done ? 'chip on' : 'chip no'}
                        >
                          {artifact.id}
                        </span>
                      ))}
                    </div>
                    {item.progress !== null && item.progress.total > 0 && (
                      <div className="meter">
                        <i
                          style={{
                            width: `${Math.round(
                              (item.progress.complete / item.progress.total) * 100,
                            )}%`,
                          }}
                        />
                      </div>
                    )}
                    <div className="foot">
                      <span>
                        {item.progress === null || item.progress.total === 0
                          ? 'нет пунктов'
                          : `${item.progress.complete}/${item.progress.total} пунктов`}
                      </span>
                      <span className={item.errorCount > 0 ? 'err' : 'ok'}>
                        {item.validationUnknown
                          ? 'не проверялся'
                          : item.errorCount > 0
                            ? `${item.errorCount} ош.`
                            : 'валиден'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {card !== undefined && card !== null && (
        <section className="change-detail" data-testid="change-detail">
          <p className="pane-title">
            {card.change} <span className="count">{card.schema}</span>
          </p>

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

          <div className="change-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setConfirmArchive(card.change)}
              data-testid="archive"
            >
              Архивировать
            </button>
          </div>

          {confirmArchive === card.change && (
            <div className="notice error" data-testid="archive-confirm">
              <p>
                {unfinished > 0
                  ? `У изменения «${card.change}» не выполнено пунктов: ${unfinished}. Архивировать всё равно?`
                  : `Архивировать изменение «${card.change}»?`}
              </p>
              <div className="conflict-actions">
                <button
                  type="button"
                  className="btn primary"
                  data-testid="archive-confirmed"
                  onClick={() => {
                    setConfirmArchive(null);
                    void run(() => archiveChange(card.change)).then(() => setSelected(null));
                  }}
                >
                  Архивировать
                </button>
                <button type="button" className="btn" onClick={() => setConfirmArchive(null)}>
                  Отмена
                </button>
              </div>
            </div>
          )}

          {items !== null && items.path === null ? (
            <p className="empty">Схема этого изменения не объявила отслеживаемый артефакт.</p>
          ) : (
            <ul className="items" data-testid="items">
              {items?.items.map((item) => (
                <li key={item.line}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={(event) =>
                        void toggle(card.change, item.line, event.target.checked)
                      }
                      data-testid={`item-${item.declaredNumber ?? item.line}`}
                    />
                    {item.declaredNumber !== null && (
                      <span className="num">{item.declaredNumber}</span>
                    )}
                    <span>{item.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
