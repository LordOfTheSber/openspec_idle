import { useEffect, useRef, useState } from 'react';
import type { RequirementChange, TextDiffHunk } from '@openspec-ide/core';
import { type ArchivePreviewResponse, type SpecPreview, fetchArchivePreview } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { inVsCode, previewArchiveInEditor } from '../lib/host.js';

/** Задержка перед повторным прогоном после изменения файлов, мс. */
const RELOAD_DELAY_MS = 400;

const KIND_LABEL: Record<RequirementChange['kind'], string> = {
  added: 'добавлено',
  modified: 'изменено',
  renamed: 'переименовано',
  unchanged: 'без изменений',
};

const KIND_GLYPH: Record<RequirementChange['kind'], string> = {
  added: '+',
  modified: '~',
  renamed: '→',
  unchanged: '·',
};

/** Состояние предпросмотра — родителю, чтобы решить, можно ли архивировать. */
export type PreviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'done'; readonly preview: ArchivePreviewResponse };

/**
 * Предпросмотр архивации change: что станет с основными спеками после
 * `openspec archive`.
 *
 * Строится настоящим CLI на временной копии проекта, поэтому совпадает с
 * архивацией. При изменении файлов перестраивается с задержкой, чтобы серия
 * сохранений не запускала серию прогонов. Для другого change компонент
 * монтируется заново (`key`), а не перестраивается.
 */
export function ArchivePreview({
  change,
  revision,
  onState,
}: {
  readonly change: string;
  readonly revision: number;
  readonly onState?: (state: PreviewState) => void;
}) {
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const first = useRef(true);
  const report = useRef(onState);
  report.current = onState;

  useEffect(() => {
    let current = true;
    const delay = first.current ? 0 : RELOAD_DELAY_MS;
    if (first.current) report.current?.({ kind: 'loading' });
    first.current = false;
    const timer = setTimeout(() => {
      void fetchArchivePreview(change)
        .then((preview): PreviewState => ({ kind: 'done', preview }))
        .catch((problem: unknown): PreviewState => ({
          kind: 'error',
          message: problem instanceof Error ? problem.message : String(problem),
        }))
        .then((next) => {
          if (!current) return;
          setState(next);
          report.current?.(next);
        });
    }, delay);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [change, revision]);

  if (state.kind === 'loading') {
    return (
      <p className="empty" data-testid="preview-loading">
        Прогоняю <code>openspec archive</code> на временной копии проекта…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p className="notice error" role="alert" data-testid="preview-error">
        {state.message}
      </p>
    );
  }

  const { preview } = state;
  return (
    <div className="archive-preview" data-testid="archive-preview" data-outcome={preview.outcome}>
      <Outcome preview={preview} />

      {preview.warnings.length > 0 && (
        <ul className="preview-warnings" data-testid="preview-warnings">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {preview.outcome !== 'refused' && preview.specs.length === 0 && (
        <p className="empty" data-testid="preview-no-specs">
          Основные спеки не изменятся.
        </p>
      )}

      {preview.specs.map((spec) => (
        <SpecCard key={spec.capability} change={change} spec={spec} />
      ))}
    </div>
  );
}

function Outcome({ preview }: { readonly preview: ArchivePreviewResponse }) {
  const totals = preview.totals;
  const summary =
    totals === null
      ? null
      : [
          totals.added > 0 ? `+${totals.added} добавлено` : null,
          totals.modified > 0 ? `~${totals.modified} изменено` : null,
          totals.removed > 0 ? `−${totals.removed} удалено` : null,
          totals.renamed > 0 ? `→${totals.renamed} переименовано` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');

  return (
    <div
      className={`preview-outcome ${preview.outcome === 'ready' ? 'ok' : preview.outcome === 'refused' ? 'bad' : 'warn'}`}
      data-testid="preview-outcome"
      role={preview.outcome === 'ready' ? undefined : 'alert'}
    >
      <p className="headline">
        {preview.outcome === 'ready'
          ? 'Архивация пройдёт'
          : preview.outcome === 'validation-failed'
            ? 'Архивацию остановит проверка'
            : 'CLI отклонит архивацию'}
        {summary !== null && summary !== '' && <span className="totals">{summary}</span>}
      </p>
      {preview.outcome === 'validation-failed' && (
        <p className="sub">
          Ниже — спеки, какими их сделает архивация после исправления ошибок проверки.
        </p>
      )}
      {preview.problems.map((problem, index) => (
        <div className="problem" key={`${problem.code ?? 'x'}-${index}`}>
          <p>{problem.message}</p>
          {problem.fix !== null && <p className="fix">{problem.fix}</p>}
        </div>
      ))}
      {preview.outcome === 'refused' && preview.problems.every((problem) => problem.code === null) && preview.output !== '' && (
        <pre className="diff-preview">{preview.output}</pre>
      )}
    </div>
  );
}

function SpecCard({ change, spec }: { readonly change: string; readonly spec: SpecPreview }) {
  const [showDiff, setShowDiff] = useState(false);
  const vscode = inVsCode();

  return (
    <section className="spec-preview" data-testid={`spec-preview-${spec.capability}`}>
      <header>
        <span className="cap">{spec.capability}</span>
        <span className={`chip ${spec.status === 'created' ? 'on' : 'mod'}`}>
          {spec.status === 'created' ? 'новая' : 'изменится'}
        </span>
        <span className="counts">
          {spec.counts.added > 0 && <b className="added">+{spec.counts.added}</b>}
          {spec.counts.modified > 0 && <b className="modified">~{spec.counts.modified}</b>}
          {spec.counts.renamed > 0 && <b className="renamed">→{spec.counts.renamed}</b>}
          {spec.counts.removed > 0 && <b className="removed">−{spec.counts.removed}</b>}
        </span>
        <span className="spacer" />
        {vscode && (
          <button
            type="button"
            className="btn"
            onClick={() => previewArchiveInEditor(change, spec.capability)}
            data-testid={`open-diff-${spec.capability}`}
          >
            Открыть сравнение
          </button>
        )}
      </header>

      <ul className="req-changes">
        {spec.requirements.map((requirement) => (
          <li key={`${requirement.line}-${requirement.name}`} className={requirement.kind}>
            <span className="glyph" aria-hidden="true">
              {KIND_GLYPH[requirement.kind]}
            </span>
            <span className="name">{requirement.name}</span>
            <span className="kind">
              {KIND_LABEL[requirement.kind]}
              {requirement.kind === 'renamed' && requirement.textChanged && ' и изменено'}
            </span>
            {requirement.renamedFrom !== null && (
              <span className="was">было: {requirement.renamedFrom}</span>
            )}
            {requirement.kind !== 'added' && <ScenarioChanges requirement={requirement} />}
          </li>
        ))}
        {spec.removed.map((requirement) => (
          <li key={`removed-${requirement.name}`} className="removed" data-testid="removed-requirement">
            <span className="glyph" aria-hidden="true">
              −
            </span>
            <span className="name">{requirement.name}</span>
            <span className="kind">удалено</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="linkish"
        aria-expanded={showDiff}
        onClick={() => setShowDiff((value) => !value)}
        data-testid={`toggle-diff-${spec.capability}`}
      >
        {showDiff ? '▾' : '▸'} Строки <code>{spec.path}</code>: +{spec.diff.added} −{spec.diff.removed}
      </button>
      {showDiff && <UnifiedDiff hunks={spec.diff.hunks} approximate={spec.diff.approximate} />}
    </section>
  );
}

function ScenarioChanges({ requirement }: { readonly requirement: RequirementChange }) {
  const parts = [
    ...requirement.addedScenarios.map((name) => ({ kind: 'plus', name })),
    ...requirement.changedScenarios.map((name) => ({ kind: 'tilde', name })),
    ...requirement.removedScenarios.map((name) => ({ kind: 'minus', name })),
  ];
  if (parts.length === 0) return null;
  return (
    <ul className="scenario-changes">
      {parts.map((part) => (
        <li key={`${part.kind}-${part.name}`} className={part.kind}>
          {part.kind === 'plus' ? '+ сценарий' : part.kind === 'minus' ? '− сценарий' : '~ сценарий'} «{part.name}»
        </li>
      ))}
    </ul>
  );
}

function UnifiedDiff({
  hunks,
  approximate,
}: {
  readonly hunks: readonly TextDiffHunk[];
  readonly approximate: boolean;
}) {
  return (
    <div className="diff unified" data-testid="unified-diff">
      {approximate && (
        <p className="empty">Файл слишком велик для построчного сопоставления — показана полная замена.</p>
      )}
      {hunks.map((hunk) => (
        <div key={`${hunk.oldStart}-${hunk.newStart}`} className="hunk">
          <div className="row hunk-head">
            <span />
            <span>
              @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ ·{' '}
              {plural(hunk.lines.filter((line) => line.kind !== 'context').length, ['строка', 'строки', 'строк'])}
            </span>
          </div>
          {hunk.lines.map((line, index) => (
            <div
              key={`${line.oldLine ?? 'n'}-${line.newLine ?? 'n'}-${index}`}
              className={`row ${line.kind === 'added' ? 'plus' : line.kind === 'removed' ? 'minus' : 'ctx'}`}
            >
              <span>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
              <span>{line.text === '' ? ' ' : line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
