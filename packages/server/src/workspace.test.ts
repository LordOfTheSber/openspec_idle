import { fileURLToPath } from 'node:url';
import { canonicalize } from './fs/workspace.js';
import { describe, expect, it } from 'vitest';
import { OpenspecClient } from './openspec/client.js';
import { WorkspaceReader } from './workspace.js';

const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

function reader(fixture: string): WorkspaceReader {
  const root = canonicalize(
    fileURLToPath(new URL(`../../../tests/fixtures/${fixture}`, import.meta.url)),
  );
  return new WorkspaceReader(new OpenspecClient({ root, bin: OPENSPEC_BIN }));
}

describe('чтение рабочего пространства', () => {
  it('на встроенной схеме собирает change с его артефактами', async () => {
    const { tree, errors } = await reader('full-change').readTree();

    expect(errors).toHaveLength(0);
    const change = tree.changes.find((c) => c.name === 'full-feature');
    expect(change?.schema).toBe('spec-driven');
    expect(change?.artifacts.map((a) => a.id)).toEqual(['proposal', 'specs', 'design', 'tasks']);
    expect(change?.progress).toEqual({ complete: 2, total: 4 });
  });

  it('прогресс привязан к артефакту, объявленному отслеживаемым', async () => {
    const { tree } = await reader('full-change').readTree();
    const change = tree.changes.find((c) => c.name === 'full-feature');

    expect(change?.artifacts.find((a) => a.id === 'tasks')?.progress).toEqual({
      complete: 2,
      total: 4,
    });
    expect(change?.artifacts.find((a) => a.id === 'proposal')?.progress).toBeNull();
  });

  it('на собственной схеме берёт её артефакты и её отслеживаемый файл', async () => {
    const { tree } = await reader('custom-schema').readTree();
    const change = tree.changes.find((c) => c.name === 'team-feature');

    expect(change?.schema).toBe('team-flow');
    expect(change?.artifacts.map((a) => a.id)).toEqual([
      'research',
      'proposal',
      'specs',
      'spec-review',
      'design',
      'plan',
    ]);
    expect(change?.artifacts.find((a) => a.id === 'plan')?.progress).toEqual({
      complete: 1,
      total: 3,
    });
    expect(change?.artifacts.find((a) => a.id === 'research')?.progress).toBeNull();
  });

  it('отмечает схему проекта по умолчанию и источник схем', async () => {
    const { tree } = await reader('custom-schema').readTree();
    const byName = new Map(tree.schemas.map((s) => [s.name, s]));

    expect(byName.get('team-flow')?.isDefault).toBe(true);
    expect(byName.get('team-flow')?.source).toBe('project');
    expect(byName.get('spec-driven')?.isDefault).toBe(false);
  });

  it('change без артефактов помечает их отсутствующими', async () => {
    const { tree } = await reader('bare-change').readTree();
    const change = tree.changes.find((c) => c.name === 'bare-feature');

    expect(change?.artifacts.every((a) => a.state === 'missing')).toBe(true);
    expect(change?.errorCount).toBeGreaterThan(0);
  });

  it('основные спеки и архив попадают в дерево', async () => {
    const { tree } = await reader('archived').readTree();

    expect(tree.capabilities.map((c) => c.path)).toContain('data-export');
    expect(tree.archived).toContain('2026-01-10-add-data-export');
  });

  it('пустой проект даёт пустое дерево без ошибок', async () => {
    const { tree, errors } = await reader('empty').readTree();

    expect(errors).toHaveLength(0);
    expect(tree.changes).toHaveLength(0);
    expect(tree.capabilities).toHaveLength(0);
    expect(tree.archived).toHaveLength(0);
  });
});

describe('поиск по рабочему пространству', () => {
  it('находит требование в дельте change и ведёт к файлу и строке', async () => {
    const instance = reader('full-change');
    const { tree } = await instance.readTree();
    const index = await instance.buildSearchIndex(tree);

    const hits = index.search('выгрузка данных', ['requirement']);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.owner).toBe('full-feature');
    expect(hits[0]?.file).toContain('specs/data-export/spec.md');
    expect(hits[0]?.line).toBeGreaterThan(0);
  });

  it('находит сценарий и ограничивает выдачу фильтром', async () => {
    const instance = reader('full-change');
    const { tree } = await instance.readTree();
    const index = await instance.buildSearchIndex(tree);

    const hits = index.search('успешная', ['scenario']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.kind === 'scenario')).toBe(true);
  });

  it('индексирует основные спеки, а не только дельты', async () => {
    const instance = reader('archived');
    const { tree } = await instance.readTree();
    const index = await instance.buildSearchIndex(tree);

    const hits = index.search('выгрузка данных', ['requirement']);
    expect(hits[0]?.owner).toBe('data-export');
  });

  it('индексирует имена схем процесса', async () => {
    const instance = reader('custom-schema');
    const { tree } = await instance.readTree();
    const index = await instance.buildSearchIndex(tree);

    expect(index.search('team-flow', ['schema'])).toHaveLength(1);
  });
});
