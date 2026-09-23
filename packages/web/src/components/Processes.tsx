import { useCallback, useEffect, useState } from 'react';
import { ApiError, type RegistryEntry, createSchema, fetchSchemas } from '../lib/api.js';
import { SchemaDesigner } from './SchemaDesigner.js';

interface ProcessesProps {
  /** Схемы изменились на диске — счётчик событий наблюдателя. */
  readonly revision: number;
  /** Схема проекта или набор схем изменились — дереву и доске нужно перечитаться. */
  readonly onChanged: () => void;
}

function dotClass(entry: RegistryEntry): string {
  if (!entry.readable || entry.cliError !== null) return 'err';
  if (entry.conformance === null) return 'err';
  if (entry.conformance.errors > 0) return 'err';
  if (entry.conformance.warnings > 0) return 'warn';
  return 'ok';
}

function tail(entry: RegistryEntry): string {
  if (!entry.readable) return 'нечитаема';
  if (entry.cliError !== null) return 'отвергнута CLI';
  if (entry.isDefault) return 'по умолч.';
  if (entry.conformance !== null && !entry.conformance.assignable) return 'не назн.';
  return String(entry.artifacts.length);
}

export function Processes({ revision, onChanged }: ProcessesProps) {
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<{ message: string; conflict: string | null } | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await fetchSchemas();
      setEntries(result.schemas);
      setError(null);
      setSelected((current) => current ?? result.default ?? result.schemas[0]?.name ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  const create = async (from: string | null) => {
    const name = newName.trim();
    if (name === '') return;
    try {
      const created = await createSchema(name, from);
      setNewName('');
      setCreateError(null);
      await reload();
      setSelected(created.name);
      onChanged();
    } catch (caught) {
      const message = caught instanceof ApiError || caught instanceof Error ? caught.message : String(caught);
      setCreateError({
        message,
        conflict: /уже существует/.test(message) ? name : null,
      });
    }
  };

  const entry = entries?.find((item) => item.name === selected) ?? null;
  const project = entries?.filter((item) => item.source === 'project') ?? [];
  const builtIn = entries?.filter((item) => item.source === 'package') ?? [];

  return (
    <div className="processes" data-testid="processes">
      <div className="registry">
        <p className="pane-title">
          Схемы <span className="count">{entries?.length ?? 0}</span>
        </p>
        {error !== null && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {entries === null && error === null && <p className="empty">Загрузка реестра…</p>}
        {entries !== null && (
          <ul className="registry-list" data-testid="schema-registry">
            <li className="grp">Проектные · {project.length}</li>
            {project.length === 0 && (
              <li className="empty" data-testid="no-project-schemas">
                Собственных схем нет — создайте с нуля или сделайте форк встроенной.
              </li>
            )}
            {[...project, ...builtIn].map((item, index) => (
              <li key={`${item.source}-${item.name}`}>
                {index === project.length && <div className="grp">Встроенные · {builtIn.length}</div>}
                <button
                  type="button"
                  className={`node ${item.name === selected ? 'sel' : ''}`}
                  aria-current={item.name === selected}
                  data-testid={`schema-entry-${item.name}`}
                  data-readable={item.readable}
                  onClick={() => setSelected(item.name)}
                >
                  <span className={`dot ${dotClass(item)}`} />
                  <span className="nm mono">{item.name}</span>
                  {(item.conformance?.waived.length ?? 0) > 0 && (
                    <span className="waiver-mark" title={`Отказ от правил: ${item.conformance?.waived.join(', ')}`}>
                      ⊘
                    </span>
                  )}
                  <span className="tail">{tail(item)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {entry !== null && (
          <>
            <p className="pane-title" style={{ marginTop: 18 }}>
              Разрешение
            </p>
            <ul className="kv" data-testid="schema-resolution">
              <li>
                <span className="k">Источник</span>
                <span className="v">{entry.source === 'project' ? 'проект' : 'пакет OpenSpec'}</span>
              </li>
              <li>
                <span className="k">Путь</span>
                <span className="v mono path">{entry.path}</span>
              </li>
              <li>
                <span className="k">Затеняет</span>
                <span className="v" data-testid="schema-shadows">
                  {entry.shadows.length === 0
                    ? '—'
                    : entry.shadows.map((shadow) => `${shadow.source === 'package' ? 'встроенную' : shadow.source}: ${shadow.path}`).join('; ')}
                </span>
              </li>
              <li>
                <span className="k">Артефактов</span>
                <span className="v">{entry.artifacts.length}</span>
              </li>
              {(entry.conformance?.waived.length ?? 0) > 0 && (
                <li data-testid="schema-waived">
                  <span className="k">Отказы SDD</span>
                  <span className="v mono">{entry.conformance?.waived.join(', ')}</span>
                </li>
              )}
            </ul>
            {entry.parseError !== null && (
              <p className="notice error" data-testid="schema-parse-error">
                Схема не разбирается: {entry.parseError}
              </p>
            )}
            {entry.cliError !== null && (
              <p className="notice error" data-testid="schema-cli-error">
                CLI OpenSpec не принял схему: {entry.cliError}
              </p>
            )}
          </>
        )}

        <p className="pane-title" style={{ marginTop: 18 }}>
          Новая схема
        </p>
        <form
          className="create-schema"
          onSubmit={(event) => {
            event.preventDefault();
            void create(null);
          }}
        >
          <input
            aria-label="Имя новой схемы"
            placeholder="имя-схемы"
            value={newName}
            onChange={(event) => {
              setNewName(event.target.value);
              setCreateError(null);
            }}
          />
          <button type="submit" className="btn" disabled={newName.trim() === ''}>
            Создать с нуля
          </button>
          {entry !== null && entry.readable && (
            <button
              type="button"
              className="btn"
              disabled={newName.trim() === ''}
              onClick={() => void create(entry.name)}
            >
              Форк {entry.name}
            </button>
          )}
        </form>
        {createError !== null && (
          <div className="notice error" role="alert" data-testid="create-error">
            <span>{createError.message}</span>
            {createError.conflict !== null && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSelected(createError.conflict);
                  setCreateError(null);
                }}
              >
                Открыть {createError.conflict}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="designer-host">
        {selected === null ? (
          <p className="empty">Выберите схему в реестре.</p>
        ) : (
          <SchemaDesigner
            key={selected}
            name={selected}
            onChanged={() => {
              void reload();
              onChanged();
            }}
          />
        )}
      </div>
    </div>
  );
}
