import { describe, expect, it } from 'vitest';
import { buildCapabilityTree, buildWorkspaceTree, type TreeInput } from './workspaceTree.js';

function input(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    changes: [],
    specs: [],
    schemas: [],
    defaultSchema: 'spec-driven',
    archived: [],
    ...overrides,
  };
}

describe('дерево capability', () => {
  it('сохраняет вложенность путей', () => {
    const tree = buildCapabilityTree([{ id: 'identity/user-auth', requirementCount: 3 }]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.segment).toBe('identity');
    expect(tree[0]?.isSpec).toBe(false);
    expect(tree[0]?.children[0]).toMatchObject({
      segment: 'user-auth',
      path: 'identity/user-auth',
      isSpec: true,
      requirementCount: 3,
    });
  });

  it('не схлопывает разные capability с совпадающим последним сегментом', () => {
    const tree = buildCapabilityTree([
      { id: 'identity/user-auth' },
      { id: 'billing/user-auth' },
    ]);

    expect(tree.map((node) => node.segment).sort()).toEqual(['billing', 'identity']);
    const paths = tree.flatMap((node) => node.children.map((child) => child.path));
    expect(paths.sort()).toEqual(['billing/user-auth', 'identity/user-auth']);
  });

  it('плоская организация остаётся плоской', () => {
    const tree = buildCapabilityTree([{ id: 'data-export' }, { id: 'agent-bridge' }]);
    expect(tree.every((node) => node.isSpec && node.children.length === 0)).toBe(true);
  });

  it('промежуточный сегмент, у которого есть и свой спек, помечается спеком', () => {
    const tree = buildCapabilityTree([{ id: 'identity' }, { id: 'identity/user-auth' }]);

    expect(tree[0]?.isSpec).toBe(true);
    expect(tree[0]?.children[0]?.isSpec).toBe(true);
  });
});

describe('дерево changes', () => {
  const artifacts = [
    { id: 'proposal', outputPath: 'proposal.md', existingOutputPaths: ['proposal.md'], status: 'done' },
    { id: 'specs', outputPath: 'specs/**/*.md', existingOutputPaths: ['specs/a/spec.md'], status: 'done' },
    { id: 'design', outputPath: 'design.md', existingOutputPaths: [], status: 'ready' },
    { id: 'tasks', outputPath: 'tasks.md', existingOutputPaths: ['tasks.md'], status: 'done' },
  ];

  it('отсутствующий артефакт помечается состоянием «отсутствует»', () => {
    const tree = buildWorkspaceTree(
      input({
        changes: [
          {
            name: 'x',
            schema: 'spec-driven',
            progress: { complete: 0, total: 0 },
            trackedArtifactId: 'tasks',
            artifacts,
            issues: [],
          },
        ],
      }),
    );

    const design = tree.changes[0]?.artifacts.find((a) => a.id === 'design');
    expect(design?.state).toBe('missing');
  });

  it('артефакт с ошибкой валидации помечается и несёт число ошибок', () => {
    const tree = buildWorkspaceTree(
      input({
        changes: [
          {
            name: 'x',
            schema: 'spec-driven',
            progress: null,
            trackedArtifactId: 'tasks',
            artifacts,
            issues: [
              { level: 'ERROR', path: 'specs/a/spec.md' },
              { level: 'ERROR', path: 'specs/a/spec.md' },
              { level: 'WARNING', path: 'specs/a/spec.md' },
            ],
          },
        ],
      }),
    );

    const specs = tree.changes[0]?.artifacts.find((a) => a.id === 'specs');
    expect(specs?.state).toBe('invalid');
    expect(specs?.errorCount).toBe(2);
    expect(tree.changes[0]?.errorCount).toBe(2);
  });

  it('прогресс показывается только у отслеживаемого артефакта', () => {
    const tree = buildWorkspaceTree(
      input({
        changes: [
          {
            name: 'x',
            schema: 'spec-driven',
            progress: { complete: 4, total: 11 },
            trackedArtifactId: 'tasks',
            artifacts,
            issues: [],
          },
        ],
      }),
    );

    const byId = new Map(tree.changes[0]?.artifacts.map((a) => [a.id, a]) ?? []);
    expect(byId.get('tasks')?.progress).toEqual({ complete: 4, total: 11 });
    expect(byId.get('proposal')?.progress).toBeNull();
  });

  it('состав артефактов берётся из схемы change, а не из фиксированного списка', () => {
    const tree = buildWorkspaceTree(
      input({
        changes: [
          {
            name: 'team-feature',
            schema: 'team-flow',
            progress: { complete: 1, total: 3 },
            trackedArtifactId: 'plan',
            artifacts: [
              { id: 'research', outputPath: 'research.md', existingOutputPaths: ['research.md'] },
              { id: 'spec-review', outputPath: 'review.md', existingOutputPaths: ['review.md'] },
              { id: 'plan', outputPath: 'plan.md', existingOutputPaths: ['plan.md'] },
            ],
            issues: [],
          },
        ],
      }),
    );

    const change = tree.changes[0];
    expect(change?.schema).toBe('team-flow');
    expect(change?.artifacts.map((a) => a.id)).toEqual(['research', 'spec-review', 'plan']);
    expect(change?.artifacts.find((a) => a.id === 'plan')?.progress).toEqual({
      complete: 1,
      total: 3,
    });
  });

  it('замечание без узнаваемого пути не приписывается артефакту', () => {
    const tree = buildWorkspaceTree(
      input({
        changes: [
          {
            name: 'x',
            schema: 'spec-driven',
            progress: null,
            trackedArtifactId: null,
            artifacts,
            issues: [{ level: 'ERROR', path: 'file' }],
          },
        ],
      }),
    );

    expect(tree.changes[0]?.artifacts.every((a) => a.errorCount === 0)).toBe(true);
    expect(tree.changes[0]?.errorCount).toBe(1);
  });

  it('нерешаемая схема change отражается отдельным полем', () => {
    const tree = buildWorkspaceTree(
      input({
        changes: [
          {
            name: 'x',
            schema: 'нет-такой',
            progress: null,
            trackedArtifactId: null,
            artifacts: [],
            issues: [],
            schemaError: 'Схема «нет-такой» не разрешается',
          },
        ],
      }),
    );

    expect(tree.changes[0]?.schemaError).toContain('не разрешается');
  });
});

describe('дерево схем', () => {
  it('отмечает схему проекта по умолчанию', () => {
    const tree = buildWorkspaceTree(
      input({
        defaultSchema: 'team-flow',
        schemas: [
          { name: 'spec-driven', source: 'package', artifacts: ['proposal'] },
          { name: 'team-flow', source: 'project', artifacts: ['research', 'plan'] },
        ],
      }),
    );

    const byName = new Map(tree.schemas.map((s) => [s.name, s]));
    expect(byName.get('team-flow')?.isDefault).toBe(true);
    expect(byName.get('spec-driven')?.isDefault).toBe(false);
    expect(byName.get('team-flow')?.source).toBe('project');
  });
});
