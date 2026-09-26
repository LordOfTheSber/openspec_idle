import { useCallback, useEffect, useState } from 'react';
import type { StructureIssue, StructureNode } from '@openspec-ide/core';
import { type StructureReport, fetchStructure, initStructure } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { inVsCode, openInEditor } from '../lib/host.js';

const ISSUE_LABEL: Record<StructureIssue['kind'], string> = {
  missing: 'нет',
  unexpected: 'лишнее',
  'wrong-type': 'не тот тип',
};

const RULE_LABEL: Record<StructureNode['rule'], string> = {
  file: 'файл',
  dir: 'строгая папка',
  free: 'папка, внутри — любая структура',
  any: 'файл или папка',
};

const STATE_DOT: Record<StructureNode['state'], string> = {
  ok: 'done',
  missing: 'invalid',
  'wrong-type': 'invalid',
  'has-issues': 'draft',
  'absent-optional': 'missing',
};

/**
 * Раздел «Структура»: проверка папок контекста и спецификаций по
 * `openspec/structure.yaml`. Перепроверяется при изменении файлов.
 */
export function Structure({ revision }: { readonly revision: number }) {
  const [report, setReport] = useState<StructureReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const vscode = inVsCode();

  const load = useCallback(async () => {
    try {
      setReport(await fetchStructure());
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      setReport(await initStructure());
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  /** Лишний файл открывается сам, остальное — правило в описании. */
  function open(issue: StructureIssue): void {
    if (issue.kind === 'unexpected' && issue.actual === 'file') openInEditor(issue.path);
    else openInEditor(report?.path ?? 'openspec/structure.yaml', issue.line);
  }

  if (error !== null && report === null) {
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  }
  if (report === null) return <p className="empty">Проверка структуры…</p>;

  if (!report.configured) {
    return (
      <div className="structure" data-testid="structure">
        <div className="notice info" data-testid="structure-not-configured">
          <p>
            Структура папок не задана: в проекте нет <code>{report.path}</code>. Опишите в нём, где лежат
            контекст и спецификации, — IDE будет проверять, что проект ей соответствует.
          </p>
          <p>
            Жёстко — с точностью до папки и файла, или мягко: до нужной папки жёстко, а внутри неё
            (<code>имя: "*"</code>) — любая структура.
          </p>
        </div>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void create()} data-testid="structure-init">
          Создать по текущей раскладке openspec/
        </button>
        {error !== null && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="structure" data-testid="structure" data-ok={String(report.ok)}>
      <div className="structure-toolbar">
        <span className="crumbs">{report.path}</span>
        <span className="spacer" />
        {vscode && (
          <button type="button" className="btn" onClick={() => openInEditor(report.path)} data-testid="structure-open">
            Открыть описание
          </button>
        )}
        <button type="button" className="btn" onClick={() => void load()} data-testid="structure-check">
          Проверить
        </button>
      </div>

      {report.errors.length > 0 ? (
        <div className="notice error" role="alert" data-testid="structure-errors">
          <p>Описание структуры с ошибками — проверка не выполнялась:</p>
          <ul className="failure-details">
            {report.errors.map((item, index) => (
              <li key={`${item.line ?? 0}-${index}`}>
                {item.line !== null && (
                  <button type="button" className="linkish" onClick={() => openInEditor(report.path, item.line)} disabled={!vscode}>
                    строка {item.line}
                  </button>
                )}{' '}
                {item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : report.ok ? (
        <p className="notice ok" data-testid="structure-summary">
          Структура соответствует описанию.
        </p>
      ) : (
        <p className="notice error" data-testid="structure-summary">
          {plural(report.issues.length, ['нарушение', 'нарушения', 'нарушений'])} структуры папок.
        </p>
      )}

      {report.issues.length > 0 && (
        <ul className="structure-issues" data-testid="structure-issues">
          {report.issues.map((issue) => (
            <li key={`${issue.kind}-${issue.path}`} className={issue.kind} data-testid={`structure-issue-${issue.path}`}>
              <span className="chip bad">{ISSUE_LABEL[issue.kind]}</span>
              <span className="body">
                <span>{issue.message}</span>
                {issue.line !== null && <span className="where">правило — строка {issue.line}</span>}
              </span>
              {vscode && (
                <button type="button" className="btn small" onClick={() => open(issue)}>
                  {issue.kind === 'unexpected' && issue.actual === 'file' ? 'Открыть файл' : 'К правилу'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {report.tree.length > 0 && (
        <>
          <p className="pane-title">Описание</p>
          <ul className="structure-tree" data-testid="structure-tree">
            {report.tree.map((node) => (
              <TreeNode key={node.path} node={node} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function TreeNode({ node }: { readonly node: StructureNode }) {
  return (
    <li>
      <div className="structure-node" data-state={node.state}>
        <span className={`dot ${STATE_DOT[node.state]}`} aria-hidden="true" />
        <span className="nm mono">
          {node.name}
          {node.rule === 'file' ? '' : '/'}
          {node.optional ? '?' : ''}
        </span>
        <span className="rule">
          {node.pattern ? `шаблон · ${RULE_LABEL[node.rule]}` : RULE_LABEL[node.rule]}
          {node.matches !== null && ` · совпадений ${node.matches}`}
          {node.state === 'absent-optional' && ' · нет, необязателен'}
        </span>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}
