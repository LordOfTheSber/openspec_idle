import { describe, expect, it } from 'vitest';
import {
  affectedConsumers,
  capabilityModule,
  changeModules,
  groupModules,
  matchesModuleFilter,
  moduleNeighbours,
  parseModuleMap,
  type ModuleDef,
} from './modules.js';

function module(id: string, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { id, title: id.toUpperCase(), kind: 'library', path: id, specs: id, ...extra };
}

/** Монорепо команды: пять сервисов, UI и КМ из четырёх библиотек. */
const PLATFORM = parseModuleMap({
  version: 1,
  modules: [
    module('auth', { kind: 'service', path: 'services/auth', group: 'Сервисы', dependsOn: ['km/auth-client', 'km/core'] }),
    module('billing', { kind: 'service', path: 'services/billing', group: 'Сервисы', dependsOn: ['km/core', 'km/events'] }),
    module('orders', { kind: 'service', path: 'services/orders', group: 'Сервисы', dependsOn: ['km/core', 'billing'] }),
    module('notifications', { kind: 'service', path: 'services/notifications', group: 'Сервисы', dependsOn: ['km/events'] }),
    module('reports', { kind: 'service', path: 'services/reports', group: 'Сервисы', dependsOn: ['billing'] }),
    module('web-ui', { kind: 'ui', path: 'ui', group: 'UI', dependsOn: ['km/core', 'km/ui-kit'] }),
    module('km/core', { group: 'КМ' }),
    module('km/auth-client', { group: 'КМ', dependsOn: ['km/core'] }),
    module('km/events', { group: 'КМ', dependsOn: ['km/core'] }),
    module('km/ui-kit', { group: 'КМ' }),
  ],
});

describe('parseModuleMap', () => {
  it('разбирает корректную карту без ошибок', () => {
    expect(PLATFORM.problems).toEqual([]);
    expect(PLATFORM.modules).toHaveLength(10);
    expect(PLATFORM.modules[1]).toEqual({
      id: 'billing',
      title: 'BILLING',
      kind: 'service',
      path: 'services/billing',
      specs: 'billing',
      group: 'Сервисы',
      dependsOn: ['km/core', 'km/events'],
    });
  });

  it('неизвестная зависимость: ошибка с модулем и полем, модуль остаётся без неё', () => {
    const map = parseModuleMap({ modules: [module('billing', { dependsOn: ['km/core', 'km/nope'] }), module('km/core')] });
    expect(map.problems).toEqual([{ module: 'billing', field: 'dependsOn', message: 'Неизвестный модуль km/nope' }]);
    expect(map.modules.find((entry) => entry.id === 'billing')?.dependsOn).toEqual(['km/core']);
  });

  it('совпадающие префиксы: спеки достаются первому, второй помечен', () => {
    const map = parseModuleMap({ modules: [module('a', { specs: 'shared' }), module('b', { specs: 'shared/' })] });
    expect(map.problems).toEqual([
      { module: 'b', field: 'specs', message: 'Префикс спеков «shared» уже занят модулем a; спеки достаются a' },
    ]);
    expect(capabilityModule('shared/x', map.modules)).toBe('a');
  });

  it('пустые поля сообщаются по каждому полю, модуль работает', () => {
    const map = parseModuleMap({ modules: [{ id: 'billing', title: ' ', kind: '', path: '' }] });
    expect(map.problems.map((problem) => [problem.module, problem.field])).toEqual([
      ['billing', 'title'],
      ['billing', 'kind'],
      ['billing', 'path'],
    ]);
    // Префикс по умолчанию — id.
    expect(map.modules[0]).toMatchObject({ id: 'billing', title: 'billing', path: null, specs: 'billing' });
  });

  it('модуль без id или с повтором пропускается, остальные работают', () => {
    const map = parseModuleMap({ modules: [{ title: 'Без id' }, module('a'), module('a', { title: 'Второй' }), 'строка', module('b')] });
    expect(map.modules.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(map.problems.map((problem) => [problem.module, problem.field])).toEqual([
      [null, 'modules[0].id'],
      ['a', 'id'],
      [null, 'modules[3]'],
    ]);
  });

  it('неизвестный вид и самозависимость', () => {
    const map = parseModuleMap({ modules: [module('a', { kind: 'lib', dependsOn: ['a'] })] });
    expect(map.problems.map((problem) => problem.field)).toEqual(['kind', 'dependsOn']);
    expect(map.modules[0]?.kind).toBe('service');
  });

  it('цикл зависимостей: ошибка с перечнем модулей, граф строится', () => {
    const map = parseModuleMap({
      modules: [module('a', { dependsOn: ['b'] }), module('b', { dependsOn: ['c'] }), module('c', { dependsOn: ['a'] }), module('d', { dependsOn: ['a'] })],
    });
    expect(map.cycles).toEqual([['a', 'b', 'c']]);
    expect(map.problems).toEqual([{ module: 'a', field: 'dependsOn', message: 'Цикл зависимостей: a → b → c → a' }]);
    expect(affectedConsumers(['a'], map.modules).map((consumer) => consumer.id).sort()).toEqual(['b', 'c', 'd']);
  });

  it('карта не объектом и шаблоны тестов', () => {
    expect(parseModuleMap(['x']).problems[0]?.field).toBe('modules');
    expect(parseModuleMap(null).modules).toEqual([]);
    expect(parseModuleMap({ tests: ['**/it/**'], modules: [] }).testPatterns).toEqual(['**/it/**']);
  });
});

describe('принадлежность модулям', () => {
  const nested = parseModuleMap({ modules: [module('km', { specs: 'km' }), module('km/core'), module('km/core-legacy')] }).modules;

  it('вложенный префикс: побеждает самый длинный', () => {
    expect(capabilityModule('km/core/cache', nested)).toBe('km/core');
    expect(capabilityModule('km/core', nested)).toBe('km/core');
    expect(capabilityModule('km/other', nested)).toBe('km');
  });

  it('сравнение по целым сегментам: km/core не захватывает km/core-legacy', () => {
    expect(capabilityModule('km/core-legacy/x', nested)).toBe('km/core-legacy');
    const onlyCore = nested.filter((entry) => entry.id === 'km/core');
    expect(capabilityModule('km/core-legacy/x', onlyCore)).toBeNull();
  });

  it('capability вне модулей', () => {
    expect(capabilityModule('ops/runbooks', PLATFORM.modules)).toBeNull();
  });

  it('change по дельтам в двух модулях и по явному списку', () => {
    expect(changeModules(['billing/invoices', 'km/core/cache'], [], PLATFORM.modules)).toEqual(['billing', 'km/core']);
    // Без дельт — только перечисленные в .openspec.yaml; неизвестные отбрасываются.
    expect(changeModules([], ['km/core', 'billing', 'nope'], PLATFORM.modules)).toEqual(['billing', 'km/core']);
    expect(changeModules(['ops/x'], [], PLATFORM.modules)).toEqual([]);
  });

  it('фильтр: пустой пропускает всё, иначе — пересечение', () => {
    expect(matchesModuleFilter([], [])).toBe(true);
    expect(matchesModuleFilter(['billing', 'km/core'], ['billing'])).toBe(true);
    expect(matchesModuleFilter(['orders'], ['billing'])).toBe(false);
  });
});

describe('граф модулей', () => {
  it('прямые и транзитивные потребители библиотеки КМ', () => {
    const consumers = affectedConsumers(['km/events'], PLATFORM.modules);
    expect(consumers).toEqual([
      { id: 'billing', depth: 1, via: 'km/events' },
      { id: 'notifications', depth: 1, via: 'km/events' },
      { id: 'orders', depth: 2, via: 'billing' },
      { id: 'reports', depth: 2, via: 'billing' },
    ]);
  });

  it('глубина — кратчайшая цепочка, исходные модули не входят', () => {
    const consumers = affectedConsumers(['km/core', 'billing'], PLATFORM.modules);
    expect(consumers.find((consumer) => consumer.id === 'orders')?.depth).toBe(1);
    expect(consumers.some((consumer) => consumer.id === 'billing')).toBe(false);
    expect(consumers.find((consumer) => consumer.id === 'reports')).toEqual({ id: 'reports', depth: 1, via: 'billing' });
  });

  it('соседи модуля и группы', () => {
    expect(moduleNeighbours('billing', PLATFORM.modules)).toEqual({
      dependsOn: ['km/core', 'km/events'],
      consumers: ['orders', 'reports'],
    });
    expect(groupModules(PLATFORM.modules).map((group) => [group.title, group.modules.length])).toEqual([
      ['Сервисы', 5],
      ['UI', 1],
      ['КМ', 4],
    ]);
    const ungrouped: ModuleDef[] = [{ id: 'x', title: 'x', kind: 'library', path: null, specs: 'x', group: null, dependsOn: [] }];
    expect(groupModules(ungrouped)[0]?.title).toBe('Библиотеки');
  });
});
