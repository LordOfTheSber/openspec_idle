import { useCallback, useEffect, useState } from 'react';
import type { StructureIssue, StructureNode } from '@openspec-ide/core';
import { type StructureReport, fetchStructure, initStructure } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { inVsCode, openInEditor } from '../lib/host.js';
import { PageActions } from '../lib/ui.js';
import { Icon, type IconName } from './Icon.js';

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
      <div className="section-pad">
        <p className="notice error" role="alert">
          {error}
        </p>
      </div>
    );
  }
  if (report === null) {
    return (
      <div className="page-skeleton section-pad" aria-busy="true" aria-label="Проверка структуры">
        <div className="skeleton-grid">
          <span className="skeleton" style={{ height: 60 }} />
          <span className="skeleton" style={{ height: 60 }} />
          <span className="skeleton" style={{ height: 60 }} />
        </div>
        <span className="skeleton" style={{ height: 260 }} />
      </div>
    );
  }

  if (!report.configured) {
    return (
      <div className="structure section-pad" data-testid="structure">
        <div className="state-card" data-testid="structure-not-configured">
          <span className="state-icon info">
            <Icon name="structure" size={22} />
          </span>
          <h2>Структура папок не задана</h2>
          <p>
            В проекте нет <code>{report.path}</code>. Опишите в нём, где лежат контекст и спецификации, — IDE будет
            проверять, что проект ей соответствует.
          </p>
          <p className="muted">
            Жёстко — с точностью до папки и файла, или мягко: до нужной папки жёстко, а внутри неё (
            <code>имя: "*"</code>) — любая структура.
          </p>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void create()} data-testid="structure-init">
            <Icon name="plus" size={14} />
            Создать по текущей раскладке openspec/
          </button>
          {error !== null && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  const counts = countNodes(report.tree);

  return (
    <div className="structure" data-testid="structure" data-ok={String(report.ok)}>
      <PageActions>
        {vscode ? (
          <button type="button" className="linkish mono small" onClick={() => openInEditor(report.path)} data-testid="structure-open">
            {report.path}
          </button>
        ) : (
          <span className="mono small muted">{report.path}</span>
        )}
        <button type="button" className="btn" onClick={() => void load()} data-testid="structure-check">
          <Icon name="refresh" size={15} />
          Проверить
        </button>
      </PageActions>

      <div className="structure-main">
        {report.errors.length > 0 ? (
          <div className="notice error" role="alert" data-testid="structure-errors">
            <p>
              <b>Описание структуры с ошибками</b> — проверка не выполнялась:
            </p>
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
        ) : (
          <div className="tiles three">
            <div className={report.ok ? 'tile stat ok' : 'tile stat bad'} data-testid="structure-summary">
              <Icon name={report.ok ? 'checkCircle' : 'error'} size={22} />
              <div>
                <div className="v">{report.ok ? 'Соответствует' : plural(report.issues.length, ['нарушение', 'нарушения', 'нарушений'])}</div>
                <div className="sub">
                  {report.ok ? 'Структура соответствует описанию.' : `${plural(report.issues.length, ['нарушение', 'нарушения', 'нарушений'])} структуры папок.`}
                </div>
              </div>
            </div>
            <div className="tile stat">
              <Icon name="check" size={22} className="ok-icon" />
              <div>
                <div className="v">{counts.ok}</div>
                <div className="sub">элементов соответствуют</div>
              </div>
            </div>
            <div className="tile stat">
              <Icon name="circle" size={22} className="muted" />
              <div>
                <div className="v">{counts.optional}</div>
                <div className="sub">необязательных отсутствует</div>
              </div>
            </div>
          </div>
        )}

        {report.tree.length > 0 && (
          <div className="structure-tree-card">
            <ul className="structure-tree" data-testid="structure-tree">
              {report.tree.map((node) => (
                <TreeNode key={node.path} node={node} />
              ))}
            </ul>
          </div>
        )}
      </div>

      <aside className="structure-aside" aria-label="Нарушения">
        <p className="section-label">
          Нарушения <span className={report.issues.length > 0 ? 'badge bad' : 'badge ok'}>{report.issues.length}</span>
        </p>
        {report.issues.length === 0 ? (
          <p className="empty">Нарушений нет.</p>
        ) : (
          <ul className="structure-issues" data-testid="structure-issues">
            {report.issues.map((issue) => (
              <li key={`${issue.kind}-${issue.path}`} className={issue.kind} data-testid={`structure-issue-${issue.path}`}>
                <Icon name="error" size={16} className="bad-icon" />
                <span className="body">
                  <span className="mono path">{issue.path}</span>
                  <span>{issue.message}</span>
                  <span className="where">
                    <span className="chip bad">{ISSUE_LABEL[issue.kind]}</span>
                    {issue.line !== null && <span className="muted small">правило — строка {issue.line}</span>}
                  </span>
                  {vscode && (
                    <span className="issue-actions">
                      <button type="button" className="btn small" onClick={() => open(issue)}>
                        <Icon name="external" size={13} />
                        {issue.kind === 'unexpected' && issue.actual === 'file' ? 'Открыть файл' : 'К правилу'}
                      </button>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Те же нарушения видны в панели «Проблемы» VS Code — на строке правила или файла.</p>
      </aside>
    </div>
  );
}

function countNodes(nodes: readonly StructureNode[]): { ok: number; optional: number } {
  let ok = 0;
  let optional = 0;
  const walk = (list: readonly StructureNode[]): void => {
    for (const node of list) {
      if (node.state === 'ok') ok += 1;
      if (node.state === 'absent-optional') optional += 1;
      walk(node.children);
    }
  };
  walk(nodes);
  return { ok, optional };
}

const STATE_ICON: Record<StructureNode['state'], { icon: IconName; className: string; label: string }> = {
  ok: { icon: 'check', className: 'ok-icon', label: 'соответствует' },
  missing: { icon: 'error', className: 'bad-icon', label: 'нет' },
  'wrong-type': { icon: 'error', className: 'bad-icon', label: 'не тот тип' },
  'has-issues': { icon: 'alert', className: 'warn-icon', label: 'внутри есть нарушения' },
  'absent-optional': { icon: 'circle', className: 'muted', label: 'нет, необязателен' },
};

function TreeNode({ node }: { readonly node: StructureNode }) {
  const state = STATE_ICON[node.state];
  return (
    <li>
      <div className="structure-node row-hover" data-state={node.state}>
        <Icon name={node.rule === 'file' ? 'file' : 'folder'} size={15} className="muted" />
        <span className="nm mono">
          {node.name}
          {node.rule === 'file' ? '' : '/'}
          {node.optional ? '?' : ''}
        </span>
        <span className="chip rule">
          {node.pattern ? `шаблон · ${RULE_LABEL[node.rule]}` : RULE_LABEL[node.rule]}
          {node.matches !== null && ` · совпадений ${node.matches}`}
          {node.state === 'absent-optional' && ' · нет, необязателен'}
        </span>
        <span className="spacer" />
        <span title={state.label} aria-label={state.label} role="img">
          <Icon name={state.icon} size={15} className={state.className} />
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
