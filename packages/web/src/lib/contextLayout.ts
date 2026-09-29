import type { ContextMap } from '@openspec-ide/core';

/** Вид узла графа контекста. */
export type ContextNodeKind = 'adr' | 'module' | 'domain';

export interface LayoutNode {
  /** Уникальный ключ: вид и идентификатор. */
  readonly key: string;
  readonly kind: ContextNodeKind;
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  /** Узел описан (спека есть, модуль описан). */
  readonly resolved: boolean;
  /** Число связей узла. */
  readonly degree: number;
}

export type EdgeKind = 'domain' | 'depends' | 'adr';

export interface LayoutEdge {
  readonly key: string;
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
  readonly resolved: boolean;
  readonly cyclic: boolean;
  /** Путь SVG. */
  readonly path: string;
}

export interface ContextLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  /** Левые края колонок, слева направо. */
  readonly columns: readonly { readonly kind: ContextNodeKind; readonly x: number; readonly title: string }[];
}

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 30;
const ROW = 42;
const TOP = 36;
const COLUMN_GAP = 150;
/** Слева от колонки модулей — место под дуги зависимостей. */
const ARC_ROOM = 70;

export function nodeKey(kind: ContextNodeKind, id: string): string {
  return `${kind}:${id}`;
}

/** Средняя позиция соседей; узлы без соседей — в конец, в исходном порядке. */
function orderBy(ids: readonly string[], neighbours: (id: string) => readonly string[], rank: ReadonlyMap<string, number>): string[] {
  const score = (id: string): number => {
    const positions = neighbours(id)
      .map((other) => rank.get(other))
      .filter((value): value is number => value !== undefined);
    return positions.length === 0 ? Number.POSITIVE_INFINITY : positions.reduce((sum, value) => sum + value, 0) / positions.length;
  };
  const original = new Map(ids.map((id, index) => [id, index]));
  return [...ids].sort((a, b) => score(a) - score(b) || (original.get(a) ?? 0) - (original.get(b) ?? 0));
}

const rankOf = (ids: readonly string[]): Map<string, number> => new Map(ids.map((id, index) => [id, index]));

/**
 * Раскладывает карту в колонки ADR → модули → домены. Порядок строк
 * подбирается методом барицентров, чтобы связи меньше пересекались.
 */
export function layoutContextMap(map: ContextMap): ContextLayout {
  const moduleDomains = new Map<string, string[]>();
  const domainModules = new Map<string, string[]>();
  for (const link of map.links) {
    moduleDomains.set(link.module, [...(moduleDomains.get(link.module) ?? []), link.domain]);
    domainModules.set(link.domain, [...(domainModules.get(link.domain) ?? []), link.module]);
  }

  let modules = map.modules.map((module) => module.id);
  const missingModules = [
    ...new Set([
      ...map.dependencies.filter((edge) => !edge.resolved).map((edge) => edge.to),
      ...map.adrLinks.filter((link) => link.kind === 'module' && !link.resolved).map((link) => link.target),
    ]),
  ].sort();
  let domains = map.domains.map((domain) => domain.id);

  // Несколько проходов вниз-вверх: этого хватает для графов в десятки узлов.
  for (let pass = 0; pass < 4; pass += 1) {
    domains = orderBy(domains, (id) => domainModules.get(id) ?? [], rankOf(modules));
    modules = orderBy(modules, (id) => moduleDomains.get(id) ?? [], rankOf(domains));
  }
  const allModules = [...modules, ...missingModules];
  const moduleRank = rankOf(allModules);
  const domainRank = rankOf(domains);
  const adrs = orderBy(
    map.adrs.map((adr) => adr.path),
    (path) => map.adrLinks.filter((link) => link.adr === path && link.kind === 'module').map((link) => link.target),
    moduleRank,
  );

  const hasAdrs = adrs.length > 0;
  const adrX = 0;
  const moduleX = hasAdrs ? NODE_WIDTH + COLUMN_GAP : ARC_ROOM;
  const domainX = moduleX + NODE_WIDTH + COLUMN_GAP;
  const rowY = (index: number): number => TOP + index * ROW;

  const degree = new Map<string, number>();
  const bump = (key: string): void => {
    degree.set(key, (degree.get(key) ?? 0) + 1);
  };
  for (const link of map.links) {
    bump(nodeKey('module', link.module));
    bump(nodeKey('domain', link.domain));
  }
  for (const edge of map.dependencies) {
    bump(nodeKey('module', edge.from));
    bump(nodeKey('module', edge.to));
  }
  for (const link of map.adrLinks) {
    bump(nodeKey('adr', link.adr));
    bump(nodeKey(link.kind, link.target));
  }

  const adrTitle = new Map(map.adrs.map((adr) => [adr.path, adr.id]));
  const knownDomains = new Set(map.domains.filter((domain) => domain.specPath !== null).map((domain) => domain.id));
  const nodes: LayoutNode[] = [
    ...adrs.map((path, index) => ({
      key: nodeKey('adr', path),
      kind: 'adr' as const,
      id: path,
      label: adrTitle.get(path) ?? path,
      x: adrX,
      y: rowY(index),
      resolved: true,
      degree: degree.get(nodeKey('adr', path)) ?? 0,
    })),
    ...allModules.map((id, index) => ({
      key: nodeKey('module', id),
      kind: 'module' as const,
      id,
      label: id,
      x: moduleX,
      y: rowY(index),
      resolved: index < modules.length,
      degree: degree.get(nodeKey('module', id)) ?? 0,
    })),
    ...domains.map((id, index) => ({
      key: nodeKey('domain', id),
      kind: 'domain' as const,
      id,
      label: id,
      x: domainX,
      y: rowY(index),
      resolved: knownDomains.has(id),
      degree: degree.get(nodeKey('domain', id)) ?? 0,
    })),
  ];

  const mid = NODE_HEIGHT / 2;
  const curve = (x1: number, y1: number, x2: number, y2: number): string => {
    const bend = (x2 - x1) / 2;
    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
  };
  const moduleY = (id: string): number => rowY(moduleRank.get(id) ?? 0) + mid;
  const domainY = (id: string): number => rowY(domainRank.get(id) ?? 0) + mid;
  const adrY = (path: string): number => rowY(adrs.indexOf(path)) + mid;

  const edges: LayoutEdge[] = [
    ...map.links.map((link) => ({
      key: `domain:${link.module}->${link.domain}`,
      kind: 'domain' as const,
      from: nodeKey('module', link.module),
      to: nodeKey('domain', link.domain),
      resolved: link.resolved,
      cyclic: false,
      path: curve(moduleX + NODE_WIDTH, moduleY(link.module), domainX, domainY(link.domain)),
    })),
    ...map.dependencies.map((edge) => {
      // Дуга слева от колонки модулей: чем дальше модули, тем шире дуга.
      const y1 = moduleY(edge.from);
      const y2 = moduleY(edge.to);
      const reach = Math.min(ARC_ROOM - 8, 18 + Math.abs(y2 - y1) / 4);
      return {
        key: `depends:${edge.from}->${edge.to}`,
        kind: 'depends' as const,
        from: nodeKey('module', edge.from),
        to: nodeKey('module', edge.to),
        resolved: edge.resolved,
        cyclic: edge.cyclic,
        path: `M${moduleX},${y1 - 4} C${moduleX - reach},${y1 - 4} ${moduleX - reach},${y2 + 4} ${moduleX},${y2 + 4}`,
      };
    }),
    ...map.adrLinks.map((link) => ({
      key: `adr:${link.adr}->${link.kind}:${link.target}`,
      kind: 'adr' as const,
      from: nodeKey('adr', link.adr),
      to: nodeKey(link.kind, link.target),
      resolved: link.resolved,
      cyclic: false,
      path:
        link.kind === 'module'
          ? curve(adrX + NODE_WIDTH, adrY(link.adr), moduleX, moduleY(link.target))
          : curve(adrX + NODE_WIDTH, adrY(link.adr), domainX, domainY(link.target)),
    })),
  ];

  const rows = Math.max(adrs.length, allModules.length, domains.length, 1);
  return {
    width: domainX + NODE_WIDTH + 4,
    height: rowY(rows) + 4,
    nodes,
    edges,
    columns: [
      ...(hasAdrs ? [{ kind: 'adr' as const, x: adrX, title: 'ADR' }] : []),
      { kind: 'module' as const, x: moduleX, title: 'Модули' },
      { kind: 'domain' as const, x: domainX, title: 'Домены (openspec/specs)' },
    ],
  };
}

/** Узлы, связанные с выбранным, включая его самого. */
export function neighbourhood(layout: ContextLayout, key: string): Set<string> {
  const keys = new Set([key]);
  for (const edge of layout.edges) {
    if (edge.from === key) keys.add(edge.to);
    if (edge.to === key) keys.add(edge.from);
  }
  return keys;
}
