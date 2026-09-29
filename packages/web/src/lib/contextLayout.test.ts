import { buildContextMap, type ModuleSource } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { layoutContextMap, neighbourhood, nodeKey } from './contextLayout.js';

function module(folder: string, frontmatter: Record<string, unknown>): ModuleSource {
  return {
    folder,
    hasIndex: true,
    hasContext: true,
    frontmatter,
    frontmatterError: null,
    lineOf: () => null,
    existingCodePaths: new Set(),
  };
}

const map = buildContextMap({
  general: [],
  domains: ['a', 'b', 'c', 'd'],
  adrs: [],
  modules: [
    module('m1', { domains: ['d'], depends_on: ['m2', 'router'] }),
    module('m2', { domains: ['a', 'b'] }),
    module('m3', { domains: ['b', 'c', 'ghost'] }),
  ],
});

describe('раскладка карты контекста', () => {
  const layout = layoutContextMap(map);
  const y = (kind: 'module' | 'domain', id: string): number =>
    layout.nodes.find((node) => node.key === nodeKey(kind, id))?.y ?? -1;

  it('модули и домены — в своих колонках, без ADR колонки ADR нет', () => {
    expect(layout.columns.map((column) => column.kind)).toEqual(['module', 'domain']);
    const moduleX = new Set(layout.nodes.filter((node) => node.kind === 'module').map((node) => node.x));
    const domainX = new Set(layout.nodes.filter((node) => node.kind === 'domain').map((node) => node.x));
    expect(moduleX.size).toBe(1);
    expect(domainX.size).toBe(1);
    expect([...domainX][0]).toBeGreaterThan([...moduleX][0] ?? 0);
  });

  it('домены стоят рядом со своими модулями', () => {
    // Домен d — только у m1, a — только у m2: они не должны меняться местами.
    expect(Math.sign(y('domain', 'd') - y('domain', 'a'))).toBe(Math.sign(y('module', 'm1') - y('module', 'm2')));
  });

  it('неописанные модуль и домен — узлы с отметкой', () => {
    expect(layout.nodes.find((node) => node.key === nodeKey('module', 'router'))?.resolved).toBe(false);
    expect(layout.nodes.find((node) => node.key === nodeKey('domain', 'ghost'))?.resolved).toBe(false);
  });

  it('рёбра: связи с доменами и зависимости модулей', () => {
    expect(layout.edges.filter((edge) => edge.kind === 'domain')).toHaveLength(6);
    expect(layout.edges.filter((edge) => edge.kind === 'depends').map((edge) => edge.to)).toEqual([
      nodeKey('module', 'm2'),
      nodeKey('module', 'router'),
    ]);
    expect(layout.edges.every((edge) => edge.path.startsWith('M'))).toBe(true);
  });

  it('окрестность узла — он сам и соседи', () => {
    expect([...neighbourhood(layout, nodeKey('domain', 'b'))].sort()).toEqual([
      nodeKey('domain', 'b'),
      nodeKey('module', 'm2'),
      nodeKey('module', 'm3'),
    ]);
  });
});
