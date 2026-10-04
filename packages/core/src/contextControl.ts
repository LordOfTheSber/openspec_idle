/**
 * Контроль контекста: сколько он весит, что в нём лишнее и указывает ли он на
 * то, что действительно есть в проекте.
 *
 * Чистые функции над текстом markdown-файлов. Файловой системы и git здесь
 * нет: сервер читает файлы, проверяет существование путей и историю, а карта
 * контекста складывает из этого замечания.
 */

/** Файл тяжелее этого числа токенов — предупреждение. */
export const LARGE_FILE_TOKENS = 8000;

/** Абзацы короче этого числа символов в поиске повторов не участвуют. */
export const DUPLICATE_MIN_CHARS = 80;

/**
 * Оценка числа токенов текста: символы ASCII (латиница, цифры, пробелы,
 * знаки) — по 4 на токен, прочие (кириллица и т. д.) — по 2,5.
 *
 * 4 — общепринятое правило для английского текста; 2,5 для кириллицы —
 * исходное допущение, сверенное с токенизаторами cl100k, o200k и
 * `@anthropic-ai/tokenizer` на markdown-файлах репозитория (design change
 * `add-context-control`). Модели расходятся между собой до 1,7 раза на одном
 * русском тексте, и ни одна пара коэффициентов не даёт точности лучше ±30 %
 * сразу для всех; эта пара (−32…+34 % по файлу) не хуже других. Поэтому в интерфейсе — «≈», а для
 * точного счёта нужен токенизатор конкретной модели.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 2.5);
}

/** Число строк текста; завершающий перевод строки новой строки не даёт. */
export function countLines(text: string): number {
  if (text === '') return 0;
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

/** Строка тела файла с её номером в файле (с 1). */
interface NumberedLine {
  readonly text: string;
  readonly line: number;
}

/**
 * Строки файла без frontmatter и без блоков кода: в блоке кода — пример, а не
 * утверждение о проекте. Номера строк — как в файле.
 */
function proseLines(text: string): NumberedLine[] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'));
    if (end !== -1) start = end + 1;
  }
  const result: NumberedLine[] = [];
  let fence: string | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0] ?? null;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence === null) result.push({ text: line, line: index + 1 });
  }
  return result;
}

/** Ссылка на путь в тексте контекста. */
export interface MarkdownReference {
  /** Путь, как он записан (без якоря, `@` и номера строки). */
  readonly target: string;
  /** Строка в файле (с 1). */
  readonly line: number;
  /** `link` — `[текст](путь)`, `code` — путь в `` `коде` ``. */
  readonly kind: 'link' | 'code';
}

const RE_LINK = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)/g;
const RE_CODE = /`([^`\n]+)`/g;
const RE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const RE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/** Похоже ли содержимое `` `кода` `` на относительный путь файла или папки. */
function looksLikePath(value: string): boolean {
  if (/\s/.test(value) || !value.includes('/')) return false;
  if (value.startsWith('/') || value.startsWith('~') || RE_SCHEME.test(value)) return false;
  if (/[*?<>{}|$"'()[\]=,;]/.test(value)) return false;
  if (value.endsWith('/')) return value.length > 1;
  return RE_EXTENSION.test(value.split('/').pop() ?? '');
}

/**
 * Пути, на которые ссылается markdown: цели ссылок (кроме внешних адресов и
 * якорей) и пути в `` `коде` `` — со слешем, с расширением файла или `/` на
 * конце. Frontmatter и блоки кода пропускаются.
 */
export function extractReferences(text: string): MarkdownReference[] {
  const found: MarkdownReference[] = [];
  for (const { text: line, line: number } of proseLines(text)) {
    for (const match of line.matchAll(RE_LINK)) {
      let target = match[1] ?? '';
      if (target.startsWith('#') || RE_SCHEME.test(target)) continue;
      target = target.replace(/[#?].*$/, '');
      try {
        target = decodeURI(target);
      } catch {
        // Неправильное %-кодирование — проверяем как записано.
      }
      if (target !== '') found.push({ target, line: number, kind: 'link' });
    }
    // Ссылки уже разобраны — код внутри них второй раз не смотрим.
    const prose = line.replace(RE_LINK, '');
    for (const match of prose.matchAll(RE_CODE)) {
      const target = (match[1] ?? '')
        .trim()
        .replace(/^@/, '')
        .replace(/:\d+(?::\d+)?$/, '');
      if (looksLikePath(target)) found.push({ target, line: number, kind: 'code' });
    }
  }
  return found;
}

/**
 * Приводит путь к виду от корня проекта: `/` вместо `\`, без `.`, `..`
 * разобраны. Путь выше корня — `null`.
 */
export function normalizeProjectPath(path: string): string | null {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? null : parts.join('/');
}

/**
 * Неизменяемая часть пути кода из `code_paths`: до первого сегмента со
 * звёздочкой или многоточием (`src/main/java/**` → `src/main/java`).
 * Абсолютный путь, путь выше корня и шаблон с самого начала — `null`.
 */
export function codePathPrefix(path: string): string | null {
  const posix = path.trim().replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return null;
  const segments = posix.split('/');
  const cut = segments.findIndex((segment) => segment.includes('*') || segment === '...' || segment === '…');
  return normalizeProjectPath((cut === -1 ? segments : segments.slice(0, cut)).join('/'));
}

/**
 * Где может лежать путь из ссылки: от папки файла, от корня проекта и от
 * каждого пути кода модуля. Ссылка с `/` в начале — от корня, как в GitHub.
 */
export function referenceCandidates(
  reference: Pick<MarkdownReference, 'target'>,
  file: string,
  codePaths: readonly string[] = [],
): string[] {
  const target = reference.target.replace(/\\/g, '/');
  if (target.startsWith('/')) {
    const fromRoot = normalizeProjectPath(target);
    return fromRoot === null ? [] : [fromRoot];
  }
  const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const bases = [folder, '', ...codePaths.map(codePathPrefix).filter((prefix): prefix is string => prefix !== null)];
  const candidates = bases
    .map((base) => normalizeProjectPath(base === '' ? target : `${base}/${target}`))
    .filter((candidate): candidate is string => candidate !== null);
  return [...new Set(candidates)];
}

/** Абзац текста для поиска повторов. */
interface Paragraph {
  /** Текст после схлопывания пробелов и приведения к нижнему регистру. */
  readonly key: string;
  /** Исходный текст абзаца. */
  readonly text: string;
  /** Первая строка абзаца в файле (с 1). */
  readonly line: number;
  /** Последняя строка абзаца в файле. */
  readonly end: number;
}

const RE_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** HTML-комментарии `<!-- … -->`; номера строк сохраняются. */
const RE_COMMENT = /<!--[\s\S]*?-->/g;

/** Текст без HTML-комментариев: строки комментария остаются пустыми. */
function withoutComments(text: string): string {
  return text.replace(RE_COMMENT, (comment) => comment.replace(/[^\n]/g, ''));
}

/**
 * Абзацы текста: блоки между пустыми строками, каждый пункт списка — отдельно.
 * Заголовки, frontmatter, блоки кода и HTML-комментарии пропускаются.
 */
function paragraphs(text: string): Paragraph[] {
  const result: Paragraph[] = [];
  let lines: string[] = [];
  let first = 0;
  let last = 0;
  const flush = (): void => {
    if (lines.length === 0) return;
    const original = lines.join('\n').trim();
    const key = lines
      .map((line) => line.replace(RE_LIST_ITEM, '').replace(/^\s*>\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    result.push({ key, text: original, line: first, end: last });
    lines = [];
  };
  let previous = 0;
  for (const { text: line, line: number } of proseLines(withoutComments(text))) {
    // Пропущенный блок кода разрывает абзац.
    if (number !== previous + 1) flush();
    previous = number;
    if (line.trim() === '' || /^\s*#{1,6}\s/.test(line)) {
      flush();
      continue;
    }
    if (RE_LIST_ITEM.test(line)) flush();
    if (lines.length === 0) first = number;
    last = number;
    lines.push(line);
  }
  flush();
  return result;
}

/** Место в файле. */
export interface TextLocation {
  readonly path: string;
  readonly line: number;
}

/** Абзац, который встречается в контексте больше одного раза. */
export interface ContextDuplicate {
  /** Начало абзаца для показа. */
  readonly excerpt: string;
  /** Оценка токенов одного вхождения. */
  readonly tokens: number;
  /** Вхождения в порядке файлов; первое — исходное. */
  readonly occurrences: readonly TextLocation[];
}

const EXCERPT_CHARS = 120;

/**
 * Повторяющиеся абзацы от {@link DUPLICATE_MIN_CHARS} символов. Сравнение —
 * без учёта пробелов и регистра; файлы просматриваются в переданном порядке,
 * поэтому первое вхождение — в файле, который в наборе раньше.
 */
export function findDuplicates(files: readonly { readonly path: string; readonly text: string }[]): ContextDuplicate[] {
  const groups = new Map<string, { text: string; occurrences: TextLocation[] }>();
  for (const file of files) {
    for (const paragraph of paragraphs(file.text)) {
      if (paragraph.key.length < DUPLICATE_MIN_CHARS) continue;
      const group = groups.get(paragraph.key);
      if (group === undefined) groups.set(paragraph.key, { text: paragraph.text, occurrences: [{ path: file.path, line: paragraph.line }] });
      else group.occurrences.push({ path: file.path, line: paragraph.line });
    }
  }
  return [...groups.values()]
    .filter((group) => group.occurrences.length > 1)
    .map((group) => {
      const flat = group.text.replace(/\s+/g, ' ');
      return {
        excerpt: flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat,
        tokens: estimateTokens(group.text),
        occurrences: group.occurrences,
      };
    });
}

/** В файле контекста нет ничего, кроме frontmatter, заголовков и комментариев. */
export function isEmptyContext(text: string): boolean {
  const body = proseLines(withoutComments(text))
    .map(({ text: line }) => line.trim())
    .filter((line) => line !== '' && !/^#{1,6}(\s|$)/.test(line));
  return body.length === 0 && !/^\s*(`{3,}|~{3,})/m.test(text);
}

/** Полезная доля ниже этой — сведение о низкой полезности файла. */
export const LOW_USEFULNESS = 0.5;

/** Файлы легче этого числа токенов сведением о полезности не отмечаются. */
export const USEFULNESS_MIN_TOKENS = 200;

/** Отставание контекста от кода в коммитах, при котором множитель свежести — 0,5. */
export const STALE_HALF_COMMITS = 10;

/** Токены, которые занимают место в файле без пользы, — по причинам. */
export interface ContextBallast {
  /** Абзацы, повторяющие более раннее вхождение. */
  readonly duplicate: number;
  /** Заготовки: HTML-комментарии, `TODO`, «заполнить», одни `<…>` или `…`. */
  readonly placeholder: number;
  /** Абзацы со ссылкой на путь, которого нет. */
  readonly broken: number;
  /** Весь файл, если в нём нет ничего, кроме заголовков. */
  readonly empty: number;
}

/**
 * Оценка полезности файла контекста — эвристика, а не измерение: сколько
 * токенов не балласт, насколько текст привязан к коду и не отстал ли от него.
 */
export interface ContextUsefulness {
  /** Оценка токенов файла. */
  readonly tokens: number;
  readonly ballast: ContextBallast;
  /** Плотность: доля токенов без балласта, 0…1. */
  readonly density: number;
  /**
   * Привязка: доля токенов содержательных абзацев, где есть `` `код` `` или
   * ссылка, 0…1; `null` — для файла не оценивается.
   */
  readonly grounding: number | null;
  /** Множитель свежести, 0…1; `null` — не оценивается или нет данных git. */
  readonly freshness: number | null;
  /** Коэффициент полезности: плотность × (0,5 + 0,5 × привязка) × свежесть. */
  readonly score: number;
  /** Полезные токены: коэффициент × токены, с округлением. */
  readonly usefulTokens: number;
}

/** Что известно о файле помимо текста. */
export interface UsefulnessOptions {
  /** Строки, с которых начинаются абзацы-повторы ({@link findDuplicates}). */
  readonly duplicateLines?: ReadonlySet<number>;
  /** Строки ссылок на пути, которых нет. */
  readonly brokenLines?: ReadonlySet<number>;
  /** Оценивать привязку к коду — для `context.md` модуля. */
  readonly grounding?: boolean;
  /** Коммитов в коде после правки контекста; не задано — свежесть не оценивается. */
  readonly commitsAfter?: number | null;
}

const RE_PLACEHOLDER_START = /^(?:todo|tbd|fixme|xxx|заполнить|дописать|описать позже|будет (?:добавлено|описано|заполнено))(?![\p{L}\p{N}])/u;
const RE_ANCHOR = /`[^`\n]+`|\]\([^)\s]+\)/;

/**
 * Абзац — заготовка: начинается с `TODO` и т. п. или состоит из одних `<…>` и
 * многоточий. Черта `---` заготовкой не считается.
 */
function isPlaceholder(key: string): boolean {
  if (RE_PLACEHOLDER_START.test(key)) return true;
  const marked = /<[^<>\n]*>|\.\.\.|…/.test(key);
  return marked && key.replace(/<[^<>\n]*>/g, '').replace(/[\s.…:;,—-]/g, '') === '';
}

/**
 * Коэффициент полезности файла контекста. Балласт — повторы, заготовки и
 * абзацы с битыми путями (абзац считается один раз, в этом порядке);
 * пустой файл — балласт целиком. Привязка смягчена: текст без путей тоже
 * бывает нужен, поэтому она снижает коэффициент не больше чем вдвое.
 */
export function measureUsefulness(text: string, options: UsefulnessOptions = {}): ContextUsefulness {
  const tokens = estimateTokens(text);
  const freshness =
    options.commitsAfter === undefined || options.commitsAfter === null
      ? null
      : 1 / (1 + Math.max(0, options.commitsAfter) / STALE_HALF_COMMITS);
  if (tokens === 0 || isEmptyContext(text)) {
    return {
      tokens,
      ballast: { duplicate: 0, placeholder: 0, broken: 0, empty: tokens },
      density: 0,
      grounding: options.grounding === true ? 0 : null,
      freshness,
      score: 0,
      usefulTokens: 0,
    };
  }

  const duplicateLines = options.duplicateLines ?? new Set<number>();
  const brokenLines = [...(options.brokenLines ?? [])];
  let duplicate = 0;
  let placeholder = 0;
  let broken = 0;
  for (const comment of text.match(RE_COMMENT) ?? []) placeholder += estimateTokens(comment);
  let content = 0;
  let anchored = 0;
  for (const paragraph of paragraphs(text)) {
    const size = estimateTokens(paragraph.text);
    if (duplicateLines.has(paragraph.line)) duplicate += size;
    else if (isPlaceholder(paragraph.key)) placeholder += size;
    else if (brokenLines.some((line) => line >= paragraph.line && line <= paragraph.end)) broken += size;
    else {
      content += size;
      if (RE_ANCHOR.test(paragraph.text)) anchored += size;
    }
  }

  const waste = Math.min(tokens, duplicate + placeholder + broken);
  const density = (tokens - waste) / tokens;
  const grounding = options.grounding === true ? (content === 0 ? 0 : anchored / content) : null;
  const score = density * (grounding === null ? 1 : 0.5 + 0.5 * grounding) * (freshness ?? 1);
  return {
    tokens,
    ballast: { duplicate, placeholder, broken, empty: 0 },
    density,
    grounding,
    freshness,
    score,
    usefulTokens: Math.round(score * tokens),
  };
}

/** Статусы ADR, при которых решение больше не действует. */
const INACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'superseded',
  'deprecated',
  'rejected',
  'obsolete',
  'withdrawn',
  'заменён',
  'заменен',
  'заменено',
  'отменён',
  'отменен',
  'отменено',
  'отклонён',
  'отклонен',
  'отклонено',
  'устарел',
  'устарело',
]);

/**
 * Действует ли решение со статусом ADR. Смотрится первое слово:
 * `superseded by ADR-007` — не действует. Без статуса — действует.
 */
export function isActiveAdrStatus(status: string | null): boolean {
  if (status === null) return true;
  const word = status.trim().toLowerCase().split(/[\s:,;(]/)[0] ?? '';
  return !INACTIVE_STATUSES.has(word);
}
