import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TreeChange } from '@openspec-ide/core';
import {
  StaleWriteConflict,
  createArtifactFile,
  fetchFile,
  fetchValidation,
  saveFile,
  type ArtifactFile,
} from '../lib/api.js';
import { Editor } from './Editor.js';
import { Outline, StructureProblems } from './Outline.js';
import { Problems, type ValidationState } from './Problems.js';

interface EditorPaneProps {
  readonly change: TreeChange;
  readonly artifactId: string;
  /** Файл артефакта, выбранный для правки; `null`, если файлов ещё нет. */
  readonly file: string | null;
  readonly revealLine: number | null;
}

const EMPTY_VALIDATION: ValidationState = {
  entries: [],
  valid: false,
  error: null,
  stale: false,
  running: false,
};

export function EditorPane({ change, artifactId, file, revealLine }: EditorPaneProps) {
  const [loaded, setLoaded] = useState<ArtifactFile | null>(null);
  const [draft, setDraft] = useState('');
  const [conflict, setConflict] = useState<{ disk: ArtifactFile; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationState>(EMPTY_VALIDATION);
  const [reveal, setReveal] = useState<number | null>(revealLine);
  const [createError, setCreateError] = useState<string | null>(null);
  /** Увеличивается, когда содержимое приходит извне, а не из редактора. */
  const [documentKey, setDocumentKey] = useState(0);
  const requestId = useRef(0);

  const artifact = change.artifacts.find((item) => item.id === artifactId);
  const dirty = loaded !== null && draft !== loaded.content;

  // Артефакт, порождающий дельты спеков, получает подсветку формата OpenSpec;
  // прочие артефакты схемы правятся как обычный markdown.
  const openspecFormat = useMemo(
    () => (artifact?.outputPath ?? '').includes('specs/'),
    [artifact?.outputPath],
  );

  const path = file === null ? null : `openspec/changes/${change.name}/${file}`;

  useEffect(() => {
    setReveal(revealLine);
  }, [revealLine]);

  useEffect(() => {
    if (path === null) {
      setLoaded(null);
      setDraft('');
      return;
    }
    const id = (requestId.current += 1);
    void fetchFile(path)
      .then((result) => {
        if (id !== requestId.current) return;
        setLoaded(result);
        setDraft(result.content);
        setDocumentKey((key) => key + 1);
        setConflict(null);
        setSaveError(null);
      })
      .catch((error: unknown) => {
        if (id !== requestId.current) return;
        setSaveError(error instanceof Error ? error.message : String(error));
      });
  }, [path]);

  const runValidation = useCallback(async () => {
    setValidation((previous) => ({ ...previous, running: true, stale: previous.entries.length > 0 }));
    try {
      const run = await fetchValidation(change.name);
      // Вытесненный прогон относится к устаревшему содержимому — его результат
      // не показываем.
      if (run.superseded) return;
      setValidation({
        entries: run.entries,
        valid: run.valid,
        error: run.error,
        stale: false,
        running: false,
      });
    } catch (error) {
      setValidation({
        entries: [],
        valid: false,
        error: error instanceof Error ? error.message : String(error),
        stale: false,
        running: false,
      });
    }
  }, [change.name]);

  const save = useCallback(async () => {
    if (path === null || loaded === null) return;
    setSaveError(null);
    try {
      const saved = await saveFile(path, draft, loaded.version);
      setLoaded(saved);
      setConflict(null);
      await runValidation();
    } catch (error) {
      if (error instanceof StaleWriteConflict) {
        setConflict({ disk: error.disk, message: error.message });
        return;
      }
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }, [draft, loaded, path, runValidation]);

  async function create(): Promise<void> {
    setCreateError(null);
    try {
      const created = await createArtifactFile(change.name, artifactId);
      setLoaded({ path: created.path, content: created.content, version: '' });
      setDraft(created.content);
      setDocumentKey((key) => key + 1);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  }

  if (artifact === undefined) return <p className="empty">Артефакт не найден.</p>;

  if (path === null) {
    return (
      <div>
        <p className="pane-title">
          Артефакт <span className="count">{artifactId}</span>
        </p>
        <p className="empty">
          Файл «{artifact.outputPath}» ещё не создан. Его можно создать из шаблона схемы «
          {change.schema}».
        </p>
        <button type="button" className="btn primary" onClick={() => void create()}>
          Создать из шаблона
        </button>
        {createError !== null && (
          <p className="notice error" role="alert" data-testid="create-error">
            {createError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="crumbs">{path}</span>
        {dirty && (
          <span className="dirty" data-testid="dirty-marker">
            не сохранено
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void runValidation()}>
          Проверить
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => void save()}
          data-testid="save-button"
        >
          Сохранить
        </button>
      </div>

      {conflict !== null && (
        <div className="notice error" role="alert" data-testid="conflict">
          <p>{conflict.message}</p>
          <details>
            <summary>Версия на диске</summary>
            <pre className="diff-preview">{conflict.disk.content}</pre>
          </details>
          <div className="conflict-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(conflict.disk.content);
                setLoaded(conflict.disk);
                setDocumentKey((key) => key + 1);
                setConflict(null);
              }}
            >
              Взять версию с диска
            </button>
            <button
              type="button"
              className="btn"
              data-testid="overwrite"
              onClick={() => {
                setLoaded({ ...conflict.disk, content: conflict.disk.content });
                setConflict(null);
                void saveFile(path, draft, null).then((saved) => {
                  setLoaded(saved);
                  void runValidation();
                });
              }}
            >
              Оставить версию редактора
            </button>
          </div>
        </div>
      )}

      {saveError !== null && (
        <p className="notice error" role="alert" data-testid="save-error">
          {saveError}
        </p>
      )}

      <div className="editor-body">
        <Editor
          content={draft}
          documentKey={documentKey}
          onChange={setDraft}
          onSave={() => void save()}
          openspecFormat={openspecFormat}
          revealLine={reveal}
        />
        <aside className="editor-side">
          <p className="pane-title">Структура</p>
          <Outline content={draft} onReveal={setReveal} />
          <StructureProblems content={draft} onReveal={setReveal} />
        </aside>
      </div>

      <div className="editor-problems">
        <p className="pane-title">
          Проверки
          {validation.entries.length > 0 && (
            <span className="count">{validation.entries.length}</span>
          )}
          {validation.stale && <span className="count">устарело</span>}
        </p>
        <Problems
          state={validation}
          onOpen={(_file, line) => {
            if (line !== null) setReveal(line);
          }}
        />
      </div>
    </div>
  );
}
