import type { ContextBundle, ContextSelection } from '@openspec-ide/core';
import { type ContextNodeKind, nodeKey } from './contextLayout.js';

/** Узел, выбранный в набор контекста, по ключу `вид:идентификатор`. */
export interface PickedNode {
  readonly kind: ContextNodeKind;
  readonly id: string;
}

const KINDS: readonly ContextNodeKind[] = ['module', 'domain', 'adr'];

/** Разбирает ключ узла; чужой ключ — `null`. */
export function parseNodeKey(key: string): PickedNode | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const kind = key.slice(0, separator) as ContextNodeKind;
  const id = key.slice(separator + 1);
  return KINDS.includes(kind) && id !== '' ? { kind, id } : null;
}

/** Добавляет узел в набор или убирает его оттуда; порядок выбора сохраняется. */
export function togglePicked(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
}

/** Выбор для сборки набора по ключам узлов в порядке выбора. */
export function selectionOf(keys: readonly string[]): ContextSelection {
  const modules: string[] = [];
  const domains: string[] = [];
  const adrs: string[] = [];
  for (const key of keys) {
    const node = parseNodeKey(key);
    if (node === null) continue;
    (node.kind === 'module' ? modules : node.kind === 'domain' ? domains : adrs).push(node.id);
  }
  return { modules, domains, adrs };
}

/** Ключи всех узлов, попавших в набор: выбранных и добавленных по связям. */
export function bundleKeys(bundle: ContextBundle): Set<string> {
  return new Set([
    ...bundle.modules.map((id) => nodeKey('module', id)),
    ...bundle.domains.map((id) => nodeKey('domain', id)),
    ...bundle.adrs.map((path) => nodeKey('adr', path)),
  ]);
}
