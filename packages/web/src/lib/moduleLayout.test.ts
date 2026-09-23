import type { ModuleDef } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { layoutModules } from './moduleLayout.js';

function module(id: string, dependsOn: string[] = []): ModuleDef {
  return { id, title: id, kind: 'library', path: id, specs: id, group: null, dependsOn };
}

describe('layoutModules', () => {
  it('библиотеки внизу, потребители выше своих зависимостей', () => {
    const layout = layoutModules([module('billing', ['km/core', 'km/events']), module('reports', ['billing']), module('km/core'), module('km/events', ['km/core'])]);
    const y = Object.fromEntries(layout.nodes.map((node) => [node.id, node.y]));
    expect(y['reports']!).toBeLessThan(y['billing']!);
    expect(y['billing']!).toBeLessThan(y['km/events']!);
    expect(y['km/events']!).toBeLessThan(y['km/core']!);
    expect(layout.edges).toContainEqual({ from: 'reports', to: 'billing' });
  });

  it('цикл не зацикливает раскладку', () => {
    const layout = layoutModules([module('a', ['b']), module('b', ['a'])]);
    expect(layout.nodes).toHaveLength(2);
  });

  it('модули одного слоя не перекрываются', () => {
    const layout = layoutModules([module('a'), module('b'), module('c')]);
    const xs = layout.nodes.map((node) => node.x).sort((p, q) => p - q);
    expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(132);
    expect(layout.width).toBeGreaterThan(xs[2]! + 132);
  });
});
