import type { TreeChange } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { columnTitle, phaseOf } from './phase.js';

function change(patch: Partial<TreeChange>): TreeChange {
  return {
    name: 'c',
    schema: 'spec-driven',
    artifacts: [
      { id: 'proposal', outputPath: 'proposal.md', state: 'done', errorCount: 0, progress: null, files: ['proposal.md'] },
      { id: 'tasks', outputPath: 'tasks.md', state: 'done', errorCount: 0, progress: null, files: ['tasks.md'] },
    ],
    progress: { complete: 1, total: 2 },
    errorCount: 0,
    lastModified: null,
    schemaError: null,
    ...patch,
  };
}

describe('фаза change для переключателя', () => {
  it('первый несозданный артефакт', () => {
    const value = change({});
    expect(
      phaseOf({ ...value, artifacts: value.artifacts.map((item) => (item.id === 'tasks' ? { ...item, state: 'missing' } : item)) }),
    ).toBe('tasks');
  });

  it('по прогрессу плана', () => {
    expect(columnTitle(phaseOf(change({})))).toBe('В работе');
    expect(phaseOf(change({ progress: { complete: 2, total: 2 } }))).toBe('to-archive');
    expect(phaseOf(change({ progress: { complete: 0, total: 2 } }))).toBe('ready');
  });
});
