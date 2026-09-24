import { describe, expect, it } from 'vitest';
import { describeSpecChange, renamePairs, requirementBlocks } from './specChange.js';

const MAIN = `# data-export

## Purpose

Выгрузка данных.

## Requirements

### Requirement: Выгрузка данных

Система ДОЛЖНА выгружать CSV.

#### Scenario: Успешная выгрузка

- **WHEN** запрос
- **THEN** файл

#### Scenario: Пустой набор данных

- **WHEN** данных нет
- **THEN** пустой файл

### Requirement: Кодировка файла

Система ДОЛЖНА отдавать UTF-8.

#### Scenario: Кодировка

- **WHEN** файл отдан
- **THEN** UTF-8

### Requirement: Устаревшая выгрузка

Старый формат.

#### Scenario: Старый

- **WHEN** запрос
- **THEN** старый файл
`;

describe('блоки требований', () => {
  it('делит спек на требования и сценарии', () => {
    const blocks = requirementBlocks(MAIN);

    expect(blocks.map((block) => block.name)).toEqual([
      'Выгрузка данных',
      'Кодировка файла',
      'Устаревшая выгрузка',
    ]);
    expect(blocks[0]?.scenarios.map((scenario) => scenario.name)).toEqual([
      'Успешная выгрузка',
      'Пустой набор данных',
    ]);
    expect(blocks[0]?.line).toBe(9);
  });

  it('не принимает заголовок внутри блока кода за требование', () => {
    const text = '## Requirements\n\n### Requirement: A\n\n```md\n### Requirement: B\n```\n\n#### Scenario: S\n';

    const blocks = requirementBlocks(text);

    expect(blocks.map((block) => block.name)).toEqual(['A']);
    expect(blocks[0]?.scenarios.map((scenario) => scenario.name)).toEqual(['S']);
  });
});

describe('пары переименований', () => {
  it('понимает записи с маркером списка и без него', () => {
    const delta = [
      '## RENAMED Requirements',
      '',
      '- FROM: `### Requirement: Старое`',
      '- TO: `### Requirement: Новое`',
      'FROM: `### Requirement: Ещё одно`',
      'TO: `### Requirement: Другое`',
      '',
      '## ADDED Requirements',
      'FROM: `### Requirement: Не в той секции`',
      'TO: `### Requirement: Не считается`',
    ].join('\n');

    expect(renamePairs(delta)).toEqual([
      { from: 'Старое', to: 'Новое' },
      { from: 'Ещё одно', to: 'Другое' },
    ]);
  });
});

describe('изменения спека', () => {
  it('новая capability — все требования добавлены', () => {
    const change = describeSpecChange(null, MAIN);

    expect(change.status).toBe('created');
    expect(change.counts).toEqual({ added: 3, modified: 0, renamed: 0, removed: 0 });
    expect(change.requirements.every((requirement) => requirement.kind === 'added')).toBe(true);
    expect(change.diff.removed).toBe(0);
  });

  it('переименование с правкой текста, удаление и новый сценарий', () => {
    const after = MAIN.replace('### Requirement: Кодировка файла', '### Requirement: Кодировка выгрузки')
      .replace('Система ДОЛЖНА отдавать UTF-8.', 'Система ДОЛЖНА отдавать UTF-8 без BOM.')
      .replace(/### Requirement: Устаревшая выгрузка[\s\S]*$/, '')
      .replace(
        '#### Scenario: Пустой набор данных',
        '#### Scenario: Большой объём\n\n- **WHEN** много\n- **THEN** части\n\n#### Scenario: Пустой набор данных',
      );

    const change = describeSpecChange(MAIN, after, [{ from: 'Кодировка файла', to: 'Кодировка выгрузки' }]);

    expect(change.status).toBe('updated');
    expect(change.counts).toEqual({ added: 0, modified: 1, renamed: 1, removed: 1 });

    const modified = change.requirements.find((requirement) => requirement.name === 'Выгрузка данных');
    expect(modified?.kind).toBe('modified');
    expect(modified?.addedScenarios).toEqual(['Большой объём']);
    expect(modified?.removedScenarios).toEqual([]);

    const renamed = change.requirements.find((requirement) => requirement.name === 'Кодировка выгрузки');
    expect(renamed).toMatchObject({ kind: 'renamed', renamedFrom: 'Кодировка файла', textChanged: true });

    expect(change.removed.map((requirement) => requirement.name)).toEqual(['Устаревшая выгрузка']);
  });

  it('без пары RENAMED новое имя — это удаление и добавление', () => {
    const after = MAIN.replace('### Requirement: Кодировка файла', '### Requirement: Кодировка выгрузки');

    const change = describeSpecChange(MAIN, after);

    expect(change.counts.added).toBe(1);
    expect(change.counts.removed).toBe(1);
    expect(change.counts.renamed).toBe(0);
  });

  it('пропавший и изменённый сценарии видны у изменённого требования', () => {
    const after = MAIN.replace(
      /#### Scenario: Пустой набор данных\n\n- \*\*WHEN\*\* данных нет\n- \*\*THEN\*\* пустой файл\n\n/,
      '',
    ).replace('- **THEN** UTF-8', '- **THEN** UTF-8 и заголовок');

    const change = describeSpecChange(MAIN, after);

    expect(change.requirements.find((item) => item.name === 'Выгрузка данных')?.removedScenarios).toEqual([
      'Пустой набор данных',
    ]);
    expect(change.requirements.find((item) => item.name === 'Кодировка файла')?.changedScenarios).toEqual([
      'Кодировка',
    ]);
  });

  it('неизменный спек', () => {
    const change = describeSpecChange(MAIN, MAIN);

    expect(change.status).toBe('unchanged');
    expect(change.requirements.every((requirement) => requirement.kind === 'unchanged')).toBe(true);
  });
});
