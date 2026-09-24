/**
 * Модель доски процесса.
 *
 * Колонки выводятся из артефактов схемы change, а не задаются списком: доска
 * обязана одинаково работать и для встроенной схемы, и для собственной.
 */

/** Колонка доски. */
export interface BoardColumn {
  /** Идентификатор артефакта либо служебной фазы. */
  readonly id: string;
  readonly title: string;
  /** Колонка соответствует артефакту схемы, а не служебной фазе. */
  readonly isArtifact: boolean;
  /** Схемы, у которых есть этот артефакт; пусто у служебных колонок. */
  readonly schemas: readonly string[];
}

/** Карточка change на доске. */
export interface BoardCard {
  readonly change: string;
  readonly schema: string;
  /** Колонка, в которой карточка находится. */
  readonly column: string;
  readonly artifacts: readonly BoardArtifact[];
  readonly progress: { readonly complete: number; readonly total: number } | null;
  readonly errorCount: number;
  /** Валидация ни разу не выполнялась. */
  readonly validationUnknown: boolean;
  readonly lastModified: string | null;
  /** Действующие отказы схемы от правил SDD — признак на карточке. */
  readonly waivers: readonly SchemaWaiverNote[];
}

/** Артефакт change на карточке. */
export interface BoardArtifact {
  readonly id: string;
  readonly done: boolean;
  /**
   * Путь первого файла артефакта относительно корня рабочего пространства —
   * чтобы с карточки открыть его в редакторе; `null`, если файла нет.
   */
  readonly path?: string | null;
}

/** Действующий отказ схемы от правила SDD. */
export interface SchemaWaiverNote {
  readonly rule: string;
  readonly reason: string;
}

/** Доска целиком. */
export interface Board {
  readonly columns: readonly BoardColumn[];
  readonly cards: readonly BoardCard[];
}

/** Схема, как она нужна доске. */
export interface BoardSchema {
  readonly name: string;
  readonly artifacts: readonly { readonly id: string; readonly requires: readonly string[] }[];
  /** Артефакт, по которому измеряется прогресс; `null`, если схема его не объявила. */
  readonly trackedArtifactId: string | null;
  /** Действующие отказы от правил SDD. */
  readonly waivers?: readonly SchemaWaiverNote[];
}

/** Change, как он нужен доске. */
export interface BoardChange {
  readonly name: string;
  readonly schema: string;
  readonly artifacts: readonly BoardArtifact[];
  readonly progress: { readonly complete: number; readonly total: number } | null;
  readonly errorCount: number;
  readonly validationUnknown: boolean;
  readonly lastModified: string | null;
}

/** Служебные колонки, следующие за артефактами любой схемы. */
export const WORK_COLUMNS: readonly BoardColumn[] = [
  { id: 'ready', title: 'Готово к работе', isArtifact: false, schemas: [] },
  { id: 'in-progress', title: 'В работе', isArtifact: false, schemas: [] },
  { id: 'to-archive', title: 'Готово к архивации', isArtifact: false, schemas: [] },
];

/** Собирает доску из схем и активных changes. */
export function buildBoard(schemas: readonly BoardSchema[], changes: readonly BoardChange[]): Board {
  const byName = new Map(schemas.map((schema) => [schema.name, schema]));
  const orders = new Map<string, readonly string[]>();
  for (const schema of schemas) {
    orders.set(schema.name, topologicalOrder(schema));
  }

  const used = [...new Set(changes.map((change) => change.schema))].filter((name) =>
    orders.has(name),
  );
  const merged = mergeOrders(used.map((name) => ({ name, order: orders.get(name) ?? [] })));

  const columns: BoardColumn[] = [
    ...merged.map((entry) => ({
      id: entry.id,
      title: entry.id,
      isArtifact: true,
      schemas: entry.schemas,
    })),
    ...WORK_COLUMNS,
  ];

  const cards = changes.map((change) => ({
    change: change.name,
    schema: change.schema,
    column: placeCard(change, byName.get(change.schema) ?? null, orders.get(change.schema) ?? []),
    artifacts: change.artifacts,
    progress: change.progress,
    errorCount: change.errorCount,
    validationUnknown: change.validationUnknown,
    lastModified: change.lastModified,
    waivers: byName.get(change.schema)?.waivers ?? [],
  }));

  return { columns, cards };
}

/**
 * Определяет колонку карточки.
 *
 * Фаза выводится из состояния артефактов и прогресса, а не задаётся
 * пользователем: доска не должна рассказывать про процесс то, чего нет в
 * файлах.
 */
function placeCard(
  change: BoardChange,
  schema: BoardSchema | null,
  order: readonly string[],
): string {
  const done = new Map(change.artifacts.map((artifact) => [artifact.id, artifact.done]));

  // Пока планирование не завершено, карточка стоит в колонке первого
  // незаполненного артефакта — это и есть ближайший шаг.
  for (const id of order) {
    if (done.get(id) !== true) return id;
  }
  if (order.length === 0 && change.artifacts.some((artifact) => !artifact.done)) {
    return change.artifacts.find((artifact) => !artifact.done)?.id ?? 'ready';
  }

  const progress = change.progress;
  if (schema?.trackedArtifactId === null || progress === null || progress.total === 0) {
    return 'ready';
  }
  if (progress.complete === 0) return 'ready';
  if (progress.complete < progress.total) return 'in-progress';
  return 'to-archive';
}

/**
 * Упорядочивает артефакты схемы по зависимостям.
 *
 * При цикле или неизвестной зависимости порядок не теряется целиком:
 * оставшиеся артефакты дописываются в объявленном порядке, иначе схема с
 * ошибкой просто исчезла бы с доски.
 */
export function topologicalOrder(schema: BoardSchema): readonly string[] {
  const known = new Set(schema.artifacts.map((artifact) => artifact.id));
  const pending = new Map(
    schema.artifacts.map((artifact) => [
      artifact.id,
      artifact.requires.filter((id) => known.has(id)),
    ]),
  );

  const ordered: string[] = [];
  const placed = new Set<string>();

  let progressed = true;
  while (progressed && placed.size < schema.artifacts.length) {
    progressed = false;
    for (const artifact of schema.artifacts) {
      if (placed.has(artifact.id)) continue;
      const requires = pending.get(artifact.id) ?? [];
      if (requires.every((id) => placed.has(id))) {
        ordered.push(artifact.id);
        placed.add(artifact.id);
        progressed = true;
      }
    }
  }

  for (const artifact of schema.artifacts) {
    if (!placed.has(artifact.id)) ordered.push(artifact.id);
  }

  return ordered;
}

/**
 * Объединяет порядки артефактов нескольких схем в один набор колонок.
 *
 * Относительный порядок каждой схемы сохраняется; одноимённые артефакты разных
 * схем становятся одной колонкой. Отдельная доска на схему прятала бы часть
 * работы, что противоречит смыслу доски.
 */
export function mergeOrders(
  schemas: readonly { readonly name: string; readonly order: readonly string[] }[],
): readonly { readonly id: string; readonly schemas: readonly string[] }[] {
  const result: { id: string; schemas: string[] }[] = [];
  const positionOf = (id: string): number => result.findIndex((entry) => entry.id === id);

  for (const schema of schemas) {
    let insertAt = 0;
    for (const id of schema.order) {
      const existing = positionOf(id);
      if (existing === -1) {
        result.splice(insertAt, 0, { id, schemas: [schema.name] });
        insertAt += 1;
      } else {
        result[existing]?.schemas.push(schema.name);
        insertAt = existing + 1;
      }
    }
  }

  return result;
}
