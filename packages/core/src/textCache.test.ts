import { describe, expect, it } from 'vitest';
import { findTokenAntipatterns } from './contextAntipatterns.js';
import { estimateTokens, extractReferences, measureUsefulness, textReferenceCandidates } from './contextControl.js';
import { TextCache } from './textCache.js';

describe('кэш расчётов по тексту', () => {
  it('тот же текст — посчитанный ранее результат, другой текст или вид расчёта — новый', () => {
    const cache = new TextCache(4, 1000, 10);
    let calls = 0;
    const compute = (): { calls: number } => ({ calls: (calls += 1) });

    const first = cache.get('abcdef', 'kind', compute);
    expect(cache.get('abcdef', 'kind', compute)).toBe(first);
    expect(calls).toBe(1);
    expect(cache.get('abcdeg', 'kind', compute)).not.toBe(first);
    expect(cache.get('abcdef', 'other', compute)).not.toBe(first);
    expect(calls).toBe(3);
  });

  it('короткие тексты не запоминаются', () => {
    const cache = new TextCache(4, 1000, 10);
    let calls = 0;
    cache.get('abc', 'kind', () => (calls += 1));
    cache.get('abc', 'kind', () => (calls += 1));
    expect(calls).toBe(2);
    expect(cache.size.entries).toBe(0);
  });

  it('при превышении объёма вытесняются давно не нужные тексты', () => {
    const cache = new TextCache(1, 10, 100);
    cache.get('aaaa', 'kind', () => 1);
    cache.get('bbbb', 'kind', () => 2);
    // `aaaa` нужен снова — давно не нужным становится `bbbb`.
    cache.get('aaaa', 'kind', () => 0);
    cache.get('cccc', 'kind', () => 3);
    expect(cache.size).toEqual({ entries: 2, chars: 8 });
    expect(cache.get('aaaa', 'kind', () => -1)).toBe(1);
    expect(cache.get('bbbb', 'kind', () => -2)).toBe(-2);
  });

  it('при превышении числа записей — тоже', () => {
    const cache = new TextCache(1, 1000, 2);
    for (const text of ['aa', 'bb', 'cc']) cache.get(text, 'kind', () => text);
    expect(cache.size.entries).toBe(2);
    expect(cache.get('aa', 'kind', () => 'заново')).toBe('заново');
  });
});

describe('анализ файла контекста запоминается по тексту', () => {
  const paragraph = 'Мастер хранит сессии в `src/session/Store.java` и реплицирует их синхронно, ЭТО ОЧЕНЬ ВАЖНО.';
  const large = `# Модуль\n\n${Array.from({ length: 40 }, (_, index) => `${paragraph} Абзац ${index}.`).join('\n\n')}\n`;

  it('повторный вызов на том же тексте возвращает тот же результат', () => {
    expect(large.length).toBeGreaterThan(2048);
    expect(findTokenAntipatterns(large)).toBe(findTokenAntipatterns(large));
    expect(extractReferences(large)).toBe(extractReferences(large));
    expect(textReferenceCandidates(large, 'openspec/context/modules/m/context.md', ['svc'])).toBe(
      textReferenceCandidates(large, 'openspec/context/modules/m/context.md', ['svc']),
    );
    const options = { duplicateLines: new Set([3]), grounding: true, commitsAfter: 2 };
    expect(measureUsefulness(large, options)).toBe(measureUsefulness(large, { ...options, duplicateLines: new Set([3]) }));
  });

  it('другой текст или другие параметры — новый расчёт', () => {
    const edited = `${large}\nНовый абзац без пути.\n`;
    expect(estimateTokens(edited)).toBeGreaterThan(estimateTokens(large));
    expect(extractReferences(edited)).not.toBe(extractReferences(large));
    expect(measureUsefulness(large, { commitsAfter: 10 }).freshness).toBe(0.5);
    expect(measureUsefulness(large, { commitsAfter: 0 }).freshness).toBe(1);
    expect(textReferenceCandidates(large, 'a/b.md')).not.toBe(textReferenceCandidates(large, 'c/d.md'));
    expect(textReferenceCandidates(large, 'a/b.md', ['x'])).not.toBe(textReferenceCandidates(large, 'a/b.md', ['y']));
  });
});
