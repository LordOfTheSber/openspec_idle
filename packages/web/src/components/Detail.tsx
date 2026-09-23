import { useEffect, useState } from 'react';
import type { ModuleDef, TreeChange, WorkspaceTree } from '@openspec-ide/core';
import {
  createArtifactFile,
  fetchChangeTraces,
  fetchImpact,
  type ChangeImpact,
  type ChangeTraces,
  type ModulesView,
} from '../lib/api.js';
import { ModuleGraph, type ModuleMark } from './ModuleGraph.js';
import type { Selection } from './Tree.js';

const STATE_LABEL: Record<string, string> = {
  missing: 'отсутствует',
  draft: 'черновик',
  done: 'заполнен',
  invalid: 'не проходит валидацию',
};

export function Detail({
  tree,
  selection,
  modules = null,
  onSelect,
  onShowImpact,
}: {
  readonly tree: WorkspaceTree;
  readonly selection: Selection | null;
  readonly modules?: ModulesView | null;
  readonly onSelect?: (selection: Selection) => void;
  readonly onShowImpact?: () => void;
}) {
  if (selection === null) {
    return <p className="empty">Выберите элемент в дереве слева.</p>;
  }

  if (selection.kind === 'change' || selection.kind === 'artifact') {
    const changeName = selection.kind === 'change' ? selection.id : (selection.parent ?? '');
    const change = tree.changes.find((item) => item.name === changeName);
    if (change === undefined) return <p className="empty">Изменение не найдено.</p>;

    if (selection.kind === 'change') {
      return (
        <div className="detail">
          <p className="pane-title">
            Изменение <span className="count">{change.schema}</span>
          </p>
          <dl>
            <dt>Схема</dt>
            <dd>{change.schema}</dd>
            <dt>Артефактов</dt>
            <dd>{change.artifacts.length}</dd>
            <dt>Прогресс</dt>
            <dd>
              {change.progress === null || change.progress.total === 0
                ? 'нет отслеживаемых пунктов'
                : `${change.progress.complete}/${change.progress.total}`}
            </dd>
            <dt>Ошибок валидации</dt>
            <dd>{change.errorCount}</dd>
          </dl>
          <ChangeModules change={change} modules={modules} onSelect={onSelect} onShowImpact={onShowImpact} />
        </div>
      );
    }

    const artifact = change.artifacts.find((item) => item.id === selection.id);
    if (artifact === undefined) return <p className="empty">Артефакт не найден.</p>;

    return (
      <div className="detail">
        <p className="pane-title">
          Артефакт <span className="count">{artifact.id}</span>
        </p>
        <dl>
          <dt>Состояние</dt>
          <dd data-testid="artifact-state">{STATE_LABEL[artifact.state] ?? artifact.state}</dd>
          <dt>Порождает</dt>
          <dd>{artifact.outputPath}</dd>
          <dt>Файлов на диске</dt>
          <dd>{artifact.files.length}</dd>
          {artifact.progress !== null && (
            <>
              <dt>Прогресс</dt>
              <dd>
                {artifact.progress.complete}/{artifact.progress.total}
              </dd>
            </>
          )}
        </dl>
      </div>
    );
  }

  if (selection.kind === 'schema') {
    const schema = tree.schemas.find((item) => item.name === selection.id);
    if (schema === undefined) return <p className="empty">Процесс не найден.</p>;
    return (
      <div className="detail">
        <p className="pane-title">
          Процесс <span className="count">{schema.source}</span>
        </p>
        <dl>
          <dt>Артефакты</dt>
          <dd>{schema.artifacts.join(' → ')}</dd>
          <dt>Источник</dt>
          <dd>{schema.source}</dd>
          <dt>По умолчанию</dt>
          <dd>{schema.isDefault ? 'да' : 'нет'}</dd>
        </dl>
      </div>
    );
  }

  return (
    <div className="detail">
      <p className="pane-title">{selection.kind === 'capability' ? 'Capability' : 'Архив'}</p>
      <dl>
        <dt>Путь</dt>
        <dd>{selection.id}</dd>
      </dl>
    </div>
  );
}

/** Модули change, затронутые потребители и дельты по модулям. */
function ChangeModules({
  change,
  modules,
  onSelect,
  onShowImpact,
}: {
  readonly change: TreeChange;
  readonly modules: ModulesView | null;
  readonly onSelect: ((selection: Selection) => void) | undefined;
  readonly onShowImpact: (() => void) | undefined;
}) {
  const [impact, setImpact] = useState<ChangeImpact | null>(null);
  const [traces, setTraces] = useState<ChangeTraces | null>(null);
  const hasMap = modules !== null && modules.map.modules.length > 0;
  const deltaKey = change.deltaCapabilities.join(',') + '|' + change.declaredModules.join(',');

  useEffect(() => {
    if (!hasMap) return;
    let current = true;
    void fetchImpact(change.name).then((result) => {
      if (current) setImpact(result);
    });
    return () => {
      current = false;
    };
  }, [change.name, hasMap, deltaKey, modules]);

  useEffect(() => {
    let current = true;
    void fetchChangeTraces(change.name)
      .then((result) => {
        if (current) setTraces(result);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [change.name, deltaKey]);

  const specs = change.artifacts.find((artifact) => artifact.outputPath.includes('*'));
  const own = modules?.map.modules.filter((module) => impact?.modules.includes(module.id)) ?? [];

  const marks = new Map<string, ModuleMark>();
  for (const id of impact?.modules ?? []) marks.set(id, 'source');
  for (const consumer of impact?.consumers ?? []) marks.set(consumer.id, consumer.depth === 1 ? 'direct' : 'transitive');

  return (
    <>
      {hasMap && impact !== null && (
        <section className="change-modules" data-testid="change-modules">
          <p className="grp">
            Модули · {impact.modules.length}
            {impact.modules.length > 1 && <span className="chip warn">сквозной</span>}
          </p>
          {impact.modules.length === 0 ? (
            <p className="empty">Change не относится ни к одному модулю: нет дельт в их спеках и ключа modules.</p>
          ) : (
            <ul className="chips-list">
              {impact.modules.map((id) => (
                <li key={id}>
                  <span className="chip module">{id}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="grp">Затронутые потребители · {impact.consumers.length}</p>
          {impact.consumers.length === 0 ? (
            <p className="empty">От модулей change никто не зависит.</p>
          ) : (
            <ul className="consumer-list" data-testid="impact-consumers">
              {impact.consumers.map((consumer) => (
                <li key={consumer.id} data-depth={consumer.depth}>
                  <span className="mono">{consumer.id}</span>{' '}
                  <span className={`chip ${consumer.depth === 1 ? 'direct' : 'transitive'}`}>
                    {consumer.depth === 1 ? 'прямой' : `транзитивный, через ${consumer.via}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {impact.consumers.length > 0 && modules !== null && (
            <div className="module-graph-wrap small">
              <ModuleGraph modules={modules.map.modules} selected={null} marks={marks} />
            </div>
          )}
          {onShowImpact !== undefined && impact.modules.length > 0 && (
            <button type="button" className="btn" onClick={onShowImpact} data-testid="show-impact">
              Показать на графе модулей
            </button>
          )}
        </section>
      )}
      {traces !== null && (traces.affectedLinks.length > 0 || traces.brokenLinks.length > 0 || traces.tagsToUpdate.length > 0) && (
        <section className="change-traces" data-testid="change-traces">
          {traces.affectedLinks.length > 0 && (
            <>
              <p className="grp">Ссылающиеся требования других модулей · {traces.affectedLinks.length}</p>
              <ul className="link-list" data-testid="affected-links">
                {traces.affectedLinks.map((link) => (
                  <li key={`${link.file}:${link.line}`}>
                    <span className="chip module">{link.fromModule ?? link.fromCapability}</span> {link.fromRequirement ?? 'спека'} →{' '}
                    {link.toRequirement}
                    {link.changing !== null && <span className="chip bad">требование {link.changing.operation === 'REMOVED' ? 'удаляется' : 'переименовывается'}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {traces.brokenLinks.length > 0 && (
            <>
              <p className="grp">Битые ссылки в дельтах · {traces.brokenLinks.length}</p>
              <ul className="link-list" data-testid="broken-links">
                {traces.brokenLinks.map((link) => (
                  <li key={`${link.file}:${link.line}`}>
                    <code>
                      {link.file}:{link.line}
                    </code>{' '}
                    {link.href}
                    {link.suggestion !== null && <> → замените на «{link.suggestion}»</>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {traces.tagsToUpdate.length > 0 && (
            <>
              <p className="grp">Метки в коде, которые нужно обновить · {traces.tagsToUpdate.length}</p>
              <ul className="link-list" data-testid="tags-to-update">
                {traces.tagsToUpdate.map((tag) => (
                  <li key={`${tag.path}:${tag.line}`}>
                    <code>
                      {tag.path}:{tag.line}
                    </code>{' '}
                    «{tag.from}» → «{tag.to}»
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {specs !== undefined && (
        <DeltaFiles change={change} artifactId={specs.id} files={specs.files} own={own} impact={impact} onSelect={onSelect} />
      )}
    </>
  );
}

/** Файлы дельт по модулям и добавление дельты с подсказкой префикса. */
function DeltaFiles({
  change,
  artifactId,
  files,
  own,
  impact,
  onSelect,
}: {
  readonly change: TreeChange;
  readonly artifactId: string;
  readonly files: readonly string[];
  readonly own: readonly ModuleDef[];
  readonly impact: ChangeImpact | null;
  readonly onSelect: ((selection: Selection) => void) | undefined;
}) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const suggestions = own.map((module) => `${module.specs}/`);

  const moduleOfFile = (file: string): string => {
    const capability = file.replace(/^specs\//, '').replace(/\/[^/]+$/, '');
    for (const [module, capabilities] of Object.entries(impact?.deltasByModule ?? {})) {
      if (capabilities.includes(capability)) return module;
    }
    return '';
  };
  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const module = moduleOfFile(file);
    grouped.set(module, [...(grouped.get(module) ?? []), file]);
  }

  async function add(): Promise<void> {
    setError(null);
    try {
      const created = await createArtifactFile(change.name, artifactId, path.trim().replace(/\/+$/, ''));
      const file = created.path.replace(`openspec/changes/${change.name}/`, '');
      setPath('');
      onSelect?.({ kind: 'artifact', id: artifactId, parent: change.name, file });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }

  return (
    <section className="delta-files" data-testid="delta-files">
      <p className="grp">Дельты спеков · {files.length}</p>
      {[...grouped].map(([module, list]) => (
        <div key={module} data-testid={`delta-files-${module === '' ? 'none' : module}`}>
          {impact !== null && <p className="muted small">{module === '' ? 'вне модулей' : module}</p>}
          <ul className="link-list">
            {list.map((file) => (
              <li key={file}>
                <button
                  type="button"
                  className="link mono"
                  onClick={() => onSelect?.({ kind: 'artifact', id: artifactId, parent: change.name, file })}
                >
                  {file}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <form
        className="add-delta"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={suggestions[0] === undefined ? 'путь capability' : `${suggestions[0]}…`}
          aria-label="Путь capability новой дельты"
          list={`delta-prefixes-${change.name}`}
          data-testid="add-delta-path"
        />
        <datalist id={`delta-prefixes-${change.name}`}>
          {suggestions.map((prefix) => (
            <option key={prefix} value={prefix} />
          ))}
        </datalist>
        <button type="submit" className="btn" disabled={path.trim().replace(/\/+$/, '') === ''} data-testid="add-delta">
          Добавить дельту
        </button>
      </form>
      {suggestions.length > 0 && (
        <p className="muted small" data-testid="delta-prefix-hint">
          Путь начинается с префикса модуля change: {suggestions.map((prefix) => <code key={prefix}>{prefix}</code>)}
        </p>
      )}
      {path.trim() !== '' && suggestions.length > 0 && !suggestions.some((prefix) => path.startsWith(prefix) || `${path}/` === prefix) && (
        <p className="notice info" data-testid="delta-prefix-warning">
          Путь не начинается с префикса модулей change — дельта попадёт в другой модуль или вне модулей.
        </p>
      )}
      {error !== null && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
