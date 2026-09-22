/**
 * Разбор отслеживаемого артефакта на пункты и точечная правка чекбоксов.
 *
 * Файл пунктов правят и человек, и агент, поэтому отметка меняет ровно
 * диапазон символов внутри скобок: перезапись файла из разобранной модели
 * нормализовала бы пробелы и порядок и дала бы шумные диффы.
 */

/** Один пункт отслеживаемого артефакта. */
export interface TrackedItem {
  /** Номер группы, к которой относится пункт. */
  readonly group: number;
  /** Порядковый номер пункта внутри группы. */
  readonly index: number;
  /** Номер, объявленный в тексте пункта, например `2.3`; `null`, если его нет. */
  readonly declaredNumber: string | null;
  readonly text: string;
  readonly done: boolean;
  /** Номер строки в файле, начиная с 1. */
  readonly line: number;
  /** Позиция символа внутри скобок чекбокса, считая от начала файла. */
  readonly markerOffset: number;
  /** Длина содержимого скобок. */
  readonly markerLength: number;
}

/** Заголовок группы пунктов. */
export interface TrackedGroup {
  readonly number: number;
  readonly title: string;
  readonly line: number;
}

/** Разобранный отслеживаемый артефакт. */
export interface TrackedDocument {
  readonly groups: readonly TrackedGroup[];
  readonly items: readonly TrackedItem[];
  readonly complete: number;
  readonly total: number;
}

const RE_GROUP = /^##\s+(\d+)\.\s*(.*)$/;
const RE_ITEM = /^(\s*[-*]\s*\[)([^\]]*)(\]\s*)(.*)$/;
const RE_NUMBER = /^(\d+(?:\.\d+)*)\s+/;

/**
 * Считает пункт выполненным по тому же правилу, что и CLI: в скобках стоит
 * `x` в любом регистре и с любыми пробелами. Любой другой маркер — включая
 * `~` и `-` — означает невыполненный пункт.
 */
export function isDoneMarker(marker: string): boolean {
  return marker.trim().toLowerCase() === 'x';
}

/** Разбирает отслеживаемый артефакт. */
export function parseTrackedDocument(text: string): TrackedDocument {
  const lines = text.split('\n');
  const groups: TrackedGroup[] = [];
  const items: TrackedItem[] = [];

  let currentGroup = 0;
  let indexInGroup = 0;
  let offset = 0;

  for (let position = 0; position < lines.length; position += 1) {
    const raw = lines[position] ?? '';
    const lineNumber = position + 1;

    const group = RE_GROUP.exec(raw);
    if (group?.[1] !== undefined) {
      currentGroup = Number(group[1]);
      indexInGroup = 0;
      groups.push({ number: currentGroup, title: (group[2] ?? '').trim(), line: lineNumber });
      offset += raw.length + 1;
      continue;
    }

    const item = RE_ITEM.exec(raw);
    if (item !== null) {
      const [, prefix = '', marker = '', , rest = ''] = item;
      indexInGroup += 1;
      const numberMatch = RE_NUMBER.exec(rest);
      items.push({
        group: currentGroup,
        index: indexInGroup,
        declaredNumber: numberMatch?.[1] ?? null,
        text: numberMatch === null ? rest.trim() : rest.slice(numberMatch[0].length).trim(),
        done: isDoneMarker(marker),
        line: lineNumber,
        markerOffset: offset + prefix.length,
        markerLength: marker.length,
      });
    }

    offset += raw.length + 1;
  }

  return {
    groups,
    items,
    complete: items.filter((item) => item.done).length,
    total: items.length,
  };
}

/** Пункт с таким номером строки не найден. */
export class TrackedItemNotFoundError extends Error {
  constructor(readonly line: number) {
    super(`В отслеживаемом артефакте нет пункта на строке ${line}`);
    this.name = 'TrackedItemNotFoundError';
  }
}

/**
 * Переключает отметку пункта, меняя только содержимое скобок.
 *
 * Возвращает новое содержимое файла; все остальные байты сохраняются как есть,
 * включая формулировки, заголовки групп, отступы и порядок строк.
 */
export function toggleTrackedItem(text: string, line: number, done: boolean): string {
  const document = parseTrackedDocument(text);
  const item = document.items.find((candidate) => candidate.line === line);
  if (item === undefined) throw new TrackedItemNotFoundError(line);

  const marker = done ? 'x' : ' ';
  return (
    text.slice(0, item.markerOffset) +
    marker +
    text.slice(item.markerOffset + item.markerLength)
  );
}
