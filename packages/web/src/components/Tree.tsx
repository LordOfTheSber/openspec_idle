import { useState } from 'react';
import { groupModules, type TreeCapability, type TreeChange, type TreeSchema, type WorkspaceTree } from '@openspec-ide/core';
import type { ModulesView } from '../lib/api.js';

/** Что выбрано в дереве. */
export interface Selection {
  readonly kind: 'change' | 'artifact' | 'capability' | 'schema' | 'archived';
  readonly id: string;
  readonly parent?: string;
  /** Конкретный файл артефакта, порождающего несколько файлов (дельты спеков). */
  readonly file?: string;
  /** Якорь требования в спеке capability. */
  readonly anchor?: string | null;
}

interface TreeProps {
  readonly tree: WorkspaceTree;
  readonly modules?: ModulesView | null;
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

function ChangeNode({
  change,
  selection,
  onSelect,
  compact = false,
  crossCutting = false,
}: { change: TreeChange; compact?: boolean; crossCutting?: boolean } & Omit<TreeProps, 'tree'>) {
  const changeSelection: Selection = { kind: 'change', id: change.name };
  // В дереве по модулям артефакты раскрываются только у выбранного change:
  // сквозной change стоит под несколькими модулями.
  const expanded =
    !compact || (selection !== null && (selection.id === change.name || selection.parent === change.name));
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
        {crossCutting && (
          <span className="x" data-testid="cross-cutting">
            сквозной
          </span>
        )}
        <span className="tail">
          {change.errorCount > 0
            ? `${change.errorCount} ош.`
            : (progressLabel(change.progress) ?? change.schema)}
        </span>
      </button>
      {expanded && (
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
      )}
    </li>
  );
}

/** Спек в дереве по модулям — одной строкой с полным путём. */
function SpecLeaf({ path, count, selection, onSelect }: { path: string; count: number | null } & Omit<TreeProps, 'tree'>) {
  const capabilitySelection: Selection = { kind: 'capability', id: path };
  return (
    <li>
      <button
        type="button"
        className="node"
        aria-selected={isSelected(selection, capabilitySelection)}
        onClick={() => onSelect(capabilitySelection)}
        data-testid={`capability-${path}`}
      >
        <span className="tw" />
        <span className="dot done" />
        <span className="nm mono">{path}</span>
        {count !== null && <span className="tail">{count}</span>}
      </button>
    </li>
  );
}

function specCounts(nodes: readonly TreeCapability[], into: Map<string, number | null> = new Map()): Map<string, number | null> {
  for (const node of nodes) {
    if (node.isSpec) into.set(node.path, node.requirementCount);
    specCounts(node.children, into);
  }
  return into;
}

/** Дерево по модулям: группы, модули, их changes и спеки, затем «вне модулей». */
function ModuleTree({ tree, modules, selection, onSelect }: TreeProps & { modules: ModulesView }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { overlay } = modules;
  const counts = specCounts(tree.capabilities);
  const changesOf = (id: string): TreeChange[] => tree.changes.filter((change) => overlay.changes[change.name]?.includes(id));
  const specsOf = (id: string): string[] => [...counts.keys()].filter((path) => overlay.capabilities[path] === id);
  const looseChanges = tree.changes.filter((change) => (overlay.changes[change.name] ?? []).length === 0);
  const looseSpecs = [...counts.keys()].filter((path) => (overlay.capabilities[path] ?? null) === null);
  const toggle = (id: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      {groupModules(modules.map.modules).map((group) => (
        <li key={group.title}>
          <div className="grp">
            {group.title} · {group.modules.length}
          </div>
          <ul>
            {group.modules.map((module) => {
              const changes = changesOf(module.id);
              const specs = specsOf(module.id);
              const open = !collapsed.has(module.id);
              return (
                <li key={module.id} data-testid={`tree-module-${module.id}`}>
                  <button type="button" className="node module" onClick={() => toggle(module.id)} aria-expanded={open}>
                    <span className="tw">{open ? '▾' : '▸'}</span>
                    <span className={`kind ${module.kind}`}>{module.kind === 'service' ? 'S' : module.kind === 'ui' ? 'U' : 'L'}</span>
                    <span className="nm mono">{module.id}</span>
                    <span className="tail">{changes.length > 0 ? changes.length : ''}</span>
                  </button>
                  {open && (changes.length > 0 || specs.length > 0) && (
                    <ul>
                      {changes.map((change) => (
                        <ChangeNode
                          key={change.name}
                          change={change}
                          selection={selection}
                          onSelect={onSelect}
                          compact
                          crossCutting={(overlay.changes[change.name]?.length ?? 0) > 1}
                        />
                      ))}
                      {specs.map((path) => (
                        <SpecLeaf key={path} path={path} count={counts.get(path) ?? null} selection={selection} onSelect={onSelect} />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
      <li data-testid="tree-outside-modules">
        <div className="grp">Вне модулей · {looseChanges.length + looseSpecs.length}</div>
        {looseChanges.length + looseSpecs.length === 0 ? (
          <p className="empty">Всё распределено по модулям</p>
        ) : (
          <ul>
            {looseChanges.map((change) => (
              <ChangeNode key={change.name} change={change} selection={selection} onSelect={onSelect} compact />
            ))}
            {looseSpecs.map((path) => (
              <SpecLeaf key={path} path={path} count={counts.get(path) ?? null} selection={selection} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </li>
    </>
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

export function Tree({ tree, modules = null, selection, onSelect }: TreeProps) {
  const byModules = modules !== null && modules.map.modules.length > 0;
  return (
    <ul className="tree">
      {byModules && <ModuleTree tree={tree} modules={modules} selection={selection} onSelect={onSelect} />}
      <li>
        {!byModules && (
          <>
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

          </>
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
