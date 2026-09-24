import type { TreeChange, WorkspaceTree } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { type TreeNode, buildTreeNodes, statusText } from './treeModel.js';

function change(overrides: Partial<TreeChange> = {}): TreeChange {
  return {
    name: 'add-export',
    schema: 'spec-driven',
    artifacts: [
      { id: 'proposal', outputPath: 'proposal.md', state: 'done', errorCount: 0, progress: null, files: ['proposal.md'] },
      {
        id: 'tasks',
        outputPath: 'tasks.md',
        state: 'draft',
        errorCount: 0,
        progress: { complete: 4, total: 11 },
        files: ['tasks.md'],
      },
    ],
    progress: { complete: 4, total: 11 },
    errorCount: 0,
    lastModified: null,
    schemaError: null,
    ...overrides,
  };
}

function tree(overrides: Partial<WorkspaceTree> = {}): WorkspaceTree {
  return { changes: [change()], capabilities: [], schemas: [], archived: [], ...overrides };
}

function nodes(workspace: WorkspaceTree, errors: string[] = []): readonly TreeNode[] {
  return buildTreeNodes({ state: 'ready', root: '/p', tree: workspace, errors });
}

function group(list: readonly TreeNode[], id: string): TreeNode {
  const found = list.find((node) => node.id === `group:${id}`);
  if (found === undefined) throw new Error(`нет группы ${id}`);
  return found;
}

describe('модель дерева VS Code', () => {
  it('строит четыре раздела', () => {
    expect(nodes(tree()).map((node) => node.label)).toEqual(['Изменения', 'Спеки', 'Процессы', 'Архив']);
  });

  it('показывает прогресс 4/11 у change без ошибок', () => {
    const [node] = group(nodes(tree()), 'changes').children;
    expect(node?.description).toBe('4/11');
    expect(node?.contextValue).toBe('change');
  });

  it('показывает число ошибок вместо прогресса', () => {
    const [node] = group(nodes(tree({ changes: [change({ errorCount: 3 })] })), 'changes').children;
    expect(node?.description).toBe('3 ош.');
    expect(node?.icon.color).toBe('errorForeground');
  });

  it('раскрывает артефакты собственной схемы, а не фиксированный перечень', () => {
    const custom = change({
      schema: 'team-flow',
      artifacts: ['research', 'proposal', 'spec-review', 'plan'].map((id) => ({
        id,
        outputPath: `${id}.md`,
        state: 'missing' as const,
        errorCount: 0,
        progress: null,
        files: [],
      })),
    });
    const [node] = group(nodes(tree({ changes: [custom] })), 'changes').children;
    expect(node?.children.map((child) => child.label)).toEqual(['research', 'proposal', 'spec-review', 'plan']);
  });

  it('существующий артефакт открывает файл, отсутствующий — предлагает создание', () => {
    const custom = change({
      artifacts: [
        { id: 'proposal', outputPath: 'proposal.md', state: 'done', errorCount: 0, progress: null, files: ['proposal.md'] },
        { id: 'specs', outputPath: 'specs/**/*.md', state: 'missing', errorCount: 0, progress: null, files: [] },
      ],
    });
    const [node] = group(nodes(tree({ changes: [custom] })), 'changes').children;
    expect(node?.children[0]?.action).toEqual({ kind: 'open', path: 'openspec/changes/add-export/proposal.md' });
    expect(node?.children[1]?.action).toEqual({
      kind: 'create-artifact',
      change: 'add-export',
      artifact: 'specs',
      perCapability: true,
    });
  });

  it('артефакт из нескольких файлов раскрывается в список файлов', () => {
    const custom = change({
      artifacts: [
        {
          id: 'specs',
          outputPath: 'specs/**/*.md',
          state: 'done',
          errorCount: 0,
          progress: null,
          files: ['specs/a/spec.md', 'specs/b/spec.md'],
        },
      ],
    });
    const [node] = group(nodes(tree({ changes: [custom] })), 'changes').children;
    expect(node?.children[0]?.children.map((child) => child.action)).toEqual([
      { kind: 'open', path: 'openspec/changes/add-export/specs/a/spec.md' },
      { kind: 'open', path: 'openspec/changes/add-export/specs/b/spec.md' },
    ]);
  });

  it('вложенные capability сохраняют полный путь и открывают спек', () => {
    const workspace = tree({
      capabilities: [
        {
          segment: 'identity',
          path: 'identity',
          isSpec: false,
          requirementCount: null,
          children: [
            { segment: 'user-auth', path: 'identity/user-auth', isSpec: true, requirementCount: 2, children: [] },
          ],
        },
      ],
    });
    const [identity] = group(nodes(workspace), 'specs').children;
    const leaf = identity?.children[0];
    expect(identity?.action).toBeUndefined();
    expect(leaf?.id).toBe('capability:identity/user-auth');
    expect(leaf?.action).toEqual({ kind: 'open', path: 'openspec/specs/identity/user-auth/spec.md' });
    expect(leaf?.description).toBe('требований: 2');
  });

  it('файл открывается только у проектной схемы', () => {
    const workspace = tree({
      schemas: [
        { name: 'spec-driven', description: null, source: 'package', artifacts: ['proposal'], isDefault: true },
        { name: 'team-flow', description: null, source: 'project', artifacts: ['research'], isDefault: false },
      ],
    });
    const [builtin, own] = group(nodes(workspace), 'schemas').children;
    expect(builtin?.action).toBeUndefined();
    expect(builtin?.description).toBe('package · по умолчанию');
    expect(own?.action).toEqual({ kind: 'open', path: 'openspec/schemas/team-flow/schema.yaml' });
  });

  it('ошибки чтения рабочего пространства выводятся над разделами', () => {
    const list = nodes(tree(), ['CLI не разобрал change x']);
    expect(list[0]?.label).toBe('CLI не разобрал change x');
    expect(list[0]?.icon.id).toBe('warning');
  });

  it('в неготовом состоянии дерево пусто, а строка состояния объясняет причину', () => {
    expect(buildTreeNodes({ state: 'not-initialized' })).toEqual([]);
    expect(statusText({ state: 'cli-missing' }).text).toContain('нет CLI');
  });

  it('строка состояния считает changes и спеки, включая вложенные', () => {
    const workspace = tree({
      changes: [change(), change({ name: 'b' })],
      capabilities: [
        {
          segment: 'identity',
          path: 'identity',
          isSpec: true,
          requirementCount: 1,
          children: [{ segment: 'x', path: 'identity/x', isSpec: true, requirementCount: 1, children: [] }],
        },
      ],
    });
    expect(statusText({ state: 'ready', root: '/p', tree: workspace, errors: [] }).text).toBe(
      '$(git-pull-request) 2 · $(book) 2',
    );
  });
});
