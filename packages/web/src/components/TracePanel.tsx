import { useState } from 'react';
import { ApiError, fetchSnippet, openInEditor, type CodePlace, type RequirementTrace } from '../lib/api.js';

const KIND_TITLE: Record<CodePlace['kind'], string> = {
  code: 'Реализация',
  test: 'Тесты',
  usage: 'Использование в других модулях',
  probable: 'Тесты по имени сценария',
};

/** Места требования в коде: метки и тесты по именам, с фрагментом и переходом в редактор. */
export function TracePanel({
  trace,
  onOpenSettings,
}: {
  readonly trace: RequirementTrace | undefined;
  readonly onOpenSettings?: (() => void) | undefined;
}) {
  if (trace === undefined) return <p className="empty small">Индекс кода ещё строится…</p>;
  const groups: [CodePlace['kind'], readonly CodePlace[]][] = [
    ['code', trace.code],
    ['test', trace.tests],
    ['usage', trace.usages],
    ['probable', trace.probable],
  ];
  const empty = groups.every(([, places]) => places.length === 0);
  return (
    <div className="trace" data-testid="trace">
      {empty && (
        <p className="empty small">
          Ни меток <code>@spec</code>, ни тестов с именами сценариев. Отметьте реализацию комментарием{' '}
          <code>// @spec модуль: {trace.requirement}</code>.
        </p>
      )}
      {groups
        .filter(([, places]) => places.length > 0)
        .map(([kind, places]) => (
          <div key={kind} data-testid={`trace-${kind}`}>
            <p className="grp">
              {KIND_TITLE[kind]} · {places.length}
              {kind === 'probable' && <span className="chip warn">по имени</span>}
            </p>
            <ul className="trace-list">
              {places.map((place) => (
                <TracePlace key={`${place.path}:${place.line}:${place.scenario ?? ''}`} place={place} onOpenSettings={onOpenSettings} />
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

function TracePlace({ place, onOpenSettings }: { readonly place: CodePlace; readonly onOpenSettings: (() => void) | undefined }) {
  const [snippet, setSnippet] = useState<{ start: number; line: number; lines: string[] } | null>(null);
  const [error, setError] = useState<{ text: string; searched: readonly string[] } | null>(null);
  const [opened, setOpened] = useState(false);

  async function toggle(): Promise<void> {
    if (snippet !== null) {
      setSnippet(null);
      return;
    }
    try {
      setSnippet(await fetchSnippet(place.path, place.line));
    } catch (problem) {
      setError({ text: problem instanceof Error ? problem.message : String(problem), searched: [] });
    }
  }

  async function open(): Promise<void> {
    setError(null);
    try {
      await openInEditor(place.path, place.line);
      setOpened(true);
    } catch (problem) {
      const searched = problem instanceof ApiError ? ((problem.payload['searched'] as string[] | undefined) ?? []) : [];
      setError({ text: problem instanceof Error ? problem.message : String(problem), searched });
    }
  }

  return (
    <li data-testid="trace-place">
      <div className="trace-row">
        <button type="button" className="link mono" onClick={() => void toggle()} aria-expanded={snippet !== null}>
          {place.path}:{place.line}
        </button>
        {place.module !== null && <span className="chip module">{place.module}</span>}
        {place.scenario !== undefined && <span className="muted small">сценарий «{place.scenario}»</span>}
        <span className="spacer" />
        <button type="button" className="btn small" onClick={() => void open()} data-testid="open-in-editor">
          Открыть в редакторе
        </button>
      </div>
      {opened && <p className="muted small">Открыто во внешнем редакторе.</p>}
      {error !== null && (
        <div className="notice error small" role="alert" data-testid="editor-error">
          <p>{error.text}</p>
          {error.searched.length > 0 && (
            <details>
              <summary>Проверенные пути · {error.searched.length}</summary>
              <ul className="mono small">
                {error.searched.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </details>
          )}
          {onOpenSettings !== undefined && (
            <button type="button" className="link" onClick={onOpenSettings}>
              Настроить редактор
            </button>
          )}
        </div>
      )}
      {snippet !== null && (
        <pre className="snippet" data-testid="snippet">
          {snippet.lines.map((text, index) => {
            const number = snippet.start + index;
            return (
              <div key={number} className={number === snippet.line ? 'hl' : ''}>
                <span className="ln">{number}</span>
                {text}
              </div>
            );
          })}
        </pre>
      )}
    </li>
  );
}
