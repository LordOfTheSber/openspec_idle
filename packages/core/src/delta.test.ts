import { describe, expect, it } from 'vitest';
import { buildDeltaView, compareRequirement, sameHeader } from './delta.js';

const FULL_DELTA = `# Spec Delta: data-export

## Purpose

Позволяет забрать данные в переносимом формате.

## ADDED Requirements

### Requirement: Выбор формата

Система ДОЛЖНА (SHALL) давать выбрать формат выгрузки.

#### Scenario: Формат JSON

- **WHEN** пользователь выбирает JSON
- **THEN** отдаётся файл JSON

## MODIFIED Requirements

### Requirement: Выгрузка данных

Система ДОЛЖНА (SHALL) выгружать данные в форматах CSV и JSON.

#### Scenario: Успешная выгрузка

- **WHEN** пользователь запрашивает выгрузку
- **THEN** отдаётся файл со всеми его данными

## REMOVED Requirements

### Requirement: Устаревшая выгрузка
**Reason**: Заменена новой выгрузкой
**Migration**: Используйте /api/v2/export

## RENAMED Requirements

### Requirement: Новое имя
FROM: \`### Requirement: Старое имя\`
TO: \`### Requirement: Новое имя\`
`;

const MAIN_SPEC = `# data-export

## Purpose

Позволяет забрать данные.

## Requirements

### Requirement: Выгрузка данных

Система ДОЛЖНА (SHALL) выгружать данные в формате CSV.

#### Scenario: Успешная выгрузка

- **WHEN** пользователь запрашивает выгрузку
- **THEN** отдаётся файл CSV

#### Scenario: Пустой набор данных

- **WHEN** данных нет
- **THEN** отдаётся пустой файл
`;

describe('группировка дельты по операциям', () => {
  it('разносит требования по всем четырём операциям', () => {
    const view = buildDeltaView('data-export', FULL_DELTA);

    expect(view.groups.map((group) => group.operation)).toEqual([
      'ADDED',
      'MODIFIED',
      'REMOVED',
      'RENAMED',
    ]);
    expect(view.requirementCount).toBe(4);
  });

  it('считает сценарии в каждой группе', () => {
    const view = buildDeltaView('data-export', FULL_DELTA);
    const byOperation = new Map(view.groups.map((group) => [group.operation, group]));

    expect(byOperation.get('ADDED')?.scenarioCount).toBe(1);
    expect(byOperation.get('MODIFIED')?.scenarioCount).toBe(1);
    expect(byOperation.get('REMOVED')?.scenarioCount).toBe(0);
  });

  it('извлекает назначение capability', () => {
    expect(buildDeltaView('data-export', FULL_DELTA).purpose).toContain('переносимом формате');
  });

  it('удалённое требование несёт причину и указание по миграции', () => {
    const view = buildDeltaView('data-export', FULL_DELTA);
    const removed = view.groups.find((group) => group.operation === 'REMOVED')?.requirements[0];

    expect(removed?.reason).toBe('Заменена новой выгрузкой');
    expect(removed?.migration).toBe('Используйте /api/v2/export');
    expect(removed?.missingFields).toEqual([]);
  });

  it('переименованное требование несёт прежнее и новое имя', () => {
    const view = buildDeltaView('data-export', FULL_DELTA);
    const renamed = view.groups.find((group) => group.operation === 'RENAMED')?.requirements[0];

    expect(renamed?.renamedFrom).toBe('Старое имя');
    expect(renamed?.renamedTo).toBe('Новое имя');
    expect(renamed?.missingFields).toEqual([]);
  });

  it('удалённое требование без причины помечается неполным', () => {
    const view = buildDeltaView(
      'x',
      '## REMOVED Requirements\n\n### Requirement: Без причины\n**Migration**: Используйте новое\n',
    );
    const removed = view.groups[0]?.requirements[0];

    expect(removed?.missingFields).toEqual(['Reason']);
  });

  it('удалённое требование без миграции помечается неполным', () => {
    const view = buildDeltaView(
      'x',
      '## REMOVED Requirements\n\n### Requirement: Без миграции\n**Reason**: Не нужно\n',
    );

    expect(view.groups[0]?.requirements[0]?.missingFields).toEqual(['Migration']);
  });

  it('переименование без одного из имён помечается неполным', () => {
    const view = buildDeltaView(
      'x',
      '## RENAMED Requirements\n\n### Requirement: Новое\nTO: `### Requirement: Новое`\n',
    );

    expect(view.groups[0]?.requirements[0]?.missingFields).toEqual(['FROM']);
  });

  it('удалённому и переименованному требованию сценарии не нужны', () => {
    const view = buildDeltaView('data-export', FULL_DELTA);
    const removed = view.groups.find((group) => group.operation === 'REMOVED')?.requirements[0];

    expect(removed?.scenarios).toHaveLength(0);
    expect(removed?.missingFields).toEqual([]);
  });

  it('дельта без требований даёт пустой набор групп', () => {
    expect(buildDeltaView('x', '# Spec Delta\n').groups).toHaveLength(0);
  });
});

describe('сравнение требования с основным спеком', () => {
  it('показывает добавленные и удалённые сценарии', () => {
    const view = buildDeltaView('data-export', FULL_DELTA);
    const modified = view.groups.find((group) => group.operation === 'MODIFIED')?.requirements[0];
    expect(modified).toBeDefined();
    if (modified === undefined) return;

    const comparison = compareRequirement(modified, MAIN_SPEC);

    expect(comparison.missingInMainSpec).toBe(false);
    expect(comparison.keptScenarios).toEqual(['Успешная выгрузка']);
    expect(comparison.removedScenarios).toEqual(['Пустой набор данных']);
    expect(comparison.addedScenarios).toEqual([]);
  });

  it('показывает изменение текста требования', () => {
    const view = buildDeltaView('data-export', FULL_DELTA);
    const modified = view.groups.find((group) => group.operation === 'MODIFIED')?.requirements[0];
    if (modified === undefined) return;

    const comparison = compareRequirement(modified, MAIN_SPEC);
    const removed = comparison.description.filter((line) => line.kind === 'removed');
    const added = comparison.description.filter((line) => line.kind === 'added');

    expect(removed[0]?.text).toContain('формате CSV');
    expect(added[0]?.text).toContain('CSV и JSON');
  });

  it('требование, отсутствующее в основном спеке, помечается и предлагает похожие', () => {
    const view = buildDeltaView(
      'data-export',
      '## MODIFIED Requirements\n\n### Requirement: Выгрузка данных пользователя\n\nТекст.\n\n#### Scenario: С\n\n- **WHEN** а\n- **THEN** б\n',
    );
    const modified = view.groups[0]?.requirements[0];
    if (modified === undefined) return;

    const comparison = compareRequirement(modified, MAIN_SPEC);

    expect(comparison.missingInMainSpec).toBe(true);
    expect(comparison.similarNames).toContain('Выгрузка данных');
  });

  it('заголовки сравниваются без учёта регистра и лишних пробелов', () => {
    expect(sameHeader('Выгрузка  данных', 'выгрузка данных')).toBe(true);
    expect(sameHeader('Выгрузка данных', 'Выгрузка')).toBe(false);
  });

  it('когда похожих заголовков нет, подсказка пустая', () => {
    const view = buildDeltaView(
      'x',
      '## MODIFIED Requirements\n\n### Requirement: Совсем другое\n\nТекст.\n\n#### Scenario: С\n\n- **WHEN** а\n- **THEN** б\n',
    );
    const modified = view.groups[0]?.requirements[0];
    if (modified === undefined) return;

    expect(compareRequirement(modified, MAIN_SPEC).similarNames).toEqual([]);
  });
});
