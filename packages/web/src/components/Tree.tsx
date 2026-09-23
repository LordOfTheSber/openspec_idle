import type { TreeCapability, TreeChange, TreeSchema, WorkspaceTree } from '@openspec-ide/core';

/** Что выбрано в дереве. */
export interface Selection {
  readonly kind: 'change' | 'artifact' | 'capability' | 'schema' | 'archived';
  readonly id: string;
  readonly parent?: string;
}

interface TreeProps {
  readonly tree: WorkspaceTree;
  readonly selection: Selection | null;
  readonly onSelect: (selection: Selection) => void;
}

function isSelected(selection: Selection | null, candidate: Selection): boolean {
  return (
    selection?.kind === candidate.kind &&
    selection.id === candidate.id &&
    selection.parent === candidate.parent
  );
}

function progressLabel(progress: { complete: number; total: number } | null): string | null {
  if (progress === null || progress.total === 0) return null;
  return `${progress.complete}/${progress.total}`;
}

function ChangeNode({ change, selection, onSelect }: { change: TreeChange } & Omit<TreeProps, 'tree'>) {
  const changeSelection: Selection = { kind: 'change', id: change.name };
  return (
    <li>
      <button
        type="button"
        className="node"
        aria-selected={isSelected(selection, changeSelection)}
        onClick={() => onSelect(changeSelection)}
        data-testid={`change-${change.name}`}
      >
        <span className="tw">▾</span>
        <span className={`dot ${change.errorCount > 0 ? 'invalid' : 'done'}`} />
        <span className="nm mono">{change.name}</span>
        <span className="tail">
          {change.errorCount > 0
            ? `${change.errorCount} ош.`
            : (progressLabel(change.progress) ?? change.schema)}
        </span>
      </button>
      <ul>
        {change.artifacts.map((artifact) => {
          const artifactSelection: Selection = {
            kind: 'artifact',
            id: artifact.id,
            parent: change.name,
          };
          return (
            <li key={artifact.id}>
              <button
                type="button"
                className="node"
                aria-selected={isSelected(selection, artifactSelection)}
                onClick={() => onSelect(artifactSelection)}
                data-testid={`artifact-${change.name}-${artifact.id}`}
              >
                <span className="tw" />
                <span className={`dot ${artifact.state}`} data-state={artifact.state} />
                <span className="nm">{artifact.id}</span>
                <span className="tail">
                  {artifact.errorCount > 0
                    ? `${artifact.errorCount} ош.`
                    : (progressLabel(artifact.progress) ?? '')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function CapabilityNode({
  node,
  selection,
  onSelect,
}: { node: TreeCapability } & Omit<TreeProps, 'tree'>) {
  const capabilitySelection: Selection = { kind: 'capability', id: node.path };
  return (
    <li>
      <button
        type="button"
        className="node"
        aria-selected={isSelected(selection, capabilitySelection)}
        onClick={() => onSelect(capabilitySelection)}
        data-testid={`capability-${node.path}`}
      >
        <span className="tw">{node.children.length > 0 ? '▾' : ''}</span>
        <span className={`dot ${node.isSpec ? 'done' : 'missing'}`} />
        <span className="nm mono">{node.segment}</span>
        {node.requirementCount !== null && <span className="tail">{node.requirementCount}</span>}
      </button>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <CapabilityNode
              key={child.path}
              node={child}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function SchemaNode({ schema, selection, onSelect }: { schema: TreeSchema } & Omit<TreeProps, 'tree'>) {
  const schemaSelection: Selection = { kind: 'schema', id: schema.name };
  return (
    <li>
      <button
        type="button"
        className="node"
        aria-selected={isSelected(selection, schemaSelection)}
        onClick={() => onSelect(schemaSelection)}
        data-testid={`schema-${schema.name}`}
      >
        <span className="tw" />
        <span className="dot done" />
        <span className="nm mono">{schema.name}</span>
        <span className="tail">{schema.isDefault ? 'умолч.' : schema.source}</span>
      </button>
    </li>
  );
}

export function Tree({ tree, selection, onSelect }: TreeProps) {
  return (
    <ul className="tree">
      <li>
        <div className="grp">Изменения · {tree.changes.length}</div>
        {tree.changes.length === 0 ? (
          <p className="empty">Активных изменений нет</p>
        ) : (
          <ul>
            {tree.changes.map((change) => (
              <ChangeNode
                key={change.name}
                change={change}
                selection={selection}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}

        <div className="grp">Спеки · {tree.capabilities.length}</div>
        {tree.capabilities.length === 0 ? (
          <p className="empty">Пока ни одной capability</p>
        ) : (
          <ul>
            {tree.capabilities.map((node) => (
              <CapabilityNode
                key={node.path}
                node={node}
                selection={selection}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}

        <div className="grp">Процессы · {tree.schemas.length}</div>
        <ul>
          {tree.schemas.map((schema) => (
            <SchemaNode
              key={schema.name}
              schema={schema}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </ul>

        <div className="grp">Архив · {tree.archived.length}</div>
        {tree.archived.length === 0 ? (
          <p className="empty">Пусто</p>
        ) : (
          <ul>
            {tree.archived.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="node"
                  aria-selected={isSelected(selection, { kind: 'archived', id: name })}
                  onClick={() => onSelect({ kind: 'archived', id: name })}
                >
                  <span className="tw" />
                  <span className="dot missing" />
                  <span className="nm mono">{name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </li>
    </ul>
  );
}
