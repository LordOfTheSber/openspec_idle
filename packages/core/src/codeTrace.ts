/**
 * Связь требований с кодом: метки `@spec <модуль>: <требование>` в
 * комментариях любого языка и тесты, названные по сценариям.
 */

/** Метка требования в строке кода. */
export interface SpecTag {
  readonly module: string;
  readonly requirement: string;
}

const RE_TAG = /@spec\s+([\w./-]+)\s*:\s*(.+?)\s*(?:\*\/|-->|$)/;

/**
 * Разбирает метку в строке. Язык не важен: хвост закрывающего комментария
 * (`*\/`, `-->`) отрезается, остальное — имя требования.
 */
export function parseSpecTag(line: string): SpecTag | null {
  const match = RE_TAG.exec(line);
  if (match === null) return null;
  const requirement = match[2]!.replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
  if (requirement === '') return null;
  return { module: match[1]!, requirement };
}

/** Сравнение имён требований: без учёта регистра и повторных пробелов. */
export function sameRequirement(a: string, b: string): boolean {
  return normalizeRequirement(a) === normalizeRequirement(b);
}

export function normalizeRequirement(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Шаблоны тестовых путей по умолчанию: Maven и Gradle (`src/test/`), Jest и
 * Vitest (`*.test.*`, `*.spec.*`, `__tests__`), Go (`*_test.go`), Python
 * (`tests/`, `test_*.py`), JUnit (`*Test.*`, `*Tests.*`).
 */
export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*Test.*',
  '**/*Tests.*',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/test_*.py',
];

/** Путь (через `/`, от корня репозитория) подходит под шаблоны тестов. */
export function isTestPath(path: string, patterns: readonly string[] = DEFAULT_TEST_PATTERNS): boolean {
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

const globCache = new Map<string, RegExp>();

/** `**` — любые каталоги (в том числе ни одного), `*` — часть имени, `?` — символ. */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached !== undefined) return cached;
  let regex = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';
      regex += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const compiled = new RegExp(`^${regex}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

/** Имя сценария для сравнения: нижний регистр, без пунктуации, пробелы схлопнуты. */
export function normalizeScenarioName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Упоминание имени в тестовом файле: строка и нормализованный текст. */
export interface NameMention {
  readonly line: number;
  readonly text: string;
}

const RE_BACKTICK = /`([^`\n]{3,200})`/g;
const RE_STRING = /"([^"\n\\]{3,200})"|'([^'\n\\]{3,200})'/g;

/**
 * Кандидаты в имена тестов: идентификаторы в обратных кавычках (Kotlin),
 * строковые литералы (`it('…')`, `@DisplayName("…")`, `t.Run("…")`).
 * Возвращаются нормализованными — сравниваются с именами сценариев.
 */
export function extractNameMentions(text: string): NameMention[] {
  const mentions: NameMention[] = [];
  text.split('\n').forEach((raw, index) => {
    for (const match of raw.matchAll(RE_BACKTICK)) push(match[1]!, index + 1);
    for (const match of raw.matchAll(RE_STRING)) push((match[1] ?? match[2])!, index + 1);
  });
  return mentions;

  function push(value: string, line: number): void {
    const normalized = normalizeScenarioName(value);
    // Слишком короткое совпадение («ok», «a b») — не имя теста.
    if (normalized.length >= 4 && normalized.includes(' ')) mentions.push({ line, text: normalized });
  }
}

/** Состояние покрытия требования. */
export type CoverageState = 'full' | 'code' | 'tests' | 'probable' | 'none';

export const COVERAGE_LABEL: Readonly<Record<CoverageState, string>> = {
  full: 'код и тесты',
  code: 'только код',
  tests: 'только тесты',
  probable: 'вероятно, по именам',
  none: 'нет покрытия',
};

/**
 * Состояние по меткам и вероятным тестам. Вероятное покрытие — догадка по
 * имени, поэтому оно не поднимает требование до «код и тесты».
 */
export function coverageState(counts: { readonly code: number; readonly tests: number; readonly probable: number }): CoverageState {
  if (counts.code > 0 && counts.tests > 0) return 'full';
  if (counts.code > 0) return 'code';
  if (counts.tests > 0) return 'tests';
  if (counts.probable > 0) return 'probable';
  return 'none';
}
