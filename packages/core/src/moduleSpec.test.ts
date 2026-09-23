import { describe, expect, it } from 'vitest';
import { buildSections, checkModuleSpec, sectionLabel, splitSections } from './moduleSpec.js';

const req = (name: string, scenarios = 1) => ({ name, scenarios: Array.from({ length: scenarios }, () => ({})) });

describe('разделы спеки модуля', () => {
  it('раздел — часть имени до « / », вложенность — по нескольким разделителям', () => {
    expect(splitSections('Счета / Нумерация счетов')).toEqual({ sections: ['Счета'], short: 'Нумерация счетов' });
    expect(splitSections('Счета / НДС / Округление')).toEqual({ sections: ['Счета', 'НДС'], short: 'Округление' });
    expect(splitSections('Кэш ответов')).toEqual({ sections: [], short: 'Кэш ответов' });
  });

  it('косая черта без пробелов — не раздел', () => {
    expect(splitSections('Интеграция km/core').sections).toEqual([]);
    expect(splitSections('A/B-тест цен').sections).toEqual([]);
    expect(splitSections('Пустой / ').sections).toEqual([]);
  });

  it('разделы и требования в порядке файла, без разделителя — «Общее»', () => {
    const sections = buildSections([
      req('Счета / Выставление счёта', 2),
      req('Возвраты / Возврат оплаты'),
      req('Счета / Нумерация счетов'),
      req('Кэш ответов'),
      req('Счета / НДС / Округление'),
    ]);
    expect(sections.map((section) => [section.title, section.requirementCount, section.scenarioCount])).toEqual([
      ['Счета', 3, 4],
      ['Возвраты', 1, 1],
      ['Общее', 1, 1],
    ]);
    const bills = sections[0]!;
    expect(bills.requirements.map((item) => item.name)).toEqual(['Счета / Выставление счёта', 'Счета / Нумерация счетов']);
    expect(bills.children.map((child) => [child.title, child.path, child.requirements.length])).toEqual([
      ['НДС', ['Счета', 'НДС'], 1],
    ]);
    expect(sectionLabel('Счета / НДС / Округление')).toBe('Счета › НДС');
    expect(sectionLabel('Кэш')).toBe('Общее');
  });
});

describe('проверка формата спеки модуля', () => {
  it('заголовок ## после Requirements: строка и число потерянных требований', () => {
    const text = [
      '# billing', // 1
      '',
      '## Purpose',
      'Текст.',
      '## Requirements', // 5
      '### Requirement: Первое',
      '#### Scenario: A',
      '## Возвраты', // 8
      '### Requirement: Второе',
      '#### Scenario: B',
      '### Requirement: Третье',
      '#### Scenario: C',
    ].join('\n');
    const [warning, ...rest] = checkModuleSpec(text);
    expect(rest).toEqual([]);
    expect(warning).toMatchObject({ kind: 'heading-in-requirements', line: 8, lostRequirements: 2 });
    expect(warning?.message).toContain('«Возвраты / Имя требования»');
  });

  it('повтор имени требования без учёта регистра и пробелов', () => {
    const warnings = checkModuleSpec('## Requirements\n### Requirement: Кэш ответов\n### Requirement: кэш  ответов\n');
    expect(warnings).toEqual([expect.objectContaining({ kind: 'duplicate-requirement', line: 3 })]);
  });

  it('разделы, различающиеся регистром или пробелами', () => {
    const warnings = checkModuleSpec(
      '## Requirements\n### Requirement: Счета / А\n### Requirement: счета / Б\n### Requirement: Счета  НДС / В\n### Requirement: Счета НДС / Г\n',
    );
    expect(warnings.map((warning) => [warning.kind, warning.line])).toEqual([
      ['similar-sections', 2],
      ['similar-sections', 4],
    ]);
    expect(warnings[0]?.message).toContain('«Счета», «счета»');
  });

  it('корректная спека без предупреждений', () => {
    expect(checkModuleSpec('# x\n## Purpose\nP\n## Requirements\n### Requirement: Счета / А\n#### Scenario: s\n')).toEqual([]);
  });
});
