import { describe, expect, it } from 'vitest';
import {
  LARGE_CODE_BLOCK_TOKENS,
  antipatternMessage,
  antipatternSavings,
  findTokenAntipatterns,
  type TokenAntipatternKind,
} from './contextAntipatterns.js';
import { estimateTokens } from './contextControl.js';

function kinds(text: string): TokenAntipatternKind[] {
  return findTokenAntipatterns(text).map((found) => found.kind);
}

function only(text: string, kind: TokenAntipatternKind) {
  return findTokenAntipatterns(text).find((found) => found.kind === kind);
}

const RUSSIAN = 'Мастер хранит данные сессии в памяти и реплицирует их синхронно на резервный узел до ответа клиенту.';
const ENGLISH = 'The master keeps session data in memory and replicates it synchronously to the standby node before replying.';

describe('антипаттерны по токенам: язык', () => {
  it('файл на русском от 200 токенов — находка на весь файл с долей и экономией', () => {
    const text = `# Мастер\n\n${Array.from({ length: 8 }, () => RUSSIAN).join('\n\n')}\n`;
    const found = only(text, 'non-english-text');
    expect(found).toMatchObject({ line: null, sample: 'кириллица' });
    expect(found?.share).toBeGreaterThan(0.9);
    // Экономия — разница оценок тех же букв: 1/2,5 − 1/4 токена на букву.
    const letters = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
    expect(found?.savings).toBe(Math.round(letters * 0.15));
    expect(antipatternMessage(found!, estimateTokens(text))).toContain('кириллица');
  });

  it('английский текст, лёгкий русский файл и русский с кодом ниже порога — без находки', () => {
    expect(kinds(Array.from({ length: 12 }, () => ENGLISH).join('\n\n'))).toEqual([]);
    expect(kinds(`# Мастер\n\n${RUSSIAN}\n`)).toEqual([]);
    const mostlyCode = `${RUSSIAN}\n\n\`\`\`ts\n${'export const sessionStore = new Map<string, Session>();\n'.repeat(30)}\`\`\`\n`;
    expect(kinds(mostlyCode)).not.toContain('non-english-text');
  });
});

describe('антипаттерны по токенам: блоки кода и данные', () => {
  it('большой блок кода — находка на строке ``` с числом строк; маленький — нет', () => {
    const big = Array.from({ length: 60 }, (_, index) => `  const value${index} = computeSomething(input, ${index});`).join('\n');
    const text = `# Код\n\nПример:\n\n\`\`\`ts\n${big}\n\`\`\`\n\n\`\`\`ts\nconst small = 1;\n\`\`\`\n`;
    const found = findTokenAntipatterns(text).filter((item) => item.kind === 'large-code-block');
    expect(found).toEqual([expect.objectContaining({ line: 5, count: 60, sample: 'ts' })]);
    expect(found[0]?.savings).toBeGreaterThanOrEqual(LARGE_CODE_BLOCK_TOKENS);
  });

  it('base64, hex и data:-адрес — находка; пути, идентификаторы и короткие хеши — нет', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg';
    const text = [
      `Логотип: ![logo](data:image/png;base64,${base64})`,
      '',
      'Ключ: `3f786850e387550fdab836ed7e6dc881de23001b4a7cd3b5`',
      '',
      `Токен в примере: ${base64.slice(10, 70)}`,
      '',
      'Путь `packages/core/src/contextControl.test.ts` и коммит `4763647`.',
      '',
      'Имя change — add-context-usefulness-and-token-antipatterns-for-agents.',
      '',
      'Класс `HttpServerRequestHandlerFactoryProviderV2Implementation`.',
    ].join('\n');
    const found = only(text, 'opaque-blob');
    expect(found).toMatchObject({ line: 1, count: 3 });
    expect(found?.sample.startsWith('data:image/png')).toBe(true);
  });

  it('base64 внутри большого блока кода отдельно не считается', () => {
    const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk';
    const text = `\`\`\`\n${Array.from({ length: 40 }, () => `value: ${blob}`).join('\n')}\n\`\`\`\n`;
    expect(kinds(text)).toEqual(['large-code-block']);
  });
});

describe('антипаттерны по токенам: оформление', () => {
  it('псевдографика, эмодзи и разделители — находка; стрелки, тире и заголовок с === — нет', () => {
    const text = [
      'Статус 🚀 ✅ ✅ ❌',
      '',
      '==========',
      '',
      '```',
      '┌────────┐',
      '│ core   │',
      '└────────┘',
      '```',
    ].join('\n');
    const found = only(text, 'decorative-symbols');
    expect(found).toMatchObject({ line: 1, sample: '🚀' });
    expect(found?.count).toBe(4 + 1 + 22);

    const meaningful = ['Заголовок', '==========', '', 'core → server ↔ web — «модуль» ≈ 10 × 2.', '', '---'].join('\n');
    expect(kinds(meaningful)).toEqual([]);
  });

  it('HTML-теги в прозе — находка; шаблоны <папка>, комментарии и HTML в коде — нет', () => {
    const text = [
      '<div align="center"><b>Мастер</b></div>',
      '',
      'Строка<br>перенос, <span style="color:red">важно</span>.',
      '',
      'Путь `openspec/context/modules/<папка>/` и `<div>` в коде, <name> — шаблон.',
      '',
      '<!-- Опишите модуль -->',
      '',
      '```html',
      '<table><tr><td>x</td></tr></table>',
      '```',
    ].join('\n');
    const found = only(text, 'html-markup');
    expect(found).toMatchObject({ line: 1, count: 7, sample: '<div align="center">' });
    expect(kinds('<b>один</b> <i>два</i>')).toEqual([]);
  });

  it('«вода» — от трёх вводных фраз, без учёта регистра и переносов', () => {
    const text = [
      'Обратите внимание, что мастер хранит сессии в памяти.',
      'Следует отметить, что реплика синхронная.',
      '',
      'Как уже было сказано, ответ клиенту — после записи. Please note\nthat the order matters.',
      '',
      '`note that` в коде не считается, слово «вводная» — тоже.',
    ].join('\n');
    const found = only(text, 'filler-phrases');
    expect(found).toMatchObject({ line: 1, count: 4, sample: 'обратите внимание, что' });
    expect(kinds('Обратите внимание на порядок. Другими словами, сначала запись.')).toEqual([]);
  });

  it('капс и «!!» — находка; нормативные слова спек, аббревиатуры и код — нет', () => {
    const text = 'ВНИМАНИЕ!! НИКОГДА не меняйте IMPORTANT файл. ОБЯЗАТЕЛЬНО прочитайте.';
    const found = only(text, 'shouting');
    expect(found).toMatchObject({ line: 1, sample: 'ВНИМАНИЕ' });
    expect(found?.count).toBe(5);

    const normative = [
      'Система ДОЛЖНА (SHALL) отдавать JSON по HTTP; WHEN запрос THEN ответ.',
      'ADDED и MODIFIED Requirements, README и TODO, СУБД и ГОСТ.',
      'Константа `LARGE_FILE_TOKENS` в коде.',
    ].join('\n');
    expect(kinds(normative)).toEqual([]);
  });
});

describe('антипаттерны по токенам: сумма', () => {
  it('экономия файла — сумма находок, но не больше его токенов', () => {
    const found = findTokenAntipatterns('ВНИМАНИЕ!! НИКОГДА!! ОБЯЗАТЕЛЬНО!!');
    expect(found).toHaveLength(1);
    expect(antipatternSavings(found, 1000)).toBe(found[0]?.savings);
    expect(antipatternSavings(found, 2)).toBe(2);
    expect(antipatternSavings([], 100)).toBe(0);
  });

  it('frontmatter не проверяется', () => {
    expect(kinds('---\ntitle: ВНИМАНИЕ НИКОГДА ОБЯЗАТЕЛЬНО\n---\n# Текст\n')).toEqual([]);
  });
});
