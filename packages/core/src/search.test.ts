import { describe, expect, it } from 'vitest';
import { SearchIndex } from './search.js';

const DELTA = `# Spec Delta: agent-bridge

## ADDED Requirements

### Requirement: Бюджеты запуска

Система ДОЛЖНА (SHALL) ограничивать запуск по времени.

#### Scenario: Превышен предел времени

- **WHEN** запуск идёт дольше предела
- **THEN** он завершается

#### Scenario: Пределы не заданы

- **WHEN** пределы не заданы
- **THEN** применяются значения по умолчанию
`;

function index(): SearchIndex {
  return new SearchIndex(
    {
      changes: ['add-openspec-ide', 'rework-agent-budgets'],
      capabilities: ['agent-bridge', 'identity/user-auth'],
      schemas: ['spec-driven', 'team-flow'],
    },
    [
      {
        owner: 'add-openspec-ide',
        file: 'openspec/changes/add-openspec-ide/specs/agent-bridge/spec.md',
        text: DELTA,
      },
    ],
  );
}

describe('поиск по рабочему пространству', () => {
  it('находит требование по фрагменту текста', () => {
    const hits = index().search('бюджеты');

    // Имя change записано латиницей, поэтому кириллический запрос попадает
    // только в требование.
    expect(hits).toHaveLength(1);
    const requirement = hits.find((hit) => hit.kind === 'requirement');
    expect(requirement?.title).toBe('Бюджеты запуска');
    expect(requirement?.owner).toBe('add-openspec-ide');
  });

  it('результат ведёт к файлу и строке', () => {
    const requirement = index()
      .search('бюджеты', ['requirement'])
      .at(0);

    expect(requirement?.file).toContain('specs/agent-bridge/spec.md');
    expect(DELTA.split('\n')[(requirement?.line ?? 1) - 1]).toContain('### Requirement:');
  });

  it('ищет без учёта регистра', () => {
    expect(index().search('ПРЕВЫШЕН').length).toBeGreaterThan(0);
  });

  it('фильтр по типу ограничивает выдачу', () => {
    const scenarios = index().search('предел', ['scenario']);

    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.every((hit) => hit.kind === 'scenario')).toBe(true);
  });

  it('пустой фильтр означает поиск по всем типам', () => {
    const all = index().search('agent');
    expect(new Set(all.map((hit) => hit.kind)).size).toBeGreaterThan(1);
  });

  it('находит change, capability и схему по имени', () => {
    const instance = index();
    expect(instance.search('rework', ['change'])).toHaveLength(1);
    expect(instance.search('user-auth', ['capability'])).toHaveLength(1);
    expect(instance.search('team-flow', ['schema'])).toHaveLength(1);
  });

  it('отсутствие совпадений даёт пустую выдачу', () => {
    expect(index().search('такого-точно-нет')).toHaveLength(0);
  });

  it('пустой запрос ничего не возвращает', () => {
    expect(index().search('   ')).toHaveLength(0);
  });

  it('вложенный путь capability ищется целиком и по сегменту', () => {
    const instance = index();
    expect(instance.search('identity/user-auth', ['capability'])).toHaveLength(1);
    expect(instance.search('identity', ['capability'])).toHaveLength(1);
  });
});
