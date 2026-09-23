import { describe, expect, it } from 'vitest';
import { formatDuration, formatShare, formatTokens, plural } from './format.js';

describe('форматирование', () => {
  it('склоняет существительные по числу', () => {
    const forms = ['запуск', 'запуска', 'запусков'] as const;
    expect(plural(1, forms)).toBe('1 запуск');
    expect(plural(4, forms)).toBe('4 запуска');
    expect(plural(9, forms)).toBe('9 запусков');
    expect(plural(11, forms)).toBe('11 запусков');
    expect(plural(21, forms)).toBe('21 запуск');
    expect(plural(0, forms)).toBe('0 запусков');
  });

  it('расход без данных — это «нет данных», а не ноль', () => {
    expect(formatTokens(null)).toBe('нет данных');
    expect(formatTokens(0)).toBe('0');
  });

  it('крупный расход сокращается', () => {
    expect(formatTokens(61_400)).toBe('61,4 тыс.');
    expect(formatTokens(2_500_000)).toBe('2,5 млн');
  });

  it('длительность переходит в дни, когда часов больше суток', () => {
    expect(formatDuration(42_000)).toBe('42 с');
    expect(formatDuration(16 * 60_000)).toBe('16 мин');
    expect(formatDuration(200 * 60_000)).toBe('3 ч 20 мин');
    expect(formatDuration((4938 * 60 + 39) * 60_000)).toBe('205 дн 18 ч');
    expect(formatDuration(null)).toBe('—');
  });

  it('доля — в процентах', () => {
    expect(formatShare(0.5)).toBe('50 %');
    expect(formatShare(null)).toBe('—');
  });
});
