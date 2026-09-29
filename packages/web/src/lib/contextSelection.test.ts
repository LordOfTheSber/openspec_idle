import { buildContextMap, contextBundle, type ModuleSource } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { bundleKeys, parseNodeKey, selectionOf, togglePicked } from './contextSelection.js';

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

describe('выбор набора контекста', () => {
  it('щелчок добавляет узел в конец набора, повторный — убирает', () => {
    const once = togglePicked([], 'module:m1');
    const twice = togglePicked(once, 'domain:a');
    expect(twice).toEqual(['module:m1', 'domain:a']);
    expect(togglePicked(twice, 'module:m1')).toEqual(['domain:a']);
  });

  it('ключи раскладываются по видам; путь ADR с двоеточием не ломает разбор', () => {
    expect(parseNodeKey('adr:openspec/context/adr/a:b.md')).toEqual({ kind: 'adr', id: 'openspec/context/adr/a:b.md' });
    expect(parseNodeKey('other:x')).toBeNull();
    expect(parseNodeKey('module:')).toBeNull();
    expect(selectionOf(['domain:b', 'module:m2', 'adr:x.md', 'module:m1', 'junk'])).toEqual({
      modules: ['m2', 'm1'],
      domains: ['b'],
      adrs: ['x.md'],
    });
  });

  it('в набор попадают выбранные узлы и узлы, добавленные по связям', () => {
    const map = buildContextMap({
      general: [],
      domains: ['a', 'b', 'c'],
      adrs: [],
      modules: [module('m1', { domains: ['a'], depends_on: ['m2'] }), module('m2', { domains: ['b'] })],
    });
    const keys = bundleKeys(contextBundle(map, selectionOf(['module:m1', 'domain:c'])));
    expect([...keys].sort()).toEqual(['domain:a', 'domain:b', 'domain:c', 'module:m1', 'module:m2']);
  });
});
