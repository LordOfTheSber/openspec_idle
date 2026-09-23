import {
  SDD_RULES,
  type SchemaField,
  type Violation,
  addArtifact,
  checkConformance,
  dependentsOf,
  previewSchema,
  removeArtifact,
  removeWaiver,
  setWaiver,
  updateApply,
  updateArtifact,
} from '@openspec-ide/core';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ApiError,
  type SchemaCheck,
  type SchemaSource,
  assignSchema,
  checkSchema,
  fetchSchema,
  fetchSchemaTemplate,
  saveSchema,
  saveSchemaTemplate,
} from '../lib/api.js';
import { designerReducer, initialDesigner, isDirty } from '../lib/designerState.js';
import { plural } from '../lib/format.js';
import { formatProblem } from '../lib/schemaYaml.js';
import { Editor } from './Editor.js';
import { SchemaGraph } from './SchemaGraph.js';

interface SchemaDesignerProps {
  readonly name: string;
  /** Схема сохранена или назначена — реестр нужно перечитать. */
  readonly onChanged: () => void;
}

interface Failure {
  readonly message: string;
  readonly details: readonly string[];
}

function failure(error: unknown): Failure {
  if (error instanceof ApiError) return { message: error.message, details: error.details };
  return { message: error instanceof Error ? error.message : String(error), details: [] };
}

const LEVEL_MARK: Record<string, string> = { error: '✕', warning: '⚠' };
const LEVEL_TEXT: Record<string, string> = { error: 'ошибка', warning: 'предупреждение' };

export function SchemaDesigner({ name, onChanged }: SchemaDesignerProps) {
  const [state, dispatch] = useReducer(designerReducer, initialDesigner(name, ''));
  const [source, setSource] = useState<SchemaSource | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [check, setCheck] = useState<SchemaCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [saveError, setSaveError] = useState<Failure | null>(null);
  const [assignOutcome, setAssignOutcome] = useState<
    { ok: true; text: string; warnings: readonly string[] } | { ok: false; failure: Failure } | null
  >(null);
  const [focusField, setFocusField] = useState<{ field: SchemaField; tick: number } | null>(null);

  const readOnly = source?.readOnly ?? true;
  const dirty = isDirty(state);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      setCheck(await checkSchema(name));
    } catch {
      setCheck(null);
    } finally {
      setChecking(false);
    }
  }, [name]);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setCheck(null);
    setAssignOutcome(null);
    setSaveError(null);
    fetchSchema(name)
      .then((loaded) => {
        if (cancelled) return;
        setSource(loaded);
        setLoadError(null);
        dispatch({ type: 'load', name, text: loaded.text });
        if (loaded.document !== null) void runCheck();
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(failure(error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [name, runCheck]);

  // Слой SDD считается на лету по текущему (в том числе несохранённому)
  // состоянию; структурный слой — только по сохранённому файлу, это CLI.
  const report = useMemo(
    () => (state.document === null ? null : checkConformance(state.document)),
    [state.document],
  );
  const preview = useMemo(
    () => (state.document === null ? null : previewSchema(state.document)),
    [state.document],
  );
  const failing = useMemo(
    () =>
      new Set(
        (report?.violations ?? [])
          .filter((violation) => violation.level === 'error' && violation.artifact !== null)
          .map((violation) => violation.artifact as string),
      ),
    [report],
  );

  const save = useCallback(async () => {
    if (state.stale || readOnly) return;
    try {
      const saved = await saveSchema(name, state.text);
      dispatch({ type: 'saved', text: state.text });
      setSource(saved);
      setSaveError(null);
      onChanged();
      void runCheck();
    } catch (error) {
      setSaveError(failure(error));
    }
  }, [name, state.stale, state.text, readOnly, onChanged, runCheck]);

  const assign = useCallback(async () => {
    try {
      const result = await assignSchema(name);
      const kept =
        result.activeChanges === 0
          ? 'Активных changes нет.'
          : `Активные changes (${result.activeChanges}) остаются на своих схемах — новая схема применится только к новым changes.`;
      const pinned =
        result.pinned.length === 0 ? '' : ` Прежняя схема записана явно в: ${result.pinned.join(', ')}.`;
      setAssignOutcome({
        ok: true,
        text: `Схема «${name}» назначена проекту. ${kept}${pinned}`,
        warnings: result.warnings,
      });
      onChanged();
    } catch (error) {
      setAssignOutcome({ ok: false, failure: failure(error) });
    }
  }, [name, onChanged]);

  const jumpTo = useCallback((violation: { artifact: string | null; field: SchemaField | null }) => {
    if (violation.artifact !== null) dispatch({ type: 'select', artifact: violation.artifact });
    if (violation.field !== null) setFocusField((current) => ({ field: violation.field!, tick: (current?.tick ?? 0) + 1 }));
  }, []);

  if (loadError !== null) {
    return (
      <p className="notice error" role="alert">
        {loadError}
      </p>
    );
  }
  if (source === null) return <p className="empty">Загрузка схемы…</p>;

  const document = state.document;
  const selectedArtifact = document?.artifacts.find((artifact) => artifact.id === state.selected) ?? null;

  return (
    <div className="designer" data-testid="schema-designer">
      <div className="designer-bar">
        <span className="mono designer-name">{name}</span>
        <span className="chip">{source.source === 'project' ? 'проектная' : 'встроенная'}</span>
        {dirty && (
          <span className="chip warn" data-testid="schema-dirty">
            не сохранено
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn primary"
          disabled={readOnly || state.stale || !dirty}
          title={state.stale ? 'YAML не разбирается — исправьте ошибку' : undefined}
          onClick={() => void save()}
          data-testid="schema-save"
        >
          Сохранить
        </button>
        <button
          type="button"
          className="btn"
          disabled={dirty}
          title={dirty ? 'Сначала сохраните схему — назначается файл на диске' : undefined}
          onClick={() => void assign()}
          data-testid="schema-assign"
        >
          Назначить проекту
        </button>
      </div>

      {readOnly && (
        <p className="notice info">
          Встроенная схема из пакета OpenSpec не правится. Сделайте её форк — копия станет проектной и
          откроется для правки.
        </p>
      )}
      {state.stale && state.yamlError !== null && (
        <p className="notice error" role="alert" data-testid="yaml-error">
          YAML не разбирается ({formatProblem(state.yamlError)}). Граф и форма показывают последнее корректное
          состояние, сохранение заблокировано.
        </p>
      )}
      {state.editError !== null && (
        <p className="notice error" role="alert">
          {state.editError}
        </p>
      )}
      {saveError !== null && <FailureNotice failure={saveError} testId="schema-save-error" />}
      {assignOutcome !== null &&
        (assignOutcome.ok ? (
          <div className="notice ok" data-testid="assign-result">
            <span>{assignOutcome.text}</span>
            {assignOutcome.warnings.length > 0 && (
              <>
                <span> Предупреждения SDD назначению не мешают, но их стоит устранить:</span>
                <ul className="failure-details" data-testid="assign-warnings">
                  {assignOutcome.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <FailureNotice failure={assignOutcome.failure} testId="assign-result" />
        ))}

      <div className="designer-grid">
        <div className="designer-main">
          <p className="pane-title">
            Граф артефактов{' '}
            {state.stale && (
              <span className="count stale-mark" data-testid="graph-stale">
                устарело
              </span>
            )}
          </p>
          {document === null ? (
            <p className="empty">Схема ещё ни разу не разобралась — исправьте YAML.</p>
          ) : (
            <div className="graph-scroll">
              <SchemaGraph
                document={document}
                selected={state.selected}
                failing={failing}
                tracked={preview?.trackedArtifact ?? null}
                stale={state.stale}
                onSelect={(id) => {
                  setFocusField(null);
                  dispatch({ type: 'select', artifact: id });
                }}
              />
            </div>
          )}
          <div className="legend">
            <span>
              <i className="contract" /> порождает дельты спеков
            </span>
            <span>
              <i className="tracked" /> apply.tracks — по нему считается прогресс
            </span>
            <span>
              <i className="failing" /> нарушение SDD
            </span>
          </div>

          {document !== null && !readOnly && (
            <AddArtifact
              artifacts={document.artifacts.map((artifact) => artifact.id)}
              disabled={state.stale}
              onAdd={(id, requires) =>
                dispatch({
                  type: 'edit-model',
                  change: (current) => addArtifact(current, { id, requires }),
                  select: id.trim(),
                })
              }
            />
          )}

          <p className="pane-title" style={{ marginTop: 16 }}>
            YAML схемы <span className="count">синхронен с графом и формой</span>
          </p>
          <div className="yaml-editor">
            <Editor
              content={state.text}
              documentKey={state.textRevision}
              onChange={(text) => {
                if (!readOnly) dispatch({ type: 'edit-text', text });
              }}
              onSave={() => void save()}
              openspecFormat={false}
              revealLine={null}
              plain
              label="schema-yaml"
            />
          </div>

          {preview !== null && (
            <>
              <p className="pane-title" style={{ marginTop: 16 }}>
                Предпросмотр процесса <span className="count">колонки доски</span>
              </p>
              <div className="preview-cols" data-testid="schema-preview">
                {preview.columns.map((column) => (
                  <div
                    key={column}
                    className={`pcol ${column === preview.trackedArtifact ? 'tracked' : ''} ${
                      preview.order.includes(column) ? '' : 'work'
                    }`}
                  >
                    <b>{column}</b>
                    <span>
                      {column === preview.trackedArtifact
                        ? 'отслеживается'
                        : preview.order.includes(column)
                          ? (document?.artifacts.find((artifact) => artifact.id === column)?.generates ?? '')
                          : 'колонка работы'}
                    </span>
                  </div>
                ))}
              </div>
              {preview.warning !== null && (
                <p className="notice info" data-testid="preview-warning">
                  {preview.warning}
                </p>
              )}
            </>
          )}
        </div>

        <div className="designer-side">
          {document !== null && selectedArtifact !== null && (
            <ArtifactForm
              key={selectedArtifact.id}
              schema={name}
              artifact={selectedArtifact}
              others={document.artifacts.map((artifact) => artifact.id).filter((id) => id !== selectedArtifact.id)}
              dependents={dependentsOf(document, selectedArtifact.id)}
              templates={source.templates}
              disabled={readOnly || state.stale}
              readOnly={readOnly}
              focusField={focusField}
              onChange={(patch) =>
                dispatch({
                  type: 'edit-model',
                  change: (current) => updateArtifact(current, selectedArtifact.id, patch),
                  select: patch.id === undefined ? undefined : patch.id.trim(),
                })
              }
              onRemove={() =>
                dispatch({
                  type: 'edit-model',
                  change: (current) => removeArtifact(current, selectedArtifact.id),
                  select: null,
                })
              }
              onTemplateSaved={() => {
                void fetchSchema(name).then((loaded) => setSource({ ...loaded, text: source.text }));
                void runCheck();
              }}
            />
          )}

          {document !== null && (
            <ApplyForm
              apply={document.apply}
              artifacts={document.artifacts.map((artifact) => ({ id: artifact.id, generates: artifact.generates }))}
              disabled={readOnly || state.stale}
              focusField={focusField}
              onChange={(patch) => dispatch({ type: 'edit-model', change: (current) => updateApply(current, patch) })}
            />
          )}

          {document !== null && (
            <Waivers
              waivers={document.waivers}
              disabled={readOnly || state.stale}
              focusField={focusField}
              onSet={(rule, reason) => dispatch({ type: 'edit-model', change: (current) => setWaiver(current, rule, reason) })}
              onRemove={(rule) => dispatch({ type: 'edit-model', change: (current) => removeWaiver(current, rule) })}
            />
          )}

          {report !== null && (
            <section data-testid="sdd-report">
              <p className="pane-title" style={{ marginTop: 16 }}>
                Соответствие SDD{' '}
                <span className="count">
                  {report.errors === 0 && report.warnings === 0
                    ? 'без замечаний'
                    : [
                        report.errors > 0 ? plural(report.errors, ['ошибка', 'ошибки', 'ошибок']) : '',
                        report.warnings > 0
                          ? plural(report.warnings, ['предупреждение', 'предупреждения', 'предупреждений'])
                          : '',
                      ]
                        .filter((item) => item !== '')
                        .join(', ')}
                </span>
              </p>
              <ul className="rules">
                {report.violations.map((violation, index) => (
                  <ViolationRow key={`${violation.rule}-${index}`} violation={violation} onJump={jumpTo} />
                ))}
                {report.waived.map((item) => (
                  <li key={`waived-${item.rule.id}`} className="waived" data-testid={`waived-${item.rule.id}`}>
                    <span className="m">⊘</span>
                    <span className="body">
                      {item.rule.title} — отклонено схемой
                      <span className="rid">
                        {item.rule.id} · причина: {item.reason}
                      </span>
                    </span>
                  </li>
                ))}
                {report.passed.map((rule) => (
                  <li key={`passed-${rule.id}`} className="done" data-testid={`passed-${rule.id}`}>
                    <span className="m pass">✓</span>
                    <span className="body">
                      {rule.title}
                      <span className="rid">{rule.id}</span>
                    </span>
                  </li>
                ))}
                {report.notApplicable.map((item) => (
                  <li key={`na-${item.rule.id}`} className="done">
                    <span className="m">–</span>
                    <span className="body">
                      {item.rule.title} — не применимо
                      <span className="rid">
                        {item.rule.id} · {item.reason}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section data-testid="structural-report">
            <p className="pane-title" style={{ marginTop: 16 }}>
              Структура <span className="count">openspec schema validate</span>
            </p>
            {dirty && <p className="hint">Проверка идёт по сохранённому файлу — сохраните правки, чтобы обновить её.</p>}
            {checking ? (
              <p className="empty">Проверка…</p>
            ) : check === null ? (
              <p className="empty">Структурная проверка не выполнялась.</p>
            ) : check.structural.issues.length === 0 ? (
              <p className="notice ok" data-testid="structural-ok">
                Структурная проверка пройдена.
              </p>
            ) : (
              <ul className="rules">
                {check.structural.issues.map((issue, index) => (
                  <li key={index} data-testid="structural-issue">
                    <span className={`m ${issue.level === 'error' ? 'err' : 'warn'}`}>{LEVEL_MARK[issue.level] ?? '•'}</span>
                    <span className="body">
                      {issue.artifact !== undefined ? (
                        <button
                          type="button"
                          className="linklike"
                          onClick={() => jumpTo({ artifact: issue.artifact ?? null, field: null })}
                        >
                          {issue.message}
                        </button>
                      ) : (
                        issue.message
                      )}
                      <span className="rid">структура · {LEVEL_TEXT[issue.level] ?? issue.level}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {check !== null && !dirty && (
              <p
                className={`notice ${check.assignable ? 'ok' : 'error'}`}
                data-testid="assignable"
                data-assignable={check.assignable}
              >
                {check.assignable
                  ? 'Оба слоя проверки пройдены — схема готова к назначению.'
                  : 'Назначение заблокировано: исправьте ошибки структуры и SDD или объявите отказ от правила с причиной.'}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function FailureNotice({ failure: item, testId }: { failure: Failure; testId: string }) {
  return (
    <div className="notice error" role="alert" data-testid={testId}>
      <span>{item.message}</span>
      {item.details.length > 0 && (
        <ul className="failure-details">
          {item.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ViolationRow({
  violation,
  onJump,
}: {
  violation: Violation;
  onJump: (target: { artifact: string | null; field: SchemaField | null }) => void;
}) {
  const level = violation.rule === 'sdd/unknown-waiver' || violation.rule === 'sdd/waiver-without-reason' ? 'notice' : violation.level;
  return (
    <li data-testid={`violation-${violation.rule}`}>
      <span className={`m ${violation.level === 'error' ? 'err' : 'warn'}`}>{LEVEL_MARK[violation.level]}</span>
      <span className="body">
        <button type="button" className="linklike" onClick={() => onJump(violation)}>
          {violation.message}
        </button>
        <span className="rid">
          {violation.rule} · SDD · {level === 'notice' ? 'уведомление' : LEVEL_TEXT[violation.level]}
        </span>
        <span className="fix">{violation.fix}</span>
      </span>
    </li>
  );
}

function useFocus<T extends HTMLElement>(field: SchemaField, focusField: { field: SchemaField; tick: number } | null) {
  const ref = useRef<T | null>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (focusField?.field !== field || ref.current === null) return;
    ref.current.focus();
    ref.current.scrollIntoView({ block: 'center' });
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(timer);
  }, [field, focusField]);
  return { ref, flash };
}

function AddArtifact({
  artifacts,
  disabled,
  onAdd,
}: {
  artifacts: readonly string[];
  disabled: boolean;
  onAdd: (id: string, requires: string[]) => void;
}) {
  const [id, setId] = useState('');
  const [requires, setRequires] = useState('');
  return (
    <form
      className="add-artifact"
      onSubmit={(event) => {
        event.preventDefault();
        if (id.trim() === '') return;
        onAdd(id, requires === '' ? [] : [requires]);
        setId('');
        setRequires('');
      }}
    >
      <input
        aria-label="Идентификатор нового артефакта"
        placeholder="новый артефакт"
        value={id}
        disabled={disabled}
        onChange={(event) => setId(event.target.value)}
      />
      <select
        aria-label="Зависимость нового артефакта"
        value={requires}
        disabled={disabled}
        onChange={(event) => setRequires(event.target.value)}
      >
        <option value="">без зависимости</option>
        {artifacts.map((artifact) => (
          <option key={artifact} value={artifact}>
            после {artifact}
          </option>
        ))}
      </select>
      <button type="submit" className="btn" disabled={disabled || id.trim() === ''}>
        + Артефакт
      </button>
    </form>
  );
}

function ArtifactForm({
  schema,
  artifact,
  others,
  dependents,
  templates,
  disabled,
  readOnly,
  focusField,
  onChange,
  onRemove,
  onTemplateSaved,
}: {
  schema: string;
  artifact: {
    id: string;
    generates: string;
    description: string | null;
    template: string | null;
    instruction: string | null;
    requires: readonly string[];
  };
  others: readonly string[];
  dependents: readonly string[];
  templates: SchemaSource['templates'];
  disabled: boolean;
  readOnly: boolean;
  focusField: { field: SchemaField; tick: number } | null;
  onChange: (patch: {
    id?: string;
    generates?: string;
    description?: string | null;
    template?: string | null;
    instruction?: string | null;
    requires?: string[];
  }) => void;
  onRemove: () => void;
  onTemplateSaved: () => void;
}) {
  const [idDraft, setIdDraft] = useState(artifact.id);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const generates = useFocus<HTMLInputElement>('generates', focusField);
  const requires = useFocus<HTMLFieldSetElement>('requires', focusField);
  const instruction = useFocus<HTMLTextAreaElement>('instruction', focusField);

  const templateState = templates.find(
    (item) => item.artifact === artifact.id && item.template === artifact.template,
  );

  return (
    <section className="artifact-form" data-testid="artifact-form" data-artifact={artifact.id}>
      <p className="pane-title">
        Свойства артефакта <span className="count">{artifact.id}</span>
      </p>
      <div className="field">
        <label htmlFor="schema-field-id">Идентификатор</label>
        <input
          id="schema-field-id"
          value={idDraft}
          disabled={disabled}
          onChange={(event) => setIdDraft(event.target.value)}
          onBlur={() => {
            if (idDraft.trim() !== artifact.id) onChange({ id: idDraft });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (idDraft.trim() !== artifact.id) onChange({ id: idDraft });
            }
          }}
        />
        <p className="hint">Переименование обновит ссылки в зависимостях других артефактов.</p>
      </div>
      <div className="field">
        <label htmlFor="schema-field-generates">Порождает</label>
        <input
          id="schema-field-generates"
          ref={generates.ref}
          className={generates.flash ? 'flash' : ''}
          value={artifact.generates}
          disabled={disabled}
          onChange={(event) => onChange({ generates: event.target.value })}
        />
        <p className="hint">
          <code>specs/**/*.md</code> — артефакт-контракт: порождает дельты спеков.
        </p>
      </div>
      <div className="field">
        <label htmlFor="schema-field-description">Описание</label>
        <input
          id="schema-field-description"
          value={artifact.description ?? ''}
          disabled={disabled}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="schema-field-template">Шаблон</label>
        <input
          id="schema-field-template"
          value={artifact.template ?? ''}
          disabled={disabled}
          onChange={(event) => onChange({ template: event.target.value })}
        />
        {artifact.template !== null && (
          <TemplateEditor
            schema={schema}
            template={artifact.template}
            knownExists={templateState?.exists ?? null}
            readOnly={readOnly}
            onSaved={onTemplateSaved}
          />
        )}
      </div>
      <div className="field">
        <label htmlFor="schema-field-instruction">Инструкция для агента</label>
        <textarea
          id="schema-field-instruction"
          ref={instruction.ref}
          className={`${instruction.flash ? 'flash' : ''} ${artifact.instruction === null ? 'missing' : ''}`}
          rows={4}
          value={artifact.instruction ?? ''}
          placeholder="не заполнена"
          disabled={disabled}
          onChange={(event) => onChange({ instruction: event.target.value })}
        />
        {artifact.instruction === null && <p className="hint">Без неё агент не сможет работать по этому артефакту.</p>}
      </div>
      <fieldset
        className={`field deps ${requires.flash ? 'flash' : ''}`}
        ref={requires.ref}
        tabIndex={-1}
        id="schema-field-requires"
      >
        <legend>Зависит от</legend>
        {others.length === 0 && <p className="hint">Других артефактов нет.</p>}
        {others.map((other) => (
          <label key={other} className="check">
            <input
              type="checkbox"
              checked={artifact.requires.includes(other)}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  requires: event.target.checked
                    ? [...artifact.requires, other]
                    : artifact.requires.filter((item) => item !== other),
                })
              }
            />
            <span className="mono">{other}</span>
          </label>
        ))}
      </fieldset>

      {!readOnly && (
        <div className="remove-artifact">
          {confirmRemove ? (
            <div className="notice error" data-testid="remove-confirm">
              <span>
                {dependents.length === 0
                  ? `Удалить артефакт «${artifact.id}»?`
                  : `От «${artifact.id}» зависят: ${dependents.join(', ')}. После удаления эти зависимости будут сняты.`}
              </span>
              <div className="conflict-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setConfirmRemove(false);
                    onRemove();
                  }}
                >
                  Удалить
                </button>
                <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>
                  Отмена
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn" disabled={disabled} onClick={() => setConfirmRemove(true)}>
              Удалить артефакт
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function TemplateEditor({
  schema,
  template,
  knownExists,
  readOnly,
  onSaved,
}: {
  schema: string;
  template: string;
  knownExists: boolean | null;
  readOnly: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean | null>(knownExists);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setExists(knownExists), [knownExists]);

  const load = async () => {
    try {
      const result = await fetchSchemaTemplate(schema, template);
      setExists(result.exists);
      setContent(result.content ?? `# ${template.replace(/\.md$/, '')}\n\n`);
      setOpen(true);
      setError(null);
    } catch (caught) {
      setError(failure(caught).message);
    }
  };

  return (
    <div className="template-editor" data-testid="template-editor">
      {exists === false && (
        <p className="hint warn" data-testid="template-missing">
          Файла шаблона <code>{template}</code> нет в каталоге схемы — это нарушение структуры.
        </p>
      )}
      {!open ? (
        <button type="button" className="btn" onClick={() => void load()}>
          {exists === false ? (readOnly ? 'Шаблона нет' : 'Создать шаблон') : 'Открыть шаблон'}
        </button>
      ) : (
        <>
          <textarea
            aria-label={`Шаблон ${template}`}
            rows={8}
            value={content ?? ''}
            readOnly={readOnly}
            onChange={(event) => {
              setContent(event.target.value);
              setSaved(false);
            }}
          />
          <div className="conflict-actions">
            {!readOnly && (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  saveSchemaTemplate(schema, template, content ?? '')
                    .then(() => {
                      setExists(true);
                      setSaved(true);
                      setError(null);
                      onSaved();
                    })
                    .catch((caught: unknown) => setError(failure(caught).message));
                }}
              >
                Сохранить шаблон
              </button>
            )}
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Закрыть
            </button>
            {saved && <span className="ok">Шаблон сохранён</span>}
          </div>
        </>
      )}
      {error !== null && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ApplyForm({
  apply,
  artifacts,
  disabled,
  focusField,
  onChange,
}: {
  apply: { requires: readonly string[]; tracks: string | null; instruction: string | null };
  artifacts: readonly { id: string; generates: string }[];
  disabled: boolean;
  focusField: { field: SchemaField; tick: number } | null;
  onChange: (patch: { requires?: string[]; tracks?: string | null; instruction?: string | null }) => void;
}) {
  const requires = useFocus<HTMLFieldSetElement>('apply.requires', focusField);
  const tracks = useFocus<HTMLSelectElement>('apply.tracks', focusField);
  const trackedKnown = apply.tracks === null || artifacts.some((artifact) => artifact.generates === apply.tracks);

  return (
    <section className="apply-form" data-testid="apply-form">
      <p className="pane-title" style={{ marginTop: 16 }}>
        Начало работ <span className="count">apply</span>
      </p>
      <fieldset
        className={`field deps ${requires.flash ? 'flash' : ''}`}
        ref={requires.ref}
        tabIndex={-1}
        id="schema-field-apply-requires"
      >
        <legend>Работа по коду начинается после</legend>
        {artifacts.map((artifact) => (
          <label key={artifact.id} className="check">
            <input
              type="checkbox"
              checked={apply.requires.includes(artifact.id)}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  requires: event.target.checked
                    ? [...apply.requires, artifact.id]
                    : apply.requires.filter((item) => item !== artifact.id),
                })
              }
            />
            <span className="mono">{artifact.id}</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="schema-field-apply-tracks">Отслеживаемый артефакт</label>
        <select
          id="schema-field-apply-tracks"
          ref={tracks.ref}
          className={tracks.flash ? 'flash' : ''}
          value={apply.tracks ?? ''}
          disabled={disabled}
          onChange={(event) => onChange({ tracks: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">не отслеживается</option>
          {!trackedKnown && apply.tracks !== null && <option value={apply.tracks}>{apply.tracks} (нет такого артефакта)</option>}
          {artifacts.map((artifact) => (
            <option key={artifact.id} value={artifact.generates}>
              {artifact.generates} ({artifact.id})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="schema-field-apply-instruction">Инструкция для работы по коду</label>
        <textarea
          id="schema-field-apply-instruction"
          rows={3}
          value={apply.instruction ?? ''}
          disabled={disabled}
          onChange={(event) => onChange({ instruction: event.target.value })}
        />
      </div>
    </section>
  );
}

function Waivers({
  waivers,
  disabled,
  focusField,
  onSet,
  onRemove,
}: {
  waivers: readonly { rule: string; reason: string | null }[];
  disabled: boolean;
  focusField: { field: SchemaField; tick: number } | null;
  onSet: (rule: string, reason: string | null) => void;
  onRemove: (rule: string) => void;
}) {
  const section = useFocus<HTMLElement>('sdd_waivers', focusField);
  const available = SDD_RULES.filter((rule) => !waivers.some((waiver) => waiver.rule === rule.id));
  const [rule, setRule] = useState('');
  const [reason, setReason] = useState('');

  return (
    <section
      className={`waivers ${section.flash ? 'flash' : ''}`}
      data-testid="waivers"
      ref={section.ref}
      tabIndex={-1}
    >
      <p className="pane-title" style={{ marginTop: 16 }}>
        Отказы от правил <span className="count">sdd_waivers</span>
      </p>
      <p className="hint">
        Отказ записывается в саму схему и попадает в код-ревью вместе с процессом. Без причины он не действует.
      </p>
      {waivers.map((waiver) => (
        <div className="waiver" key={waiver.rule} data-testid={`waiver-${waiver.rule}`}>
          <span className="mono">{waiver.rule}</span>
          <input
            aria-label={`Причина отказа от ${waiver.rule}`}
            value={waiver.reason ?? ''}
            placeholder="причина обязательна"
            disabled={disabled}
            onChange={(event) => onSet(waiver.rule, event.target.value)}
          />
          <button type="button" className="btn" disabled={disabled} onClick={() => onRemove(waiver.rule)}>
            Снять
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <form
          className="waiver"
          onSubmit={(event) => {
            event.preventDefault();
            if (rule === '') return;
            onSet(rule, reason);
            setRule('');
            setReason('');
          }}
        >
          <select aria-label="Правило для отказа" value={rule} disabled={disabled} onChange={(event) => setRule(event.target.value)}>
            <option value="">правило…</option>
            {available.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
          <input
            aria-label="Причина отказа"
            placeholder="причина"
            value={reason}
            disabled={disabled}
            onChange={(event) => setReason(event.target.value)}
          />
          <button type="submit" className="btn" disabled={disabled || rule === ''}>
            Отказаться
          </button>
        </form>
      )}
    </section>
  );
}
