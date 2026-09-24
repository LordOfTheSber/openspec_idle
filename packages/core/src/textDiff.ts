/**
 * Построчное сравнение двух текстов с нарезкой на фрагменты, как `diff -u`.
 *
 * Нужно предпросмотру архивации: показать, какие строки основного спека
 * появятся и пропадут. Спеки — сотни строк, поэтому достаточно классического
 * LCS; общее начало и конец отсекаются заранее, так что обычная правка в
 * середине файла сравнивается мгновенно.
 */

/** Строка сравнения. */
export interface TextDiffLine {
  readonly kind: 'context' | 'added' | 'removed';
  readonly text: string;
  /** Номер строки в тексте «до», начиная с 1; `null` у добавленной строки. */
  readonly oldLine: number | null;
  /** Номер строки в тексте «после», начиная с 1; `null` у удалённой строки. */
  readonly newLine: number | null;
}

/** Фрагмент сравнения: изменённые строки с контекстом вокруг. */
export interface TextDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly TextDiffLine[];
}

/** Результат сравнения. */
export interface TextDiff {
  readonly hunks: readonly TextDiffHunk[];
  readonly added: number;
  readonly removed: number;
  /**
   * Тексты слишком велики для построчного сопоставления, и сравнение показано
   * как полная замена изменившейся середины.
   */
  readonly approximate: boolean;
}

/** Предел размера матрицы LCS: больше — середина показывается полной заменой. */
export const MAX_DIFF_CELLS = 4_000_000;

/** Разбивает текст на строки; завершающий перевод строки не даёт пустой строки. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Сравнивает тексты и режет результат на фрагменты с `context` строками контекста. */
export function diffText(before: string, after: string, context = 3): TextDiff {
  const { lines, approximate } = diffLineList(splitLines(before), splitLines(after));
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'added') added += 1;
    if (line.kind === 'removed') removed += 1;
  }
  return { hunks: toHunks(lines, context), added, removed, approximate };
}

function diffLineList(
  a: readonly string[],
  b: readonly string[],
): { lines: TextDiffLine[]; approximate: boolean } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const lines: TextDiffLine[] = [];
  const context = (oldIndex: number, newIndex: number): void => {
    lines.push({ kind: 'context', text: a[oldIndex] ?? '', oldLine: oldIndex + 1, newLine: newIndex + 1 });
  };

  for (let index = 0; index < prefix; index += 1) context(index, index);

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const n = middleA.length;
  const m = middleB.length;
  const approximate = n * m > MAX_DIFF_CELLS;

  if (approximate) {
    for (let i = 0; i < n; i += 1) {
      lines.push({ kind: 'removed', text: middleA[i] ?? '', oldLine: prefix + i + 1, newLine: null });
    }
    for (let j = 0; j < m; j += 1) {
      lines.push({ kind: 'added', text: middleB[j] ?? '', oldLine: null, newLine: prefix + j + 1 });
    }
  } else {
    // lcs[i * (m + 1) + j] — длина общей подпоследовательности хвостов
    // middleA[i..] и middleB[j..]: так проход вперёд восстанавливает её сразу.
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          middleA[i] === middleB[j]
            ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
      }
    }

    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && middleA[i] === middleB[j]) {
        context(prefix + i, prefix + j);
        i += 1;
        j += 1;
      } else if (j >= m || (i < n && (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))) {
        lines.push({ kind: 'removed', text: middleA[i] ?? '', oldLine: prefix + i + 1, newLine: null });
        i += 1;
      } else {
        lines.push({ kind: 'added', text: middleB[j] ?? '', oldLine: null, newLine: prefix + j + 1 });
        j += 1;
      }
    }
  }

  for (let index = 0; index < suffix; index += 1) {
    context(a.length - suffix + index, b.length - suffix + index);
  }

  return { lines, approximate };
}

function toHunks(lines: readonly TextDiffLine[], context: number): TextDiffHunk[] {
  const changed: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== 'context') changed.push(index);
  });
  if (changed.length === 0) return [];

  // Соседние изменения, между которыми не больше 2·context строк контекста,
  // попадают в один фрагмент — иначе контекст повторялся бы дважды.
  const ranges: { start: number; end: number }[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map(({ start, end }) => {
    const slice = lines.slice(start, end + 1);
    const oldNumbers = slice.map((line) => line.oldLine).filter((value): value is number => value !== null);
    const newNumbers = slice.map((line) => line.newLine).filter((value): value is number => value !== null);
    return {
      oldStart: oldNumbers[0] ?? precedingLine(lines, start, 'oldLine'),
      oldLines: oldNumbers.length,
      newStart: newNumbers[0] ?? precedingLine(lines, start, 'newLine'),
      newLines: newNumbers.length,
      lines: slice,
    };
  });
}

/** Номер строки, после которой начинается фрагмент без строк на этой стороне. */
function precedingLine(lines: readonly TextDiffLine[], start: number, side: 'oldLine' | 'newLine'): number {
  for (let index = start - 1; index >= 0; index -= 1) {
    const value = lines[index]?.[side];
    if (value !== null && value !== undefined) return value;
  }
  return 0;
}
