import { sameHeader } from './delta.js';

/** Дельта одного change по одной capability. */
export interface CapabilityDelta {
  readonly change: string;
  readonly capability: string;
  /** Имена требований, затрагиваемых этой дельтой. */
  readonly requirements: readonly string[];
}

/** Связь change с capability. */
export interface CapabilityLink {
  readonly change: string;
  /** Требования, которые этот change меняет одновременно с другим change. */
  readonly conflictingRequirements: readonly string[];
}

/** Узел карты связей. */
export interface CapabilityNode {
  readonly capability: string;
  /** Capability существует в основных спеках. */
  readonly exists: boolean;
  readonly links: readonly CapabilityLink[];
  /** Дельта указывает на capability, которой нет ни в спеках, ни среди новых. */
  readonly dangling: boolean;
}

/** Карта связей capability и активных changes. */
export interface CapabilityMap {
  readonly nodes: readonly CapabilityNode[];
}

/** Что нужно для построения карты. */
export interface CapabilityMapInput {
  /** Пути capability, существующие в `openspec/specs/`. */
  readonly existingCapabilities: readonly string[];
  readonly deltas: readonly CapabilityDelta[];
}

/**
 * Строит карту связей capability и changes.
 *
 * Конфликтом считается требование, которое одновременно меняют два и более
 * активных change: такое расхождение всплывает при архивации, и увидеть его
 * лучше заранее.
 */
export function buildCapabilityMap(input: CapabilityMapInput): CapabilityMap {
  const byCapability = new Map<string, CapabilityDelta[]>();
  for (const delta of input.deltas) {
    const list = byCapability.get(delta.capability) ?? [];
    list.push(delta);
    byCapability.set(delta.capability, list);
  }

  const existing = new Set(input.existingCapabilities);
  const capabilities = new Set([...existing, ...byCapability.keys()]);

  const nodes: CapabilityNode[] = [];
  for (const capability of [...capabilities].sort()) {
    const deltas = byCapability.get(capability) ?? [];
    const exists = existing.has(capability);

    const links = deltas.map((delta) => ({
      change: delta.change,
      conflictingRequirements: delta.requirements.filter((requirement) =>
        deltas.some(
          (other) =>
            other.change !== delta.change &&
            other.requirements.some((name) => sameHeader(name, requirement)),
        ),
      ),
    }));

    nodes.push({
      capability,
      exists,
      links,
      // Висячей считается дельта к несуществующей capability, которую при этом
      // не объявляет ни один change как новую. Новая capability появляется в
      // спеках только после архивации, поэтому её отсутствие — норма.
      dangling: !exists && deltas.length === 0,
    });
  }

  return { nodes };
}

/** Перечисляет changes, затрагивающие указанную capability. */
export function changesFor(map: CapabilityMap, capability: string): readonly string[] {
  return map.nodes.find((node) => node.capability === capability)?.links.map((l) => l.change) ?? [];
}

/** Перечисляет capability, затрагиваемые указанным change. */
export function capabilitiesFor(map: CapabilityMap, change: string): readonly string[] {
  return map.nodes
    .filter((node) => node.links.some((link) => link.change === change))
    .map((node) => node.capability);
}
