import { type SchemaDocument, isContract, topologicalOrder } from '@openspec-ide/core';

interface SchemaGraphProps {
  readonly document: SchemaDocument;
  readonly selected: string | null;
  /** Артефакты с действующими нарушениями уровня «ошибка». */
  readonly failing: ReadonlySet<string>;
  /** Отслеживаемый артефакт процесса. */
  readonly tracked: string | null;
  readonly stale: boolean;
  readonly onSelect: (id: string) => void;
}

const NODE_W = 132;
const NODE_H = 48;
const GAP_X = 44;
const GAP_Y = 22;
const PAD = 16;
const BADGE = 14;

interface Placed {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly generates: string;
}

/**
 * Раскладка по слоям: слой артефакта — длина самой длинной цепочки его
 * зависимостей. Параллельные ветви оказываются в одном слое друг под другом —
 * так граф читается слева направо в порядке работы.
 */
export function layoutSchema(document: SchemaDocument): {
  nodes: Placed[];
  width: number;
  height: number;
} {
  const order = topologicalOrder({
    name: document.name,
    artifacts: document.artifacts.map((artifact) => ({ id: artifact.id, requires: artifact.requires })),
    trackedArtifactId: null,
  });
  const byId = new Map(document.artifacts.map((artifact) => [artifact.id, artifact]));
  const depth = new Map<string, number>();
  for (const id of order) {
    const requires = byId.get(id)?.requires ?? [];
    // При цикле часть зависимостей ещё не посчитана — они не учитываются,
    // и граф всё равно рисуется целиком.
    const known = requires.map((dependency) => depth.get(dependency)).filter((value) => value !== undefined);
    depth.set(id, known.length === 0 ? 0 : Math.max(...known) + 1);
  }

  const layers: string[][] = [];
  for (const id of order) {
    const layer = depth.get(id) ?? 0;
    (layers[layer] ??= []).push(id);
  }

  const tallest = Math.max(1, ...layers.map((layer) => layer.length));
  const height = PAD * 2 + BADGE + tallest * NODE_H + (tallest - 1) * GAP_Y;
  const nodes: Placed[] = [];
  layers.forEach((layer, column) => {
    const columnHeight = layer.length * NODE_H + (layer.length - 1) * GAP_Y;
    const top = PAD + BADGE + (height - PAD * 2 - BADGE - columnHeight) / 2;
    layer.forEach((id, row) => {
      nodes.push({
        id,
        x: PAD + column * (NODE_W + GAP_X),
        y: top + row * (NODE_H + GAP_Y),
        generates: byId.get(id)?.generates ?? '',
      });
    });
  });

  const width = PAD * 2 + Math.max(1, layers.length) * NODE_W + Math.max(0, layers.length - 1) * GAP_X;
  return { nodes, width, height };
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function SchemaGraph({ document, selected, failing, tracked, stale, onSelect }: SchemaGraphProps) {
  const { nodes, width, height } = layoutSchema(document);
  const position = new Map(nodes.map((node) => [node.id, node]));

  const edges = document.artifacts.flatMap((artifact) =>
    artifact.requires
      .map((dependency) => ({ from: position.get(dependency), to: position.get(artifact.id) }))
      .filter((edge): edge is { from: Placed; to: Placed } => edge.from !== undefined && edge.to !== undefined),
  );

  const label = `Граф артефактов схемы ${document.name}: ${document.artifacts
    .map((artifact) =>
      artifact.requires.length === 0 ? artifact.id : `${artifact.id} после ${artifact.requires.join(', ')}`,
    )
    .join('; ')}`;

  if (document.artifacts.length === 0) {
    return <p className="empty">В схеме нет артефактов — добавьте первый.</p>;
  }

  return (
    <svg
      className={`schema-graph ${stale ? 'stale' : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      // Граф сжимается под ширину панели, но не растягивается сверх натуральной.
      style={{ width: '100%', maxWidth: width, height: 'auto' }}
      role="group"
      aria-label={label}
      data-testid="schema-graph"
    >
      <defs>
        <marker id="schema-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" className="edge-head" />
        </marker>
      </defs>
      {edges.map(({ from, to }) => {
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x - 2;
        const y2 = to.y + NODE_H / 2;
        // Обратное ребро (цикл) огибает узлы снизу, чтобы не слиться с прямым.
        const d =
          x2 > x1
            ? `M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}`
            : `M${x1},${y1} C${x1 + 40},${height} ${x2 - 40},${height} ${x2},${y2}`;
        return (
          <path
            key={`${from.id}->${to.id}`}
            className="edge"
            d={d}
            markerEnd="url(#schema-arrow)"
            data-testid={`graph-edge-${from.id}-${to.id}`}
          />
        );
      })}
      {nodes.map((node) => {
        const artifact = document.artifacts.find((item) => item.id === node.id);
        const classes = [
          'node-box',
          artifact !== undefined && isContract(artifact) ? 'contract' : '',
          node.id === tracked ? 'tracked' : '',
          node.id === selected ? 'sel' : '',
          failing.has(node.id) ? 'failing' : '',
        ]
          .filter((item) => item !== '')
          .join(' ');
        const badge =
          node.id === selected
            ? 'ВЫБРАН'
            : artifact !== undefined && isContract(artifact)
              ? 'КОНТРАКТ'
              : node.id === tracked
                ? 'ОТСЛЕЖИВАЕТСЯ'
                : null;
        return (
          <g
            key={node.id}
            className="graph-node"
            role="button"
            tabIndex={0}
            aria-pressed={node.id === selected}
            aria-label={`Артефакт ${node.id}`}
            data-testid={`graph-node-${node.id}`}
            data-selected={node.id === selected}
            onClick={() => onSelect(node.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(node.id);
              }
            }}
          >
            {badge !== null && (
              <text className="badge-t" x={node.x + 4} y={node.y - 5}>
                {badge}
              </text>
            )}
            <rect className={classes} x={node.x} y={node.y} width={NODE_W} height={NODE_H} rx={7} />
            <text className="node-id" x={node.x + 10} y={node.y + 20}>
              {clip(node.id, 17)}
            </text>
            <text className="node-sub" x={node.x + 10} y={node.y + 36}>
              {clip(node.generates, 20)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
