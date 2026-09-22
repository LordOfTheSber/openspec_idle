import { describe, expect, it } from 'vitest';
import { buildCapabilityMap, capabilitiesFor, changesFor } from './capabilityMap.js';

describe('карта связей capability и changes', () => {
  it('показывает все changes, затрагивающие capability', () => {
    const map = buildCapabilityMap({
      existingCapabilities: ['data-export'],
      deltas: [
        { change: 'add-json', capability: 'data-export', requirements: ['Выгрузка данных'] },
        { change: 'add-limits', capability: 'data-export', requirements: ['Ограничение объёма'] },
      ],
    });

    expect(changesFor(map, 'data-export')).toEqual(['add-json', 'add-limits']);
  });

  it('показывает все capability, затрагиваемые change', () => {
    const map = buildCapabilityMap({
      existingCapabilities: ['data-export', 'user-auth'],
      deltas: [
        { change: 'big-change', capability: 'data-export', requirements: ['А'] },
        { change: 'big-change', capability: 'user-auth', requirements: ['Б'] },
      ],
    });

    expect(capabilitiesFor(map, 'big-change')).toEqual(['data-export', 'user-auth']);
  });

  it('требование, меняемое двумя changes, помечается конфликтом', () => {
    const map = buildCapabilityMap({
      existingCapabilities: ['data-export'],
      deltas: [
        {
          change: 'add-json',
          capability: 'data-export',
          requirements: ['Выгрузка данных', 'Только здесь'],
        },
        {
          change: 'add-limits',
          capability: 'data-export',
          requirements: ['Выгрузка данных'],
        },
      ],
    });

    const node = map.nodes[0];
    expect(node?.links).toHaveLength(2);
    expect(node?.links[0]?.conflictingRequirements).toEqual(['Выгрузка данных']);
    expect(node?.links[1]?.conflictingRequirements).toEqual(['Выгрузка данных']);
  });

  it('требование, которое меняет только один change, конфликтом не считается', () => {
    const map = buildCapabilityMap({
      existingCapabilities: ['data-export'],
      deltas: [
        { change: 'add-json', capability: 'data-export', requirements: ['Только здесь'] },
        { change: 'add-limits', capability: 'data-export', requirements: ['И только тут'] },
      ],
    });

    expect(map.nodes[0]?.links.every((link) => link.conflictingRequirements.length === 0)).toBe(
      true,
    );
  });

  it('конфликт определяется без учёта регистра и лишних пробелов', () => {
    const map = buildCapabilityMap({
      existingCapabilities: ['data-export'],
      deltas: [
        { change: 'a', capability: 'data-export', requirements: ['Выгрузка  данных'] },
        { change: 'b', capability: 'data-export', requirements: ['выгрузка данных'] },
      ],
    });

    expect(map.nodes[0]?.links[0]?.conflictingRequirements).toHaveLength(1);
  });

  it('capability без активных changes показана без связей', () => {
    const map = buildCapabilityMap({
      existingCapabilities: ['data-export'],
      deltas: [],
    });

    expect(map.nodes[0]?.links).toEqual([]);
    expect(map.nodes[0]?.exists).toBe(true);
    expect(map.nodes[0]?.dangling).toBe(false);
  });

  it('новая capability из дельты показана как ещё не существующая', () => {
    const map = buildCapabilityMap({
      existingCapabilities: [],
      deltas: [{ change: 'new-thing', capability: 'brand-new', requirements: ['Требование'] }],
    });

    expect(map.nodes[0]?.exists).toBe(false);
    expect(map.nodes[0]?.dangling).toBe(false);
    expect(map.nodes[0]?.links).toHaveLength(1);
  });

  it('узлы упорядочены по имени capability', () => {
    const map = buildCapabilityMap({
      existingCapabilities: ['zeta', 'alpha'],
      deltas: [],
    });

    expect(map.nodes.map((node) => node.capability)).toEqual(['alpha', 'zeta']);
  });
});
