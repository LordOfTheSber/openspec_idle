import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpecMarkdown } from './specMarkdown.js';

const DELTA = `# Spec Delta: agent-bridge

## Purpose

Подключает к IDE языковую модель через GigaCode CLI — единственный разрешённый
канал к LLM.

## ADDED Requirements

### Requirement: Запуск агента

Система ДОЛЖНА (SHALL) запускать CLI как отдельный процесс.

#### Scenario: Успешное завершение

- **WHEN** процесс завершается с нулевым кодом
- **THEN** запуск помечается успешным

#### Scenario: Завершение с ошибкой

- **WHEN** процесс завершается ненулевым кодом
- **THEN** запуск помечается неуспешным

## MODIFIED Requirements

### Requirement: Бюджеты запуска

Система ДОЛЖНА (SHALL) ограничивать запуск по времени.

#### Scenario: Превышен предел

- **WHEN** запуск идёт дольше предела
- **THEN** он завершается
`;

describe('разбор структуры спека', () => {
  it('извлекает заголовок и назначение capability', () => {
    const parsed = parseSpecMarkdown(DELTA);
    expect(parsed.title).toBe('Spec Delta: agent-bridge');
    expect(parsed.purpose).toContain('GigaCode CLI');
  });

  it('разбирает требования с их операциями дельты', () => {
    const parsed = parseSpecMarkdown(DELTA);
    expect(parsed.requirements).toHaveLength(2);
    expect(parsed.requirements[0]).toMatchObject({ name: 'Запуск агента', operation: 'ADDED' });
    expect(parsed.requirements[1]).toMatchObject({ name: 'Бюджеты запуска', operation: 'MODIFIED' });
  });

  it('сохраняет номера строк требований и сценариев', () => {
    const parsed = parseSpecMarkdown(DELTA);
    const lines = DELTA.split('\n');

    const requirement = parsed.requirements[0];
    expect(lines[(requirement?.line ?? 1) - 1]).toContain('### Requirement: Запуск агента');

    const scenario = requirement?.scenarios[0];
    expect(lines[(scenario?.line ?? 1) - 1]).toContain('#### Scenario: Успешное завершение');
  });

  it('собирает сценарии и их шаги', () => {
    const parsed = parseSpecMarkdown(DELTA);
    const first = parsed.requirements[0];
    expect(first?.scenarios.map((s) => s.name)).toEqual([
      'Успешное завершение',
      'Завершение с ошибкой',
    ]);
    expect(first?.scenarios[0]?.steps).toHaveLength(2);
    expect(first?.scenarios[0]?.steps[0]).toContain('**WHEN**');
  });

  it('сохраняет описание требования отдельно от сценариев', () => {
    const parsed = parseSpecMarkdown(DELTA);
    expect(parsed.requirements[0]?.description).toContain('отдельный процесс');
    expect(parsed.requirements[0]?.description).not.toContain('WHEN');
  });

  it('ловит сценарий, записанный тремя решётками', () => {
    const parsed = parseSpecMarkdown(
      '## ADDED Requirements\n\n### Requirement: X\n\nТекст.\n\n#### Scenario: Норма\n\n- **WHEN** а\n- **THEN** б\n\n### Scenario: Ошибка\n\n- **WHEN** в\n',
    );

    const problem = parsed.problems.find((p) => p.kind === 'scenario-wrong-level');
    expect(problem).toBeDefined();
    expect(problem?.line).toBe(12);
    expect(problem?.message).toContain('четырёх');
  });

  it('помечает требование без сценариев', () => {
    const parsed = parseSpecMarkdown(
      '## ADDED Requirements\n\n### Requirement: Пустое\n\nОписание без сценариев.\n',
    );

    const problem = parsed.problems.find((p) => p.kind === 'requirement-without-scenario');
    expect(problem).toBeDefined();
    expect(problem?.message).toContain('Пустое');
  });

  it('помечает сценарий вне требования', () => {
    const parsed = parseSpecMarkdown('# Spec\n\n#### Scenario: Ничей\n\n- **WHEN** а\n');
    expect(parsed.problems.some((p) => p.kind === 'scenario-outside-requirement')).toBe(true);
  });

  it('в основном спеке операция дельты отсутствует', () => {
    const parsed = parseSpecMarkdown(
      '# data-export\n\n## Purpose\n\nВыгрузка.\n\n## Requirements\n\n### Requirement: Выгрузка\n\nТекст.\n\n#### Scenario: Успех\n\n- **WHEN** а\n- **THEN** б\n',
    );
    expect(parsed.requirements[0]?.operation).toBeNull();
  });

  it('разбирает настоящую дельту этого проекта без структурных нарушений', () => {
    const path = fileURLToPath(
      new URL(
        '../../../openspec/changes/archive/2026-09-24-add-openspec-ide/specs/sdd-conformance/spec.md',
        import.meta.url,
      ),
    );
    const parsed = parseSpecMarkdown(readFileSync(path, 'utf8'));

    expect(parsed.problems).toHaveLength(0);
    expect(parsed.requirements).toHaveLength(4);
    expect(parsed.requirements.every((r) => r.operation === 'ADDED')).toBe(true);
    expect(parsed.requirements.every((r) => r.scenarios.length > 0)).toBe(true);
  });

  it('пустой документ не роняет разбор', () => {
    const parsed = parseSpecMarkdown('');
    expect(parsed.requirements).toHaveLength(0);
    expect(parsed.problems).toHaveLength(0);
  });
});
