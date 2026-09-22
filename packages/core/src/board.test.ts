import { describe, expect, it } from 'vitest';
import {
  type BoardChange,
  type BoardSchema,
  buildBoard,
  mergeOrders,
  topologicalOrder,
} from './board.js';

const SPEC_DRIVEN: BoardSchema = {
  name: 'spec-driven',
  artifacts: [
    { id: 'proposal', requires: [] },
    { id: 'specs', requires: ['proposal'] },
    { id: 'design', requires: ['proposal'] },
    { id: 'tasks', requires: ['specs', 'design'] },
  ],
  trackedArtifactId: 'tasks',
};

const TEAM_FLOW: BoardSchema = {
  name: 'team-flow',
  artifacts: [
    { id: 'research', requires: [] },
    { id: 'proposal', requires: ['research'] },
    { id: 'specs', requires: ['proposal'] },
    { id: 'spec-review', requires: ['specs'] },
    { id: 'design', requires: ['specs'] },
    { id: 'plan', requires: ['spec-review', 'design'] },
  ],
  trackedArtifactId: 'plan',
};

function change(overrides: Partial<BoardChange> = {}): BoardChange {
  return {
    name: 'x',
    schema: 'spec-driven',
    artifacts: [
      { id: 'proposal', done: true },
      { id: 'specs', done: true },
      { id: 'design', done: true },
      { id: 'tasks', done: true },
    ],
    progress: { complete: 0, total: 0 },
    errorCount: 0,
    validationUnknown: false,
    lastModified: null,
    ...overrides,
  };
}

describe('порядок артефактов по зависимостям', () => {
  it('зависимость идёт раньше зависящего', () => {
    const order = topologicalOrder(SPEC_DRIVEN);

    expect(order.indexOf('proposal')).toBeLessThan(order.indexOf('specs'));
    expect(order.indexOf('specs')).toBeLessThan(order.indexOf('tasks'));
    expect(order.indexOf('design')).toBeLessThan(order.indexOf('tasks'));
  });

  it('ветвление разворачивается в последовательность, сходящуюся перед планом', () => {
    const order = topologicalOrder(TEAM_FLOW);

    expect(order[0]).toBe('research');
    expect(order.at(-1)).toBe('plan');
    expect(order.indexOf('spec-review')).toBeLessThan(order.indexOf('plan'));
    expect(order.indexOf('design')).toBeLessThan(order.indexOf('plan'));
  });

  it('цикл не роняет порядок — артефакты всё равно попадают в список', () => {
    const cyclic: BoardSchema = {
      name: 'cyclic',
      artifacts: [
        { id: 'a', requires: ['b'] },
        { id: 'b', requires: ['a'] },
      ],
      trackedArtifactId: null,
    };

    expect(topologicalOrder(cyclic).sort()).toEqual(['a', 'b']);
  });

  it('неизвестная зависимость игнорируется', () => {
    const odd: BoardSchema = {
      name: 'odd',
      artifacts: [{ id: 'a', requires: ['нет-такого'] }],
      trackedArtifactId: null,
    };

    expect(topologicalOrder(odd)).toEqual(['a']);
  });
});

describe('колонки доски', () => {
  it('на встроенной схеме колонки идут по зависимостям и заканчиваются рабочими', () => {
    const board = buildBoard([SPEC_DRIVEN], [change()]);

    expect(board.columns.map((column) => column.id)).toEqual([
      'proposal',
      'specs',
      'design',
      'tasks',
      'ready',
      'in-progress',
      'to-archive',
    ]);
  });

  it('собственная схема добавляет свои колонки перед предложением и после спеков', () => {
    const board = buildBoard([TEAM_FLOW], [change({ schema: 'team-flow', artifacts: [] })]);
    const ids = board.columns.map((column) => column.id);

    expect(ids.indexOf('research')).toBeLessThan(ids.indexOf('proposal'));
    expect(ids).toContain('spec-review');
  });

  it('changes на разных схемах дают объединённый набор колонок', () => {
    const board = buildBoard(
      [SPEC_DRIVEN, TEAM_FLOW],
      [change({ name: 'a' }), change({ name: 'b', schema: 'team-flow', artifacts: [] })],
    );
    const ids = board.columns.filter((column) => column.isArtifact).map((column) => column.id);

    expect(ids).toContain('research');
    expect(ids).toContain('spec-review');
    expect(ids.indexOf('proposal')).toBeLessThan(ids.indexOf('specs'));
    // Одноимённый артефакт становится одной колонкой, а не двумя.
    expect(ids.filter((id) => id === 'proposal')).toHaveLength(1);
  });

  it('колонка знает, каким схемам она принадлежит', () => {
    const board = buildBoard(
      [SPEC_DRIVEN, TEAM_FLOW],
      [change({ name: 'a' }), change({ name: 'b', schema: 'team-flow', artifacts: [] })],
    );
    const research = board.columns.find((column) => column.id === 'research');
    const proposal = board.columns.find((column) => column.id === 'proposal');

    expect(research?.schemas).toEqual(['team-flow']);
    expect(proposal?.schemas.sort()).toEqual(['spec-driven', 'team-flow']);
  });

  it('объединение сохраняет относительный порядок каждой схемы', () => {
    const merged = mergeOrders([
      { name: 'a', order: ['proposal', 'specs', 'tasks'] },
      { name: 'b', order: ['research', 'proposal', 'review', 'specs', 'plan'] },
    ]);

    const ids = merged.map((entry) => entry.id);
    expect(ids.indexOf('research')).toBeLessThan(ids.indexOf('proposal'));
    expect(ids.indexOf('review')).toBeLessThan(ids.indexOf('specs'));
    expect(ids.indexOf('specs')).toBeLessThan(ids.indexOf('tasks'));
  });
});

describe('размещение карточки', () => {
  it('change без артефактов стоит в колонке первого артефакта схемы', () => {
    const board = buildBoard([SPEC_DRIVEN], [change({ artifacts: [] })]);
    expect(board.cards[0]?.column).toBe('proposal');
  });

  it('карточка стоит в колонке первого незаполненного артефакта', () => {
    const board = buildBoard(
      [SPEC_DRIVEN],
      [
        change({
          artifacts: [
            { id: 'proposal', done: true },
            { id: 'specs', done: true },
            { id: 'design', done: false },
            { id: 'tasks', done: false },
          ],
        }),
      ],
    );

    expect(board.cards[0]?.column).toBe('design');
  });

  it('планирование завершено, работа не начата — «Готово к работе»', () => {
    const board = buildBoard(
      [SPEC_DRIVEN],
      [change({ progress: { complete: 0, total: 11 } })],
    );
    expect(board.cards[0]?.column).toBe('ready');
  });

  it('часть пунктов выполнена — «В работе»', () => {
    const board = buildBoard([SPEC_DRIVEN], [change({ progress: { complete: 4, total: 11 } })]);
    expect(board.cards[0]?.column).toBe('in-progress');
  });

  it('все пункты выполнены — «Готово к архивации»', () => {
    const board = buildBoard([SPEC_DRIVEN], [change({ progress: { complete: 11, total: 11 } })]);
    expect(board.cards[0]?.column).toBe('to-archive');
  });

  it('change на собственной схеме стоит в колонке её артефакта', () => {
    const board = buildBoard(
      [TEAM_FLOW],
      [
        change({
          schema: 'team-flow',
          artifacts: [
            { id: 'research', done: true },
            { id: 'proposal', done: true },
            { id: 'specs', done: true },
            { id: 'spec-review', done: false },
            { id: 'design', done: true },
            { id: 'plan', done: false },
          ],
        }),
      ],
    );

    expect(board.cards[0]?.column).toBe('spec-review');
  });

  it('карточка несёт имя схемы, результат валидации и прогресс', () => {
    const board = buildBoard(
      [SPEC_DRIVEN],
      [
        change({
          schema: 'spec-driven',
          progress: { complete: 4, total: 11 },
          errorCount: 2,
          validationUnknown: false,
          lastModified: '2026-03-01T10:00:00.000Z',
        }),
      ],
    );
    const card = board.cards[0];

    expect(card?.schema).toBe('spec-driven');
    expect(card?.errorCount).toBe(2);
    expect(card?.progress).toEqual({ complete: 4, total: 11 });
    expect(card?.lastModified).toBe('2026-03-01T10:00:00.000Z');
  });

  it('новый change отмечен как ни разу не проверявшийся', () => {
    const board = buildBoard([SPEC_DRIVEN], [change({ validationUnknown: true })]);
    expect(board.cards[0]?.validationUnknown).toBe(true);
  });
});
