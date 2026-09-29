import type { BoardCard } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { buildThread, threadCaption } from './thread.js';

function card(patch: Partial<BoardCard>): BoardCard {
  return {
    change: 'c',
    schema: 'spec-driven',
    column: 'ready',
    artifacts: [
      { id: 'proposal', done: true, path: 'openspec/changes/c/proposal.md' },
      { id: 'specs', done: true, path: 'openspec/changes/c/specs/a/spec.md' },
      { id: 'design', done: true, path: 'openspec/changes/c/design.md' },
      { id: 'tasks', done: true, path: 'openspec/changes/c/tasks.md' },
    ],
    progress: { complete: 0, total: 3 },
    errorCount: 0,
    validationUnknown: true,
    lastModified: null,
    waivers: [],
    ...patch,
  };
}

describe('нить change', () => {
  it('первый отсутствующий артефакт колонки — следующий шаг, дальше — не начаты', () => {
    const thread = buildThread(
      card({
        column: 'specs',
        artifacts: [
          { id: 'proposal', done: true, path: 'p' },
          { id: 'specs', done: false, path: null },
          { id: 'design', done: false, path: null },
          { id: 'tasks', done: false, path: null },
        ],
        progress: null,
      }),
    );

    expect(thread.nodes.map((node) => node.state)).toEqual(['done', 'next', 'todo', 'todo']);
    expect(thread.next).toBe('specs');
    expect(thread.fill).toBe(0);
  });

  it('созданный после пропуска артефакт считается созданным', () => {
    const thread = buildThread(
      card({
        column: 'design',
        artifacts: [
          { id: 'proposal', done: true, path: 'p' },
          { id: 'specs', done: true, path: 's' },
          { id: 'design', done: false, path: null },
          { id: 'tasks', done: true, path: 't' },
        ],
        progress: { complete: 3, total: 3 },
      }),
    );

    expect(thread.nodes.map((node) => node.state)).toEqual(['done', 'done', 'next', 'done']);
    expect(thread.fill).toBe(100);
    expect(thread.archive).toBe('todo');
  });

  it('в рабочей колонке отсутствующий артефакт пропущен', () => {
    const base = card({});
    const thread = buildThread({
      ...base,
      column: 'in-progress',
      artifacts: base.artifacts.map((artifact) => (artifact.id === 'design' ? { ...artifact, done: false, path: null } : artifact)),
    });

    expect(thread.nodes.find((node) => node.id === 'design')?.state).toBe('skipped');
  });

  it('заполнение отрезка перед архивом — доля пунктов плана, в «Готово к архивации» архив готов', () => {
    expect(buildThread(card({ column: 'in-progress', progress: { complete: 2, total: 3 } })).fill).toBe(67);
    expect(buildThread(card({ column: 'to-archive', progress: { complete: 3, total: 3 } })).archive).toBe('ready');
  });

  it('подпись называет следующий шаг и прогресс плана', () => {
    const value = card({ column: 'in-progress', progress: { complete: 2, total: 4 } });
    expect(threadCaption(value, buildThread(value))).toBe('реализация · 2/4 пунктов');
  });
});
