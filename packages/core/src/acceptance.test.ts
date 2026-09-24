import { describe, expect, it } from 'vitest';
import { splitAcceptance } from './acceptance.js';

describe('критерий приёмки из формулировки пункта', () => {
  it('явный разделитель «; проверка —»', () => {
    const split = splitAcceptance(
      'Реализовать обёртку над CLI; проверка — тесты на ненулевой код проходят',
    );

    expect(split.work).toBe('Реализовать обёртку над CLI');
    expect(split.criterion).toBe('тесты на ненулевой код проходят');
  });

  it('неявная форма «… и проверить, что тест X проходит»', () => {
    const split = splitAcceptance('Добавить эндпоинт выгрузки и проверить, что тест X проходит');

    expect(split.work).toBe('Добавить эндпоинт выгрузки');
    expect(split.criterion).toBe('проверить, что тест X проходит');
  });

  it('форма «… и убедиться …»', () => {
    const split = splitAcceptance('Прогнать сценарий и убедиться, что файл открывается');

    expect(split.criterion).toBe('убедиться, что файл открывается');
  });

  it('английская форма «… and verify …»', () => {
    const split = splitAcceptance('Add export endpoint and verify the export test passes');

    expect(split.criterion).toContain('verify the export test passes');
  });

  it('пункт без способа проверки не имеет критерия', () => {
    const split = splitAcceptance('Панель проверок по выводу validate');

    expect(split.criterion).toBeNull();
    expect(split.work).toBe('Панель проверок по выводу validate');
  });

  it('слово «проверка» в названии работы не принимается за критерий', () => {
    // Здесь «проверок» — часть предмета работы, а не способ приёмки.
    expect(splitAcceptance('Панель проверок по выводу validate').criterion).toBeNull();
  });

  it('разбирает все пункты плана этого проекта', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const text = readFileSync(
      fileURLToPath(
        new URL('../../../openspec/changes/archive/2026-09-24-add-openspec-ide/tasks.md', import.meta.url),
      ),
      'utf8',
    );
    const items = text.split('\n').filter((line) => /^- \[[ xX]\] \d/.test(line));

    const withoutCriterion = items.filter(
      (line) => splitAcceptance(line.replace(/^- \[[ xX]\] [\d.]+ /, '')).criterion === null,
    );

    // Правило проекта: у каждой задачи есть критерий приёмки.
    expect(items.length).toBeGreaterThan(60);
    expect(withoutCriterion).toEqual([]);
  });
});
