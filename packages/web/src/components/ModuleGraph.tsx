import { useMemo } from 'react';
import type { ModuleDef } from '@openspec-ide/core';
import { NODE_HEIGHT, NODE_WIDTH, layoutModules } from '../lib/moduleLayout.js';

/** Как подсвечен модуль на графе. */
export type ModuleMark = 'source' | 'direct' | 'transitive';

/** Дополнительная связь поверх зависимостей: ссылки требований между модулями. */
export interface ExtraEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  /** `mismatch` — связи нет в карте зависимостей. */
  readonly kind: 'link' | 'mismatch';
}

export function ModuleGraph({
  modules,
  selected,
  marks,
  counts,
  extraEdges = [],
  onSelect,
}: {
  readonly modules: readonly ModuleDef[];
  readonly selected: string | null;
  readonly marks?: ReadonlyMap<string, ModuleMark>;
  /** Число активных changes модуля — бейдж на узле. */
  readonly counts?: Readonly<Record<string, number>>;
  readonly extraEdges?: readonly ExtraEdge[];
  readonly onSelect?: (id: string) => void;
}) {
  const layout = useMemo(() => layoutModules(modules), [modules]);
  const position = new Map(layout.nodes.map((node) => [node.id, node]));
  const kind = new Map(modules.map((module) => [module.id, module.kind]));
  const highlighted = marks !== undefined && marks.size > 0;

  const edgePath = (from: string, to: string, bend = 0): string | null => {
    const a = position.get(from);
    const b = position.get(to);
    if (a === undefined || b === undefined) return null;
    const x1 = a.x + NODE_WIDTH / 2;
    const y1 = a.y + (b.y >= a.y ? NODE_HEIGHT : 0);
    const x2 = b.x + NODE_WIDTH / 2;
    const y2 = b.y + (b.y >= a.y ? 0 : NODE_HEIGHT);
    const midX = (x1 + x2) / 2 + bend;
    const midY = (y1 + y2) / 2;
    return `M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}`;
  };

  return (
    <svg
      className="module-graph"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      role="img"
      aria-label="Граф модулей"
      data-testid="module-graph"
    >
      <defs>
        <marker id="module-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 8 4 L 0 8 z" className="arrow" />
        </marker>
      </defs>
      {layout.edges.map((edge) => {
        const path = edgePath(edge.from, edge.to);
        if (path === null) return null;
        const lit = marks?.has(edge.from) === true && marks.has(edge.to);
        return (
          <path
            key={`${edge.from}->${edge.to}`}
            d={path}
            className={`edge ${lit ? 'lit' : highlighted ? 'dim' : ''}`}
            markerEnd="url(#module-arrow)"
          />
        );
      })}
      {extraEdges.map((edge) => {
        const path = edgePath(edge.from, edge.to, 26);
        if (path === null) return null;
        const a = position.get(edge.from)!;
        const b = position.get(edge.to)!;
        return (
          <g key={`x-${edge.from}->${edge.to}`} data-testid={`link-edge-${edge.from}-${edge.to}`} data-kind={edge.kind}>
            <path d={path} className={`edge extra ${edge.kind}`} markerEnd="url(#module-arrow)" />
            <text x={(a.x + b.x) / 2 + NODE_WIDTH / 2 + 16} y={(a.y + b.y) / 2 + NODE_HEIGHT / 2} className="edge-label">
              {edge.label}
            </text>
          </g>
        );
      })}
      {layout.nodes.map((node) => {
        const mark = marks?.get(node.id);
        const count = counts?.[node.id] ?? 0;
        return (
          <g
            key={node.id}
            transform={`translate(${node.x}, ${node.y})`}
            className={`node ${kind.get(node.id) ?? ''} ${selected === node.id ? 'sel' : ''} ${mark ?? (highlighted ? 'dim' : '')}`}
            onClick={() => onSelect?.(node.id)}
            role="button"
            tabIndex={0}
            aria-label={`Модуль ${node.id}`}
            data-testid={`graph-module-${node.id}`}
            data-mark={mark ?? ''}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect?.(node.id);
            }}
          >
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} />
            <text x={10} y={NODE_HEIGHT / 2 + 4}>
              {node.id.length > 17 ? `${node.id.slice(0, 16)}…` : node.id}
            </text>
            {count > 0 && (
              <g transform={`translate(${NODE_WIDTH - 12}, -6)`}>
                <circle r={9} className="badge" />
                <text className="badge-text" textAnchor="middle" y={4}>
                  {count}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
