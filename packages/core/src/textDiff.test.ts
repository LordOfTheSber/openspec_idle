import { describe, expect, it } from 'vitest';
import { MAX_DIFF_CELLS, diffText, splitLines } from './textDiff.js';

describe('построчное сравнение', () => {
  it('одинаковые тексты не дают фрагментов', () => {
    const diff = diffText('a\nb\nc\n', 'a\nb\nc\n');

    expect(diff.hunks).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it('вставка в середину показана с тремя строками контекста', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const after = ['1', '2', '3', '4', 'new', '5', '6', '7', '8'].join('\n');

    const diff = diffText(before, after);

    expect(diff.added).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0];
    expect(hunk?.lines.map((line) => `${line.kind[0]}${line.text}`)).toEqual([
      'c2',
      'c3',
      'c4',
      'anew',
      'c5',
      'c6',
      'c7',
    ]);
    expect(hunk?.oldStart).toBe(2);
    expect(hunk?.newStart).toBe(2);
    expect(hunk?.oldLines).toBe(6);
    expect(hunk?.newLines).toBe(7);
  });

  it('замена строки — удаление перед добавлением', () => {
    const diff = diffText('a\nb\nc', 'a\nB\nc');

    expect(diff.hunks[0]?.lines.map((line) => line.kind)).toEqual(['context', 'removed', 'added', 'context']);
    expect(diff.hunks[0]?.lines[1]).toMatchObject({ text: 'b', oldLine: 2, newLine: null });
    expect(diff.hunks[0]?.lines[2]).toMatchObject({ text: 'B', oldLine: null, newLine: 2 });
  });

  it('далёкие изменения дают отдельные фрагменты', () => {
    const base = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const changed = [...base];
    changed[1] = 'first';
    changed[27] = 'second';

    const diff = diffText(base.join('\n'), changed.join('\n'));

    expect(diff.hunks).toHaveLength(2);
    expect(diff.removed).toBe(2);
    expect(diff.added).toBe(2);
  });

  it('пустой текст «до» — весь файл добавлен', () => {
    const diff = diffText('', '# spec\n\ntext\n');

    expect(diff.added).toBe(3);
    expect(diff.hunks[0]?.oldStart).toBe(0);
    expect(diff.hunks[0]?.newStart).toBe(1);
  });

  it('удаление находит общую подпоследовательность, а не заменяет всё', () => {
    const diff = diffText('a\nx\nb\ny\nc', 'a\nb\nc');

    expect(diff.removed).toBe(2);
    expect(diff.added).toBe(0);
  });

  it('слишком большая середина показывается полной заменой', () => {
    const size = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10;
    const before = Array.from({ length: size }, (_, index) => `a${index}`).join('\n');
    const after = Array.from({ length: size }, (_, index) => `b${index}`).join('\n');

    const diff = diffText(before, after);

    expect(diff.approximate).toBe(true);
    expect(diff.removed).toBe(size);
    expect(diff.added).toBe(size);
  });

  it('переводы строк Windows не считаются изменением', () => {
    expect(diffText('a\r\nb\r\n', 'a\nb\n').hunks).toEqual([]);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});
