import type { ModuleDef } from '@openspec-ide/core';

/** Узел на графе модулей. */
export interface LayoutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Слой: 0 — модули без зависимостей (внизу), выше — их потребители. */
  readonly layer: number;
}

export interface LayoutEdge {
  /** Потребитель. */
  readonly from: string;
  /** Зависимость. */
  readonly to: string;
}

export interface ModuleLayout {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly width: number;
  readonly height: number;
}

export const NODE_WIDTH = 132;
export const NODE_HEIGHT = 34;
const GAP_X = 22;
const GAP_Y = 64;
const PADDING = 16;

/**
 * Раскладка по слоям: библиотеки без зависимостей внизу, каждый модуль —
 * на слой выше самой «высокой» своей зависимости. Так стрелки идут сверху
 * вниз, от потребителя к зависимости. Цикл не зацикливает расчёт: модуль на
 * пути обхода считается слоем 0.
 */
export function layoutModules(modules: readonly ModuleDef[]): ModuleLayout {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const layers = new Map<string, number>();
  const visiting = new Set<string>();

  const layerOf = (id: string): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const dependencies = byId.get(id)?.dependsOn ?? [];
    const layer = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map(layerOf));
    visiting.delete(id);
    layers.set(id, layer);
    return layer;
  };
  for (const module of modules) layerOf(module.id);

  const top = Math.max(0, ...layers.values());
  const rows: string[][] = Array.from({ length: top + 1 }, () => []);
  for (const module of modules) rows[top - (layers.get(module.id) ?? 0)]!.push(module.id);

  const widest = Math.max(1, ...rows.map((row) => row.length));
  const width = PADDING * 2 + widest * NODE_WIDTH + (widest - 1) * GAP_X;
  const nodes: LayoutNode[] = [];
  rows.forEach((row, rowIndex) => {
    const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * GAP_X;
    const start = (width - rowWidth) / 2;
    row.forEach((id, index) => {
      nodes.push({
        id,
        x: start + index * (NODE_WIDTH + GAP_X),
        y: PADDING + rowIndex * (NODE_HEIGHT + GAP_Y),
        layer: layers.get(id) ?? 0,
      });
    });
  });

  const edges = modules.flatMap((module) =>
    module.dependsOn.filter((id) => byId.has(id)).map((id) => ({ from: module.id, to: id })),
  );
  return { nodes, edges, width, height: PADDING * 2 + rows.length * NODE_HEIGHT + (rows.length - 1) * GAP_Y };
}
