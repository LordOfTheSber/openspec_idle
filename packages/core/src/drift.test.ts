import { describe, expect, it } from 'vitest';
import type { AuthoringSources } from './authoring.js';
import {
  archiveOrder,
  archivedTouches,
  buildDriftReport,
  compareBaseline,
  findOverlaps,
  forgottenDays,
} from './drift.js';

const MAIN_BEFORE = [
  '# data-export',
  '',
  '## Requirements',
  '',
  '### Requirement: Выгрузка данных',
  'Система ДОЛЖНА выгружать CSV.',
  '',
  '#### Scenario: Успешная выгрузка',
  '- **WHEN** запрос',
  '- **THEN** файл CSV',
  '',
  '#### Scenario: Пустой набор данных',
  '- **WHEN** данных нет',
  '- **THEN** пустой файл',
  '',
].join('\n');

const MAIN_NOW = MAIN_BEFORE.replace('- **THEN** файл CSV', '- **THEN** файл CSV с заголовком');

const modified = (name: string): string => `## MODIFIED Requirements\n\n### Requirement: ${name}\nТекст.\n\n#### Scenario: Успешная выгрузка\n- **WHEN** a\n- **THEN** b\n`;
const added = (name: string): string => `## ADDED Requirements\n\n### Requirement: ${name}\nТекст.\n\n#### Scenario: С\n- **WHEN** a\n- **THEN** b\n`;

function sources(a: string, b: string, main = MAIN_NOW): AuthoringSources {
  return {
    mainSpecs: [{ capability: 'data-export', path: 'openspec/specs/data-export/spec.md', text: main }],
    changes: [
      { name: 'add-limits', deltas: [{ capability: 'data-export', path: 'openspec/changes/add-limits/specs/data-export/spec.md', text: a }], plan: null },
      { name: 'rework-export', deltas: [{ capability: 'data-export', path: 'openspec/changes/rework-export/specs/data-export/spec.md', text: b }], plan: null },
    ],
  };
}

describe('пересечения', () => {
  it('два change изменяют одно требование', () => {
    const overlaps = findOverlaps(sources(modified('Выгрузка данных'), modified('Выгрузка данных')));
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.requirement).toBe('Выгрузка данных');
    expect(overlaps[0]?.touches.map((touch) => [touch.change, touch.operation, touch.line])).toEqual([
      ['add-limits', 'MODIFIED', 3],
      ['rework-export', 'MODIFIED', 3],
    ]);
  });

  it('разные требования одной capability не пересекаются, одинаковые ADDED — пересекаются', () => {
    expect(findOverlaps(sources(added('Первое'), added('Второе')))).toEqual([]);
    expect(findOverlaps(sources(added('Лимиты'), added('Лимиты')))).toHaveLength(1);
  });

  it('RENAMED считается по прежнему имени', () => {
    const renamed = '## RENAMED Requirements\n\n- FROM: `### Requirement: Выгрузка данных`\n- TO: `### Requirement: Экспорт`\n';
    const [overlap] = findOverlaps(sources(modified('Выгрузка данных'), renamed));
    expect(overlap?.touches.map((touch) => touch.operation)).toEqual(['MODIFIED', 'RENAMED']);
  });
});

describe('сравнение с базовой версией', () => {
  it('изменённый сценарий основного спека', () => {
    const drift = compareBaseline(MAIN_BEFORE, MAIN_NOW, 'Выгрузка данных');
    expect(drift?.changedScenarios).toEqual(['Успешная выгрузка']);
    expect(drift?.addedScenarios).toEqual([]);
    expect(drift?.before).toContain('- **THEN** файл CSV\n');
    expect(drift?.after).toContain('с заголовком');
  });

  it('не изменилось или не было — null; удалено из основного — отмечено', () => {
    expect(compareBaseline(MAIN_BEFORE, MAIN_BEFORE, 'Выгрузка данных')).toBeNull();
    expect(compareBaseline(MAIN_BEFORE, MAIN_NOW, 'Нет такого')).toBeNull();
    expect(compareBaseline(null, MAIN_NOW, 'Выгрузка данных')).toBeNull();
    expect(compareBaseline(MAIN_BEFORE, '# пусто\n', 'Выгрузка данных')?.removedFromMain).toBe(true);
  });
});

describe('отчёт', () => {
  const changes = [
    { name: 'add-limits', created: '2026-09-20', lastActivity: '2026-09-24T10:00:00Z', readyToArchive: true },
    { name: 'rework-export', created: '2026-09-21', lastActivity: '2026-09-29T10:00:00Z', readyToArchive: false },
  ];
  const archived = archivedTouches([
    { name: '2026-09-25-tune-export', deltas: [{ capability: 'data-export', text: modified('Выгрузка данных') }] },
    { name: '2026-09-10-old', deltas: [{ capability: 'data-export', text: modified('Выгрузка данных') }] },
  ]);

  it('основной спек изменился после начала change — требование устарело', () => {
    const report = buildDriftReport({
      sources: sources(modified('Выгрузка данных'), added('Другое')),
      git: true,
      now: '2026-09-30T00:00:00Z',
      changes,
      baselines: {
        'openspec/changes/add-limits/specs/data-export/spec.md': { commit: 'abcdef123456', date: '2026-09-20T09:00:00Z', mainSpec: MAIN_BEFORE },
        'openspec/changes/rework-export/specs/data-export/spec.md': null,
      },
      archived,
    });
    const [stale] = report.changes['add-limits']?.stale ?? [];
    expect(stale).toMatchObject({
      certainty: 'stale',
      baseline: 'abcdef1',
      changedScenarios: ['Успешная выгрузка'],
      archivedAfter: ['2026-09-25-tune-export'],
      line: 3,
    });
    expect(report.changes['rework-export']?.stale).toEqual([]);
  });

  it('незакоммиченная дельта не устарела', () => {
    const report = buildDriftReport({
      sources: sources(modified('Выгрузка данных'), added('Другое')),
      git: true,
      now: '2026-09-30T00:00:00Z',
      changes,
      baselines: { 'openspec/changes/add-limits/specs/data-export/spec.md': null },
      archived,
    });
    expect(report.changes['add-limits']?.stale).toEqual([]);
  });

  it('без git — «возможно устарела» по архиву, включая день создания', () => {
    const report = buildDriftReport({
      sources: sources(modified('Выгрузка данных'), added('Другое')),
      git: false,
      now: '2026-09-30T00:00:00Z',
      changes: [{ ...changes[0]!, created: '2026-09-25' }, changes[1]!],
      baselines: {},
      archived,
    });
    expect(report.changes['add-limits']?.stale).toEqual([
      expect.objectContaining({ certainty: 'possible', archivedAfter: ['2026-09-25-tune-export'], before: null }),
    ]);
  });

  it('готовый change без активности 5 дней — ждёт архивации; порядок пакета — по дате создания', () => {
    const report = buildDriftReport({
      sources: sources(modified('Выгрузка данных'), modified('Выгрузка данных')),
      git: true,
      now: '2026-09-29T12:00:00Z',
      changes: [...changes, { name: 'aaa', created: null, lastActivity: null, readyToArchive: true }],
      baselines: {},
      archived: [],
    });
    expect(report.changes['add-limits']?.forgottenDays).toBe(5);
    expect(report.changes['rework-export']?.forgottenDays).toBeNull();
    expect(report.changes['add-limits']?.overlaps[0]?.others).toEqual([
      { change: 'rework-export', operation: 'MODIFIED', path: 'openspec/changes/rework-export/specs/data-export/spec.md', line: 3 },
    ]);
    expect(report.archiveOrder).toEqual(['add-limits', 'aaa']);
  });
});

describe('забытые changes и порядок', () => {
  it('порог в три дня и незакоммиченные правки', () => {
    expect(forgottenDays(true, '2026-09-27T00:00:00Z', '2026-09-30T00:00:00Z')).toBe(3);
    expect(forgottenDays(true, '2026-09-28T00:00:00Z', '2026-09-30T00:00:00Z')).toBeNull();
    // Незакоммиченные правки — активность «сейчас».
    expect(forgottenDays(true, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z')).toBeNull();
    expect(forgottenDays(false, '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z')).toBeNull();
  });

  it('без даты создания — последними, по имени', () => {
    expect(
      archiveOrder([
        { name: 'c', created: null },
        { name: 'b', created: '2026-09-02' },
        { name: 'a', created: null },
        { name: 'd', created: '2026-09-01' },
      ]),
    ).toEqual(['d', 'b', 'a', 'c']);
  });
});
