import { parseSpecMarkdown } from '@openspec-ide/core';
import { useMemo } from 'react';

/** Панель структуры документа: требования и вложенные сценарии. */
export function Outline({
  content,
  onReveal,
}: {
  readonly content: string;
  readonly onReveal: (line: number) => void;
}) {
  const parsed = useMemo(() => parseSpecMarkdown(content), [content]);

  if (parsed.requirements.length === 0) {
    return <p className="empty">В документе пока нет требований.</p>;
  }

  return (
    <ul className="outline" data-testid="outline">
      {parsed.requirements.map((requirement) => (
        <li key={`${requirement.line}-${requirement.name}`}>
          <button
            type="button"
            className="outline-item"
            onClick={() => onReveal(requirement.line)}
            data-testid={`outline-requirement-${requirement.name}`}
          >
            {requirement.operation !== null && (
              <span className="op">{OPERATION_LABEL[requirement.operation]}</span>
            )}
            <span className="nm">{requirement.name}</span>
          </button>
          <ul>
            {requirement.scenarios.map((scenario) => (
              <li key={`${scenario.line}-${scenario.name}`}>
                <button
                  type="button"
                  className="outline-item scenario"
                  onClick={() => onReveal(scenario.line)}
                  data-testid={`outline-scenario-${scenario.name}`}
                >
                  <span className="nm">{scenario.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

const OPERATION_LABEL: Record<string, string> = {
  ADDED: '+',
  MODIFIED: '~',
  REMOVED: '−',
  RENAMED: '→',
};

/** Структурные нарушения формата, найденные в документе. */
export function StructureProblems({
  content,
  onReveal,
}: {
  readonly content: string;
  readonly onReveal: (line: number) => void;
}) {
  const parsed = useMemo(() => parseSpecMarkdown(content), [content]);
  if (parsed.problems.length === 0) return null;

  return (
    <ul className="problems" data-testid="structure-problems">
      {parsed.problems.map((problem) => (
        <li key={`${problem.line}-${problem.kind}`}>
          <span className="sev w">СТР</span>
          <button type="button" className="problem-link" onClick={() => onReveal(problem.line)}>
            {problem.message}
            <span className="where">строка {problem.line}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
