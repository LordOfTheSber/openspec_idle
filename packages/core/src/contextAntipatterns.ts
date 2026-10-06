/**
 * Антипаттерны контекста по токенам: то, за что агент платит токенами, не
 * получая взамен смысла, — текст не на английском, вставленные копии кода,
 * base64 и хеши, псевдографика и эмодзи, HTML-разметка, «вода» и капс.
 *
 * Чистые функции над текстом markdown-файла. Каждая находка несёт оценку
 * токенов, которые можно сэкономить, — той же эвристикой, что и объём
 * ({@link estimateTokens}), поэтому со знаком «≈».
 */

import { estimateTokens } from './contextControl.js';
import { textCache } from './textCache.js';

export type TokenAntipatternKind =
  | 'non-english-text'
  | 'large-code-block'
  | 'opaque-blob'
  | 'decorative-symbols'
  | 'html-markup'
  | 'filler-phrases'
  | 'shouting';

/** Находка в файле контекста. */
export interface TokenAntipattern {
  readonly kind: TokenAntipatternKind;
  /** Первая строка находки (с 1); `null` — весь файл. */
  readonly line: number | null;
  /** Сколько раз встретилось: символов, тегов, фраз, слов; у блока кода — строк. */
  readonly count: number;
  /** Оценка токенов, которые уйдут, если исправить. */
  readonly savings: number;
  /** Пример для сообщения: фраза, слово, тег; у текста не на английском — письменность. */
  readonly sample: string;
  /** Доля букв не латиницей, 0…1, — только у `non-english-text`. */
  readonly share?: number;
}

/** Файлы легче этого числа токенов на язык не проверяются. */
export const NON_ENGLISH_MIN_TOKENS = 200;

/** Доля букв не латиницей, начиная с которой файл считается написанным не на английском. */
export const NON_ENGLISH_SHARE = 0.3;

/** Блок кода тяжелее этого числа токенов — копия, а не пример. */
export const LARGE_CODE_BLOCK_TOKENS = 500;

/** Непрерывная строка base64 или hex от этой длины — непрозрачные данные. */
export const OPAQUE_BLOB_CHARS = 40;

/** Порог декоративных символов: столько токенов и больше. */
export const DECORATIVE_MIN_TOKENS = 10;

/** Порог HTML-тегов вне блоков кода. */
export const HTML_MIN_TAGS = 5;

/** Порог фраз-«воды». */
export const FILLER_MIN_PHRASES = 3;

/** Порог слов капсом и `!!`. */
export const SHOUTING_MIN_WORDS = 3;

/** Строка файла и где она лежит. */
interface ScannedLine {
  readonly text: string;
  /** Номер строки в файле (с 1). */
  readonly line: number;
  /** `fence` — строка ```` ``` ````, `code` — внутри блока кода. */
  readonly zone: 'frontmatter' | 'prose' | 'fence' | 'code';
}

/** Блок кода: строка открывающей ```` ``` ```` и строки внутри. */
interface CodeBlock {
  readonly line: number;
  /** Язык после ```` ``` ````, если указан. */
  readonly info: string;
  readonly lines: readonly ScannedLine[];
}

function scan(text: string): { lines: ScannedLine[]; blocks: CodeBlock[] } {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const raw = source.split(/\r?\n/);
  let frontmatterEnd = -1;
  if (raw[0]?.trim() === '---') {
    frontmatterEnd = raw.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'));
  }
  const lines: ScannedLine[] = [];
  const blocks: CodeBlock[] = [];
  let fence: string | null = null;
  let block: { line: number; info: string; lines: ScannedLine[] } | null = null;
  raw.forEach((text, index) => {
    const line = index + 1;
    if (index <= frontmatterEnd) {
      lines.push({ text, line, zone: 'frontmatter' });
      return;
    }
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker !== undefined && (fence === null || marker[0] === fence)) {
      if (fence === null) {
        fence = marker[0] ?? null;
        block = { line, info: /^\s*(?:`{3,}|~{3,})\s*([\w+#.-]*)/.exec(text)?.[1] ?? '', lines: [] };
      } else {
        fence = null;
        if (block !== null) blocks.push(block);
        block = null;
      }
      lines.push({ text, line, zone: 'fence' });
      return;
    }
    const scanned: ScannedLine = { text, line, zone: fence === null ? 'prose' : 'code' };
    lines.push(scanned);
    block?.lines.push(scanned);
  });
  // Незакрытый блок кода тянется до конца файла.
  if (block !== null) blocks.push(block);
  return { lines, blocks };
}

/** Строка прозы без `` `кода` `` и HTML-комментариев — что видит читатель как текст. */
function plainProse(line: string): string {
  return line.replace(/`[^`\n]*`/g, ' ').replace(/<!--.*?-->/g, ' ');
}

const RE_LETTER = /\p{L}/gu;
const RE_LATIN = /\p{Script=Latin}/u;
const RE_CYRILLIC = /\p{Script=Cyrillic}/u;

/**
 * Текст не на английском: доля букв не латиницей от {@link NON_ENGLISH_SHARE}
 * в файле от {@link NON_ENGLISH_MIN_TOKENS} токенов. Экономия — разница оценок
 * тех же букв как латиницы (4 на токен) и как прочих символов (2,5 на токен):
 * перевод на английский даёт текст примерно той же длины в символах.
 */
function nonEnglish(text: string): TokenAntipattern | null {
  if (estimateTokens(text) < NON_ENGLISH_MIN_TOKENS) return null;
  let letters = 0;
  let foreign = 0;
  let cyrillic = 0;
  for (const [letter] of text.matchAll(RE_LETTER)) {
    letters += 1;
    if (RE_LATIN.test(letter)) continue;
    foreign += 1;
    if (RE_CYRILLIC.test(letter)) cyrillic += 1;
  }
  if (letters === 0 || foreign / letters < NON_ENGLISH_SHARE) return null;
  return {
    kind: 'non-english-text',
    line: null,
    count: foreign,
    savings: Math.round(foreign / 2.5 - foreign / 4),
    sample: cyrillic * 2 >= foreign ? 'кириллица' : 'не латиница',
    share: foreign / letters,
  };
}

/** Блоки кода от {@link LARGE_CODE_BLOCK_TOKENS} токенов — каждый отдельно. */
function largeCodeBlocks(blocks: readonly CodeBlock[]): TokenAntipattern[] {
  return blocks.flatMap((block) => {
    const tokens = estimateTokens(block.lines.map((line) => line.text).join('\n'));
    if (tokens < LARGE_CODE_BLOCK_TOKENS) return [];
    return [{ kind: 'large-code-block' as const, line: block.line, count: block.lines.length, savings: tokens, sample: block.info }];
  });
}

const RE_DATA_URI = /data:[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*;base64,[A-Za-z0-9+/=]+/g;
const RE_TOKEN_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${OPAQUE_BLOB_CHARS},}`, 'g');

/**
 * Похожа ли непрерывная строка на base64 или hex: hex — только `0-9a-f` с
 * цифрами и буквами; base64 — заглавные, строчные и цифры вперемешку.
 * Пути (`/` между словами) и идентификаторы через `-`/`_` не подходят.
 */
function isBlob(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) return /\d/.test(run) && /[a-f]/i.test(run);
  const digits = run.match(/\d/g)?.length ?? 0;
  const upper = run.match(/[A-Z]/g)?.length ?? 0;
  const lower = run.match(/[a-z]/g)?.length ?? 0;
  if (digits < 1 || upper < 3 || lower < 3) return false;
  // Слова в пути или идентификаторе (`HandlerFactory`) дают участки строчных букв, base64 — почти нет.
  return run.split(/[^a-z]+/).filter((part) => part.length >= 4).length <= 1;
}

/** base64, hex, data:-адреса — в прозе и в блоках кода, кроме больших блоков. */
function opaqueBlobs(lines: readonly ScannedLine[], skip: ReadonlySet<number>): TokenAntipattern | null {
  let count = 0;
  let savings = 0;
  let first: number | null = null;
  let sample = '';
  for (const { text, line, zone } of lines) {
    if (zone === 'frontmatter' || zone === 'fence' || skip.has(line)) continue;
    const found: string[] = [];
    const rest = text.replace(RE_DATA_URI, (uri) => {
      found.push(uri);
      return ' ';
    });
    for (const [run] of rest.matchAll(RE_TOKEN_RUN)) if (isBlob(run)) found.push(run);
    for (const blob of found) {
      count += 1;
      savings += estimateTokens(blob);
      if (first === null) {
        first = line;
        sample = blob.length > 24 ? `${blob.slice(0, 20)}…` : blob;
      }
    }
  }
  return count === 0 ? null : { kind: 'opaque-blob', line: first, count, savings, sample };
}

/**
 * Декоративный символ: эмодзи и пиктограммы, рамки и блоки псевдографики,
 * геометрические фигуры-маркеры. Стрелки, математика и типографика (→, ≈, —,
 * «») несут смысл и не считаются.
 */
function isDecorative(codePoint: number, char: string): boolean {
  if (codePoint >= 0x2190 && codePoint <= 0x21ff) return false;
  if (codePoint >= 0x2500 && codePoint <= 0x25ff) return true;
  return codePoint >= 0x2300 && /\p{Extended_Pictographic}/u.test(char);
}

/** Строка-разделитель из одного повторяющегося символа: `=====`, `*****`. */
const RE_SEPARATOR = /^\s*([=*_~#+-])\1{4,}\s*$/;

/**
 * Эмодзи, псевдографика и строки-разделители. Каждый такой символ — минимум
 * один токен: в UTF-8 это 3–4 байта, которые токенизатор почти не склеивает.
 * Строка `=====` под строкой текста — заголовок markdown, а не разделитель.
 */
function decorative(lines: readonly ScannedLine[], skip: ReadonlySet<number>): TokenAntipattern | null {
  let count = 0;
  let savings = 0;
  let first: number | null = null;
  let sample = '';
  let previous = '';
  for (const { text, line, zone } of lines) {
    const above = previous;
    previous = text;
    if (zone === 'frontmatter' || zone === 'fence' || skip.has(line)) continue;
    let found = 0;
    if (zone === 'prose' && RE_SEPARATOR.test(text) && !(above.trim() !== '' && /^\s*[=-]/.test(text))) {
      found += 1;
      savings += estimateTokens(text.trim());
      if (sample === '') sample = text.trim().slice(0, 12);
    } else {
      for (const char of text) {
        const codePoint = char.codePointAt(0) ?? 0;
        if (!isDecorative(codePoint, char)) continue;
        found += 1;
        savings += 1;
        if (sample === '') sample = char;
      }
    }
    if (found > 0) {
      count += found;
      first ??= line;
    }
  }
  return savings < DECORATIVE_MIN_TOKENS ? null : { kind: 'decorative-symbols', line: first, count, savings, sample };
}

const HTML_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl',
  'dt', 'em', 'figure', 'figcaption', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
  'ol', 'p', 'picture', 'pre', 's', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

const RE_TAG = /<\/?([A-Za-z][A-Za-z0-9]*)(?:\s[^<>]*)?\/?>/g;

/**
 * HTML-теги в прозе: то же в markdown короче, а атрибуты и стили агенту не
 * нужны. Комментарии — заготовки, их считает полезность; `<папка>`, `<name>`
 * — шаблоны, не теги.
 */
function htmlMarkup(lines: readonly ScannedLine[]): TokenAntipattern | null {
  let count = 0;
  let savings = 0;
  let first: number | null = null;
  let sample = '';
  for (const { text, line, zone } of lines) {
    if (zone !== 'prose') continue;
    for (const match of plainProse(text).matchAll(RE_TAG)) {
      if (!HTML_TAGS.has((match[1] ?? '').toLowerCase())) continue;
      count += 1;
      savings += estimateTokens(match[0]);
      first ??= line;
      if (sample === '') sample = match[0].length > 30 ? `${match[0].slice(0, 28)}…>` : match[0];
    }
  }
  return count < HTML_MIN_TAGS ? null : { kind: 'html-markup', line: first, count, savings, sample };
}

/**
 * Фразы, которые не добавляют смысла: агент прочитает утверждение и без
 * «обратите внимание», а «как сказано выше» отсылает к тому, что уже в
 * контексте. Сравнение — без учёта регистра, по границам слов.
 */
const FILLER_PHRASES = [
  'обратите внимание, что',
  'обратите внимание',
  'следует отметить, что',
  'следует отметить',
  'стоит отметить, что',
  'стоит отметить',
  'важно отметить, что',
  'важно отметить',
  'необходимо отметить, что',
  'необходимо отметить',
  'важно понимать, что',
  'нужно понимать, что',
  'стоит понимать, что',
  'как уже было сказано',
  'как было сказано выше',
  'как уже говорилось',
  'как говорилось выше',
  'как упоминалось выше',
  'как упоминалось ранее',
  'как отмечалось выше',
  'как известно',
  'на сегодняшний день',
  'в настоящий момент времени',
  'по большому счёту',
  'по большому счету',
  'в принципе',
  'так или иначе',
  'другими словами',
  'иными словами',
  'please note that',
  'please note',
  'it is important to note that',
  'it is worth noting that',
  "it's worth noting that",
  'it should be noted that',
  'note that',
  'as mentioned above',
  'as mentioned earlier',
  'as mentioned before',
  'as noted above',
  'as previously mentioned',
  'as stated above',
  'needless to say',
  'at this point in time',
  'due to the fact that',
  'for all intents and purposes',
  'in other words',
  'basically',
  'essentially',
];

const RE_FILLER = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...FILLER_PHRASES]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
    .join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

/** «Вода»: вводные фразы, которые можно удалить без потери смысла. */
function fillerPhrases(lines: readonly ScannedLine[]): TokenAntipattern | null {
  let count = 0;
  let savings = 0;
  let first: number | null = null;
  let sample = '';
  for (const { text, line, zone } of lines) {
    if (zone !== 'prose') continue;
    for (const [phrase] of plainProse(text).matchAll(RE_FILLER)) {
      count += 1;
      savings += estimateTokens(`${phrase} `);
      first ??= line;
      if (sample === '') sample = phrase.toLowerCase();
    }
  }
  return count < FILLER_MIN_PHRASES ? null : { kind: 'filler-phrases', line: first, count, savings, sample };
}

/**
 * Слова капсом, которые не аббревиатуры: нормативные слова спек (SHALL,
 * ДОЛЖЕН, WHEN/THEN) и имена файлов вроде README — часть формата.
 */
const CAPS_ALLOWED = new Set([
  'SHALL', 'SHOULD', 'MUST', 'REQUIRED', 'OPTIONAL', 'RECOMMENDED', 'GIVEN', 'WHEN', 'THEN', 'ADDED', 'MODIFIED', 'REMOVED',
  'RENAMED', 'README', 'CHANGELOG', 'LICENSE', 'CONTRIBUTING', 'CODEOWNERS', 'TODO', 'FIXME',
  'ДОЛЖЕН', 'ДОЛЖНА', 'ДОЛЖНО', 'ДОЛЖНЫ', 'МОЖЕТ', 'МОГУТ', 'СЛЕДУЕТ', 'НУЖНО', 'ЕСЛИ', 'ТОГДА', 'КОГДА',
]);

/** Слово капсом: латиница от 6 букв, кириллица от 5 — короче обычно аббревиатуры. */
const RE_CAPS = /(?<![\p{L}\p{N}_])(?:[A-Z]{6,}|[А-ЯЁ]{5,})(?![\p{L}\p{N}_])/gu;

/**
 * Капс и `!!`: заглавные буквы токенизатор дробит примерно вдвое мельче
 * строчных, а новые модели на «крик» реагируют чрезмерно. Экономия — половина
 * оценки слова и лишние восклицательные знаки.
 */
function shouting(lines: readonly ScannedLine[]): TokenAntipattern | null {
  let count = 0;
  let savings = 0;
  let first: number | null = null;
  let sample = '';
  for (const { text, line, zone } of lines) {
    if (zone !== 'prose') continue;
    const prose = plainProse(text);
    let found = 0;
    for (const [word] of prose.matchAll(RE_CAPS)) {
      if (CAPS_ALLOWED.has(word)) continue;
      found += 1;
      savings += Math.max(1, Math.round(estimateTokens(word) / 2));
      if (sample === '') sample = word;
    }
    for (const [marks] of prose.matchAll(/!{2,}/g)) {
      found += 1;
      savings += 1;
      if (sample === '') sample = marks;
    }
    if (found > 0) {
      count += found;
      first ??= line;
    }
  }
  return count < SHOUTING_MIN_WORDS ? null : { kind: 'shouting', line: first, count, savings, sample };
}

/**
 * Антипаттерны по токенам в тексте файла контекста: язык — на весь файл,
 * большие блоки кода — каждый, остальное — одной находкой со строкой первого
 * вхождения. Большой блок кода целиком считается одной находкой: base64 и
 * псевдографика в нём отдельно не считаются.
 */
export function findTokenAntipatterns(text: string): readonly TokenAntipattern[] {
  return textCache.get(text, 'antipatterns', () => scanAntipatterns(text));
}

function scanAntipatterns(text: string): TokenAntipattern[] {
  const { lines, blocks } = scan(text);
  const large = largeCodeBlocks(blocks);
  const inLarge = new Set<number>();
  for (const block of blocks) {
    if (large.some((found) => found.line === block.line)) for (const line of block.lines) inLarge.add(line.line);
  }
  return [
    nonEnglish(text),
    ...large,
    opaqueBlobs(lines, inLarge),
    decorative(lines, inLarge),
    htmlMarkup(lines),
    fillerPhrases(lines),
    shouting(lines),
  ].filter((found): found is TokenAntipattern => found !== null);
}

/** Сумма экономии по находкам файла — не больше его токенов. */
export function antipatternSavings(antipatterns: readonly TokenAntipattern[], tokens: number): number {
  return Math.min(
    tokens,
    antipatterns.reduce((sum, found) => sum + found.savings, 0),
  );
}

/** Слово при числе: `plural(3, ['тег', 'тега', 'тегов'])` → `3 тега`. */
function plural(count: number, forms: readonly [string, string, string]): string {
  const tens = count % 100;
  const ones = count % 10;
  const form = tens >= 11 && tens <= 14 ? forms[2] : ones === 1 ? forms[0] : ones >= 2 && ones <= 4 ? forms[1] : forms[2];
  return `${count} ${form}`;
}

/** Короткое имя находки — для чипов и сводок. */
export const ANTIPATTERN_LABELS: Readonly<Record<TokenAntipatternKind, string>> = {
  'non-english-text': 'не английский',
  'large-code-block': 'блок кода',
  'opaque-blob': 'base64 и хеши',
  'decorative-symbols': 'псевдографика',
  'html-markup': 'HTML',
  'filler-phrases': 'вода',
  shouting: 'капс',
};

/** Текст замечания о находке; `tokens` — оценка токенов всего файла. */
export function antipatternMessage(found: TokenAntipattern, tokens: number): string {
  const save = `≈ ${found.savings}`;
  switch (found.kind) {
    case 'non-english-text':
      return (
        `Текст не на английском (${found.sample} — ${Math.round((found.share ?? 0) * 100)} % букв): на английском тот же файл ` +
        `занял бы на ${save} токенов меньше из ≈ ${tokens}. Разница зависит от токенизатора модели; для контекста агента ` +
        'выгоднее английский'
      );
    case 'large-code-block':
      return (
        `Блок кода${found.sample === '' ? '' : ` ${found.sample}`} на ${plural(found.count, ['строку', 'строки', 'строк'])} ${save} токенов: ` +
        'копия кода, логов или вывода устаревает и занимает место — сошлитесь на файл и строки или оставьте короткий фрагмент'
      );
    case 'opaque-blob':
      return (
        `Непрозрачные данные — base64, хеши, data:-адреса (${found.count}, ${save} токенов, первое — ${found.sample}): ` +
        'агенту они ничего не говорят, а токенов стоят много — уберите или сошлитесь на файл'
      );
    case 'decorative-symbols':
      return (
        `Эмодзи, псевдографика и строки-разделители: ${plural(found.count, ['символ', 'символа', 'символов'])} ${save} токенов ` +
        `(первый — ${found.sample}): каждый такой символ стоит токен и не несёт смысла — рамки замените списком, эмодзи словами`
      );
    case 'html-markup':
      return (
        `HTML-разметка: ${plural(found.count, ['тег', 'тега', 'тегов'])} ${save} токенов (первый — ${found.sample}): ` +
        'в markdown то же короче, а атрибуты и стили агенту не нужны'
      );
    case 'filler-phrases':
      return (
        `«Вода»: ${plural(found.count, ['вводная фраза', 'вводные фразы', 'вводных фраз'])} ${save} токенов ` +
        `(например, «${found.sample}»): утверждение работает и без них — удалите`
      );
    case 'shouting':
      return (
        `Капс и «!!»: ${plural(found.count, ['слово', 'слова', 'слов'])} — ${save} токенов лишних (например, ${found.sample}): ` +
        'заглавные буквы дробятся на токены мельче, а современные модели на «крик» реагируют чрезмерно — пишите обычным регистром'
      );
  }
}
