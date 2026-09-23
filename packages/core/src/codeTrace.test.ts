import { describe, expect, it } from 'vitest';
import { coverageState, extractNameMentions, isTestPath, normalizeScenarioName, parseSpecTag, sameRequirement } from './codeTrace.js';

describe('метки @spec', () => {
  it.each([
    ['// @spec billing: Счета / Нумерация счетов', 'billing', 'Счета / Нумерация счетов'],
    ['# @spec km/core: Кэш ответов', 'km/core', 'Кэш ответов'],
    ['/* @spec billing: Возвраты / Полный возврат */', 'billing', 'Возвраты / Полный возврат'],
    ['<!-- @spec web-ui: Список счетов -->', 'web-ui', 'Список счетов'],
    ['-- @spec reports: Отчёт по дням', 'reports', 'Отчёт по дням'],
    ['   * @spec km/auth-client : Обновление токена   ', 'km/auth-client', 'Обновление токена'],
  ])('%s', (line, module, requirement) => {
    expect(parseSpecTag(line)).toEqual({ module, requirement });
  });

  it('строка без метки и пустое имя', () => {
    expect(parseSpecTag('// обычный комментарий')).toBeNull();
    expect(parseSpecTag('// @spec billing: */')).toBeNull();
  });

  it('имена требований сравниваются без регистра и повторных пробелов', () => {
    expect(sameRequirement('Счета /  Нумерация счетов', 'счета / нумерация Счетов')).toBe(true);
    expect(sameRequirement('Кэш', 'Кэш ответов')).toBe(false);
  });
});

describe('тестовые пути', () => {
  it.each([
    ['services/billing/src/test/kotlin/InvoiceNumbersTest.kt', true], // Maven/Gradle
    ['services/billing/src/main/kotlin/InvoiceNumbers.kt', false],
    ['ui/src/InvoiceList.test.tsx', true], // Jest/Vitest
    ['ui/src/__tests__/list.tsx', true],
    ['ui/src/list.spec.ts', true],
    ['svc/handler_test.go', true], // Go
    ['svc/handler.go', false],
    ['py/tests/test_report.py', true], // Python
    ['py/report/test_report.py', true],
    ['py/report/report.py', false],
    ['km/core/src/main/java/CacheTests.java', true],
    ['km/core/src/main/java/Testing.java', false],
  ])('%s → %s', (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });

  it('свои шаблоны', () => {
    expect(isTestPath('services/x/it/Flow.kt', ['**/it/**'])).toBe(true);
    expect(isTestPath('services/x/src/Flow.kt', ['**/it/**'])).toBe(false);
  });
});

describe('вероятное покрытие по именам сценариев', () => {
  it('имя теста в обратных кавычках, @DisplayName и строковый литерал', () => {
    const text = [
      'class RefundsTest {',
      '  @Test fun `Полный возврат`() {}',
      '  @DisplayName("Частичный возврат, остаток")',
      "  it('полный  возврат!', () => {})",
      '  val x = "ok"',
    ].join('\n');
    const mentions = extractNameMentions(text);
    expect(mentions).toEqual([
      { line: 2, text: 'полный возврат' },
      { line: 3, text: 'частичный возврат остаток' },
      { line: 4, text: 'полный возврат' },
    ]);
    expect(mentions.some((mention) => mention.text === normalizeScenarioName('Полный возврат'))).toBe(true);
  });

  it('состояния покрытия', () => {
    expect(coverageState({ code: 1, tests: 1, probable: 0 })).toBe('full');
    expect(coverageState({ code: 1, tests: 0, probable: 3 })).toBe('code');
    expect(coverageState({ code: 0, tests: 2, probable: 0 })).toBe('tests');
    expect(coverageState({ code: 0, tests: 0, probable: 1 })).toBe('probable');
    expect(coverageState({ code: 0, tests: 0, probable: 0 })).toBe('none');
  });
});
