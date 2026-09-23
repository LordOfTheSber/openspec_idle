import { WORK_COLUMNS, topologicalOrder } from './board.js';
import type { SchemaDocument } from './schemaDocument.js';

/** Как схема выглядит в работе — до назначения. */
export interface SchemaPreview {
  /** Артефакты в порядке зависимостей. */
  readonly order: readonly string[];
  /** Заголовки колонок доски: артефакты, затем колонки работы. */
  readonly columns: readonly string[];
  /** Идентификатор отслеживаемого артефакта; `null` — прогресс не измеряется. */
  readonly trackedArtifact: string | null;
  readonly warning: string | null;
}

/** Строит предпросмотр процесса по схеме, в том числе несохранённой. */
export function previewSchema(document: SchemaDocument): SchemaPreview {
  const order = topologicalOrder({
    name: document.name,
    artifacts: document.artifacts.map((artifact) => ({ id: artifact.id, requires: artifact.requires })),
    trackedArtifactId: null,
  });
  const tracked =
    document.apply.tracks === null
      ? null
      : (document.artifacts.find((artifact) => artifact.generates === document.apply.tracks)?.id ?? null);

  return {
    order,
    columns: [...order, ...WORK_COLUMNS.map((column) => column.title)],
    trackedArtifact: tracked,
    warning:
      tracked === null
        ? 'Схема не объявила отслеживаемый артефакт — прогресс работы по такому процессу измеряться не будет.'
        : null,
  };
}
