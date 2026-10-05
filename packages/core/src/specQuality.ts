/**
 * Проверка качества спеков: детерминированный линтер поверх формата OpenSpec.
 *
 * `openspec validate` проверяет форму — разделы, SHALL, сценарии с WHEN/THEN.
 * Здесь проверяется содержание: согласованы ли коды ошибок текста и
 * сценариев, покрыты ли сценариями условия, перечисления и границы, нет ли в
 * WHEN/THEN деталей реализации и расплывчатых слов. Только регулярные
 * выражения и разбор markdown — без LLM, поэтому одно и то же место даёт одно
 * и то же замечание в редакторе и в CI.
 *
 * Слова сравниваются по общему началу (`wordsMatch`): «кэш» и «кэша»,
 * «создание» и «создаётся» — одно слово. Это грубая замена морфологии, поэтому
 * правила, которые на неё опираются, по умолчанию — сведения.
 *
 * Строки — с 1.
 */
import type { AuthoringSources } from './authoring.js';
import type { DeltaOperation } from './specMarkdown.js';
import { fenceMask } from './specChange.js';
import { artifactRuleIssues, scenarioConsistency } from './specConsistency.js';

// ---------------------------------------------------------------------------
// Правила и настройки

/** Правило проверки качества. */
export type QualityRule =
  | 'error-code-trace'
  | 'branch-coverage'
  | 'enumeration-coverage'
  | 'boundary-values'
  | 'clamp-arithmetic'
  | 'implementation-leak'
  | 'parameter-registry'
  | 'actor-dictionary'
  | 'vague-wording'
  | 'observable-then'
  | 'negative-scenarios'
  | 'atomicity'
  | 'purpose-coverage'
  | 'error-code-registry'
  | 'metric-threshold'
  | 'error-order'
  | 'scenario-conflict'
  | 'scenario-overlap'
  | 'scenario-duplicate'
  | 'artifact-rule'
  | 'plan-test-ref'
  | 'code-message'
  | 'code-constant'
  | 'metric-regression';

export type QualityLevel = 'error' | 'warning' | 'info';

/** Правила в порядке описания и их уровни по умолчанию. */
export const QUALITY_RULES: Readonly<Record<QualityRule, QualityLevel>> = {
  'error-code-trace': 'warning',
  'branch-coverage': 'info',
  'enumeration-coverage': 'warning',
  'boundary-values': 'warning',
  'clamp-arithmetic': 'warning',
  'implementation-leak': 'warning',
  'parameter-registry': 'warning',
  'actor-dictionary': 'warning',
  'vague-wording': 'warning',
  'observable-then': 'warning',
  'negative-scenarios': 'warning',
  'atomicity': 'info',
  'purpose-coverage': 'info',
  'error-code-registry': 'warning',
  'metric-threshold': 'error',
  'error-order': 'warning',
  'scenario-conflict': 'warning',
  'scenario-overlap': 'info',
  'scenario-duplicate': 'info',
  'artifact-rule': 'warning',
  'plan-test-ref': 'warning',
  'code-message': 'warning',
  'code-constant': 'info',
  'metric-regression': 'error',
};

/** Сводная метрика качества. */
export type QualityMetric = 'errorCodeTraceability' | 'branchCoverage' | 'boundaryCoverage' | 'ambiguityDensity';

export const QUALITY_METRICS: readonly QualityMetric[] = [
  'errorCodeTraceability',
  'branchCoverage',
  'boundaryCoverage',
  'ambiguityDensity',
];

/** Порог метрики: доли — не ниже, плотность расплывчатых слов — не выше. */
export interface QualityThreshold {
  readonly metric: QualityMetric;
  readonly value: number;
  /** Строка порога в файле настроек. */
  readonly line: number | null;
}

/** Код из реестра кодов ошибок — файла с enum или списком кодов. */
export interface RegistryCode {
  readonly code: string;
  readonly line: number;
}

/** Файл реестра кодов ошибок и найденные в нём коды. */
export interface RegistryFile {
  readonly path: string;
  readonly codes: readonly RegistryCode[];
}

/**
 * Исполняемое правило артефактов change: каждый файл, раздел или пункт плана
 * артефакта должен содержать (`require`) или не содержать (`forbid`) шаблон.
 */
export interface ArtifactRule {
  readonly id: string;
  /** Идентификатор артефакта схемы: `proposal`, `design`, `tasks`, `specs`… */
  readonly artifact: string;
  /** Что проверяется: файл целиком, раздел под заголовком или пункт плана с продолжением. */
  readonly each: 'file' | 'section' | 'item';
  /** Заголовки, которые начинают раздел; по умолчанию `^#{2,3}\s`. */
  readonly heading: string | null;
  readonly require: string | null;
  readonly forbid: string | null;
  readonly message: string;
  /** Уровень правила; без него — уровень `artifact-rule`. */
  readonly level: QualityLevel | null;
  /** Строка правила в файле настроек. */
  readonly line: number | null;
}

/** Ошибка в файле настроек. */
export interface QualityConfigError {
  readonly line: number | null;
  readonly message: string;
}

/**
 * Настройки проверки — `openspec/quality.yaml`. Без файла действуют
 * умолчания, а правила, которым нужен словарь (акторы, реестр кодов), молчат.
 */
export interface QualityConfig {
  /** Путь файла настроек от корня; `null` — файла нет. */
  readonly path: string | null;
  /** `all` — основные спеки и дельты; `changes` — только дельты активных changes. */
  readonly scope: 'all' | 'changes';
  /** Уровни правил; `off` выключает правило. */
  readonly levels: Readonly<Partial<Record<QualityRule, QualityLevel | 'off'>>>;
  /** Регулярное выражение кода ошибки; `null` — UPPER_SNAKE хотя бы с одним `_`. */
  readonly errorCodePattern: string | null;
  /** Словарь акторов — допустимых подлежащих при SHALL. */
  readonly actors: readonly string[];
  /** Термины и поля DTO, которые можно упоминать в спеке. */
  readonly glossary: readonly string[];
  /** Параметры конфигурации; значение (если задано) нужно проверке арифметики. */
  readonly parameters: Readonly<Record<string, number | null>>;
  readonly vagueWords: { readonly add: readonly string[]; readonly ignore: readonly string[] };
  readonly internalTerms: { readonly add: readonly string[]; readonly ignore: readonly string[] };
  /** Реестр кодов ошибок; `null` — не задан. */
  readonly registry: readonly RegistryFile[] | null;
  readonly thresholds: readonly QualityThreshold[];
  /** Исполняемые правила артефактов changes. */
  readonly artifactRules: readonly ArtifactRule[];
  /** Ошибки разбора файла настроек. */
  readonly errors: readonly QualityConfigError[];
}

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  path: null,
  scope: 'all',
  levels: {},
  errorCodePattern: null,
  actors: [],
  glossary: [],
  parameters: {},
  vagueWords: { add: [], ignore: [] },
  internalTerms: { add: [], ignore: [] },
  registry: null,
  thresholds: [],
  artifactRules: [],
  errors: [],
};

// ---------------------------------------------------------------------------
// Результат

/** Замечание о качестве спека. */
export interface QualityIssue {
  readonly path: string;
  readonly line: number;
  readonly level: QualityLevel;
  readonly rule: QualityRule | 'config';
  readonly message: string;
}

/** Счётчики, из которых складываются метрики. */
export interface QualityCounts {
  /** Коды и в тексте, и в THEN / все коды требования (без входных значений WHEN). */
  readonly codesTraced: number;
  readonly codesTotal: number;
  readonly branchesCovered: number;
  readonly branchesTotal: number;
  readonly boundariesCovered: number;
  readonly boundariesTotal: number;
  /** Слова требований и сценариев и расплывчатые среди них. */
  readonly words: number;
  readonly vague: number;
}

/** Значения метрик; `null` — считать не по чему. */
export type QualityMetrics = Readonly<Record<QualityMetric, number | null>>;

export interface QualityFileReport {
  readonly path: string;
  readonly capability: string;
  /** Change дельты; `null` — основной спек. */
  readonly change: string | null;
  readonly requirements: number;
  readonly counts: QualityCounts;
  readonly metrics: QualityMetrics;
}

export interface QualityReport {
  readonly issues: readonly QualityIssue[];
  readonly files: readonly QualityFileReport[];
  readonly counts: QualityCounts;
  readonly metrics: QualityMetrics;
}

// ---------------------------------------------------------------------------
// Разбор документа

// Типы и функции разбора ниже экспортируются для `specConsistency.ts`; из
// `index.ts` пакета они не выходят.

export type StepKeyword = 'GIVEN' | 'WHEN' | 'THEN';

export interface Line {
  readonly text: string;
  readonly line: number;
}

export interface Step extends Line {
  readonly keyword: StepKeyword;
}

export interface Scenario {
  readonly name: string;
  readonly line: number;
  readonly steps: Step[];
}

export interface Requirement {
  readonly name: string;
  readonly line: number;
  readonly operation: DeltaOperation | null;
  readonly description: Line[];
  readonly scenarios: Scenario[];
}

export interface QualityDocument {
  readonly path: string;
  readonly capability: string;
  readonly change: string | null;
  readonly purpose: Line[];
  /** Строки разделов-реестров: Glossary, Configuration, Параметры… */
  readonly registry: Line[];
  readonly requirements: Requirement[];
}

const RE_H2 = /^##\s+(.+?)\s*#*\s*$/;
const RE_H3 = /^###\s+/;
const RE_REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*#*\s*$/;
const RE_SCENARIO = /^####\s+Scenario:\s*(.+?)\s*#*\s*$/;
const RE_HEADING = /^#{1,6}\s/;
const RE_STEP = /^\s*[-*+]\s+\*\*(WHEN|THEN|AND|GIVEN|IF|BUT)\*\*:?\s*(.*)$/i;
const RE_DELTA = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/;
/** Заголовки разделов, где спек объявляет свои термины и параметры. */
const RE_REGISTRY_SECTION = /^(glossary|configuration|config|parameters|terms|terminology|глоссарий|конфигурация|параметры|настройки|термины|словарь)\b/i;

export function parseDocument(path: string, capability: string, change: string | null, text: string): QualityDocument {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const mask = fenceMask(lines);
  const purpose: Line[] = [];
  const registry: Line[] = [];
  const requirements: Requirement[] = [];
  let section: 'purpose' | 'registry' | 'other' = 'other';
  let operation: DeltaOperation | null = null;
  let requirement: Requirement | null = null;
  let scenario: Scenario | null = null;
  let lastKeyword: StepKeyword = 'WHEN';

  const close = (): void => {
    if (requirement !== null) requirements.push(requirement);
    requirement = null;
    scenario = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = index + 1;
    if (mask[index] === true) continue;

    const delta = RE_DELTA.exec(raw);
    if (delta?.[1] !== undefined) {
      close();
      operation = delta[1] as DeltaOperation;
      section = 'other';
      continue;
    }
    const h2 = RE_H2.exec(raw);
    if (h2?.[1] !== undefined && !raw.startsWith('###')) {
      close();
      const heading = h2[1].trim();
      section = /^purpose\b|^назначение\b|^цель\b/i.test(heading) ? 'purpose' : RE_REGISTRY_SECTION.test(heading) ? 'registry' : 'other';
      if (!/^requirements\b/i.test(heading)) operation = null;
      continue;
    }
    const requirementMatch = RE_REQUIREMENT.exec(raw);
    if (requirementMatch?.[1] !== undefined) {
      close();
      section = 'other';
      requirement = { name: requirementMatch[1], line, operation, description: [], scenarios: [] };
      continue;
    }
    if (RE_H3.test(raw)) {
      close();
      // Подзаголовок внутри реестра — его строки тоже часть реестра.
      if (section !== 'registry') section = 'other';
      continue;
    }
    const scenarioMatch = RE_SCENARIO.exec(raw);
    if (scenarioMatch?.[1] !== undefined) {
      if (requirement !== null) {
        scenario = { name: scenarioMatch[1], line, steps: [] };
        (requirement as Requirement).scenarios.push(scenario);
        lastKeyword = 'WHEN';
      }
      continue;
    }
    if (RE_HEADING.test(raw)) continue;
    if (raw.trim() === '') continue;

    if (requirement === null) {
      if (section === 'purpose') purpose.push({ text: raw, line });
      else if (section === 'registry') registry.push({ text: raw, line });
      continue;
    }
    if (scenario !== null) {
      const step = RE_STEP.exec(raw);
      if (step?.[1] !== undefined) {
        const word = step[1].toUpperCase();
        const keyword: StepKeyword =
          word === 'AND' || word === 'BUT' ? lastKeyword : word === 'IF' ? 'WHEN' : (word as StepKeyword);
        lastKeyword = keyword;
        (scenario as Scenario).steps.push({ keyword, text: step[2] ?? '', line });
      } else if ((scenario as Scenario).steps.length > 0) {
        // Перенос строки шага — продолжение того же шага.
        (scenario as Scenario).steps.push({ keyword: lastKeyword, text: raw.trim(), line });
      }
      continue;
    }
    (requirement as Requirement).description.push({ text: raw, line });
  }
  close();
  return { path, capability, change, purpose, registry, requirements };
}

// ---------------------------------------------------------------------------
// Текст: предложения, слова, токены

export interface Sentence {
  readonly text: string;
  readonly line: number;
}

/** Делит строки на предложения; пункт списка и пустая строка начинают новое. */
export function sentences(lines: readonly Line[]): Sentence[] {
  const result: Sentence[] = [];
  let text = '';
  let start = 0;
  const flush = (): void => {
    if (text.trim() !== '') result.push({ text: text.trim(), line: start });
    text = '';
  };
  let previous = -1;
  for (const item of lines) {
    if (item.line !== previous + 1 || /^\s*([-*+]|\d+\.)\s/.test(item.text)) flush();
    previous = item.line;
    let rest = item.text;
    if (text === '') start = item.line;
    // Конец предложения — точка, «!», «?» или «;» перед пробелом, кроме сокращений («т. д.», «e.g.»).
    const re = /[.!?;](?=\s|$)/g;
    let cut = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(rest)) !== null) {
      const before = rest.slice(cut, match.index);
      if (match[0] === '.' && /(?:^|[\s(])(?:\p{Ll}{1,2}|e\.g|i\.e|etc|vs|см|др)$/u.test(before)) continue;
      text += `${text === '' ? '' : ' '}${rest.slice(cut, match.index + 1)}`;
      flush();
      cut = match.index + 1;
      start = item.line;
    }
    rest = rest.slice(cut).trim();
    if (rest !== '') {
      if (text === '') start = item.line;
      text += `${text === '' ? '' : ' '}${rest}`;
    }
  }
  flush();
  return result;
}

const WORD = /[\p{L}\p{N}_]+/gu;

function normalizeWord(word: string): string {
  return word.toLowerCase().replaceAll('ё', 'е');
}

const STOPWORDS = new Set(
  (
    'и или а но в во на по при с со к ко у о об обо от до из за для без через над под не ни то же ли бы это этот эта эти ' +
    'этого этой тот та те того что чтобы как так если когда где его ее их он она они оно все всех всем каждый каждая ' +
    'каждое каждого каждой любой любая любое уже еще только также тоже сам сама свой своего своей быть есть был была ' +
    'было будет будут может могут должен должна должно должны система системы ide shall must should may when then ' +
    'given and or the a an of to in on for with if is are be by as at it its this that not no from into all any each ' +
    'system his her their will can без него нее них ему ей им'
  ).split(' '),
);

/** Содержательные слова текста: без служебных и короче трёх букв. */
function contentWords(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = normalizeWord(match[0]);
    if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    result.push(word);
  }
  return result;
}

function wordCount(text: string): number {
  return [...text.matchAll(WORD)].length;
}

/**
 * Слова совпадают, если у них общее начало не короче трёх букв и отличаются
 * они не больше чем тремя последними буквами: «кэш» / «кэша», «сессия» /
 * «сессии», «создание» / «создается».
 */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  let common = 0;
  while (common < shorter && a[common] === b[common]) common += 1;
  // Короткие слова отличаются одной буквой окончания, длинные — до трёх: «запрос» и «запись» — разные.
  if (common >= (shorter <= 4 ? Math.max(3, shorter - 1) : Math.max(4, shorter - 3))) return true;
  // Приставка: «переформулировка» содержит «формулировки».
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 6 && long.includes(short.slice(0, short.length - 2));
}

function hasWord(words: readonly string[], word: string): boolean {
  return words.some((item) => wordsMatch(item, word));
}

/** `Код` и ``код с ` внутри``. */
const CODE_SPAN = /``\s?(.+?)\s?``|`([^`]+)`/g;

/** Значения из `кода` в тексте. */
function codeValues(text: string): string[] {
  return [...text.matchAll(CODE_SPAN)].map((match) => match[1] ?? match[2] ?? '');
}

/** Текст, где каждый `код` заменён меткой `\uE000N\uE001`: внутри кода не ищутся слова-маркеры. */
function maskCode(text: string): { masked: string; spans: string[] } {
  const spans: string[] = [];
  const masked = text.replace(CODE_SPAN, (_, double: string | undefined, single: string | undefined) => {
    spans.push(double ?? single ?? '');
    return `\uE000${spans.length - 1}\uE001`;
  });
  return { masked, spans };
}

/** Текст без `кода`, «кавычек» и "кавычек": там сообщения и значения, а не формулировки. */
export function prose(text: string): string {
  return text.replace(CODE_SPAN, ' ').replace(/«[^»]*»/g, ' ').replace(/"[^"]*"/g, ' ');
}

const DEFAULT_CODE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';

export function codeRegex(config: QualityConfig): RegExp {
  let source = DEFAULT_CODE;
  if (config.errorCodePattern !== null) {
    try {
      new RegExp(config.errorCodePattern, 'u');
      source = config.errorCodePattern;
    } catch {
      // Ошибку шаблона сообщает разбор настроек; проверка идёт с умолчанием.
    }
  }
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, 'gu');
}

export function codes(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((match) => match[0]);
}

const NUMBER = /(?<![\p{L}\p{N}_.-])-?\d+(?:[.,]\d+)?(?![\p{L}\p{N}_])/gu;

function parseNumber(value: string): number {
  return Number(value.replace(',', '.'));
}

const ASSIGNMENT = /`?([A-Za-z_][\w.]*)`?\s*(?:=|:|равн\p{L}*|is|equals?)\s*`?(-?\d+(?:[.,]\d+)?)`?/gu;

/** Значения, присвоенные в шаге: `minTtl = 60`, «maxTtl равен 3600». */
function assignments(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (match[1] !== undefined && match[2] !== undefined && /[A-Za-z]/.test(match[1])) {
      result.set(match[1], parseNumber(match[2]));
    }
  }
  return result;
}

/** Числа шага без присвоенных параметрам значений. */
function inputNumbers(text: string): number[] {
  return [...text.replace(ASSIGNMENT, ' ').matchAll(NUMBER)].map((match) => parseNumber(match[0]));
}

const IDENT_CHAIN = /(?<![\p{L}\p{N}_./\\-])[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?![\p{L}\p{N}_/\\-])/gu;
const CAMEL = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/;
const FILE_EXTENSION = /\.(?:md|ya?ml|json|jsonc|ts|tsx|js|mjs|cjs|jsx|java|kt|py|go|rs|cs|html|css|txt|xml|sh|toml|lock)$/i;

/** Идентификаторы с camelCase-сегментом: параметры, поля, внутренние имена. Без путей и файлов. */
function camelIdentifiers(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(IDENT_CHAIN)) {
    const chain = match[0];
    if (FILE_EXTENSION.test(chain)) continue;
    const next = text[(match.index ?? 0) + chain.length];
    if (next === '(') continue;
    if (chain.split('.').some((part) => CAMEL.test(part))) result.push(chain);
  }
  return result;
}

const MODAL = /(?<![\p{L}\p{N}_])(?:SHALL|MUST|ДОЛЖ(?:ЕН|НА|НО|НЫ))(?![\p{L}\p{N}_])/u;

// ---------------------------------------------------------------------------
// Словари

interface Phrase {
  readonly label: string;
  readonly re: RegExp;
}

/** Фраза словаря: целое слово или начало слова (`валидн` ловит «валидным»). */
function phrase(label: string, pattern?: string): Phrase {
  const body = pattern ?? `${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\p{L}*`;
  return { label, re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{N}_])`, 'giu') };
}

const VAGUE: readonly Phrase[] = [
  phrase('валидный', 'валидн\\p{L}*'),
  phrase('корректный', '(?:не)?корректн\\p{L}*'),
  phrase('правильный', '(?:не)?правильн\\p{L}*'),
  phrase('надлежащий', 'надлежащ\\p{L}*'),
  phrase('приемлемый', 'приемлем\\p{L}*'),
  phrase('разумный', 'разумн\\p{L}*'),
  phrase('достаточный', 'достаточн\\p{L}*'),
  phrase('оптимальный', 'оптимальн\\p{L}*'),
  phrase('своевременный', 'своевременн\\p{L}*'),
  phrase('эффективный', 'эффективн\\p{L}*'),
  phrase('удобный', 'удобн\\p{L}*'),
  phrase('адекватный', 'адекватн\\p{L}*'),
  phrase('и т. д.', 'и\\s+т\\.\\s?д\\.?'),
  phrase('и т. п.', 'и\\s+т\\.\\s?п\\.?'),
  phrase('и др.', 'и\\s+др\\.'),
  phrase('и так далее', 'и\\s+так\\s+далее'),
  phrase('например', 'например'),
  phrase('при необходимости', 'при\\s+необходимости'),
  phrase('по мере необходимости', 'по\\s+мере\\s+необходимости'),
  phrase('по возможности', 'по\\s+возможности'),
  phrase('если возможно', 'если\\s+возможно'),
  phrase('как правило', 'как\\s+правило'),
  // «в основном спеке» — не расплывчатость: наречие стоит перед знаком препинания. Конец строки
  // не годится — строки проверяются по одной, и «спеке» может стоять на следующей.
  phrase('в основном', 'в\\s+основном(?=\\s*[,.;:)])'),
  phrase('обычно', 'обычно'),
  phrase('желательно', 'желательно'),
  phrase('valid', '(?:in)?valid(?:ly)?'),
  phrase('correct', '(?:in)?correct(?:ly)?'),
  phrase('proper', '(?:im)?proper(?:ly)?'),
  phrase('appropriate', '(?:in)?appropriate(?:ly)?'),
  phrase('reasonable', 'reasonabl[ey]'),
  phrase('sufficient', 'sufficient(?:ly)?'),
  phrase('adequate', 'adequate(?:ly)?'),
  phrase('efficient', 'efficient(?:ly)?'),
  phrase('user-friendly', 'user-friendly'),
  phrase('etc.', 'etc\\.?'),
  phrase('e.g.', 'e\\.g\\.?'),
  phrase('for example', 'for\\s+example'),
  phrase('for instance', 'for\\s+instance'),
  phrase('if necessary', 'if\\s+necessary'),
  phrase('as needed', 'as\\s+needed'),
  phrase('as appropriate', 'as\\s+appropriate'),
  phrase('if possible', '(?:if|where)\\s+possible'),
  phrase('usually', 'usually'),
  phrase('and so on', 'and\\s+so\\s+on'),
];

const INTERNAL: readonly Phrase[] = [
  phrase('кэш', 'кэш\\p{L}*|кеш\\p{L}*'),
  phrase('cache', 'cache[sd]?'),
  phrase('в памяти', 'в\\s+памяти'),
  phrase('in memory', 'in[\\s-]+memory'),
  phrase('внутренний', 'внутренн\\p{L}*'),
  phrase('internal', 'internal(?:ly)?'),
  phrase('база данных', '(?:баз\\p{L}*\\s+данных|БД)'),
  phrase('database', 'database'),
  // Переменная окружения видна снаружи — это настройка, а не внутреннее состояние.
  phrase('переменная', 'переменн\\p{L}*(?![\\p{L}]|\\s+окружени)'),
  phrase('variable', '(?<!environment\\s)variables?'),
  phrase('private', 'private'),
  phrase('приватный', 'приватн\\p{L}*'),
];

/** Слова, по которым THEN наблюдаем снаружи: ответ, код, статус, сообщение, интерфейс. */
const OBSERVABLE =
  /(?<![\p{L}])(?:ответ\p{L}*|response\p{L}*|возвра\p{L}*|return\p{L}*|статус\p{L}*|status|код\p{L}*|code|заголов\p{L}*|header\p{L}*|сообщ\p{L}*|message\p{L}*|показ\p{L}*|отобра\p{L}*|display\p{L}*|shows?|видн\p{L}*|visible|API|событи\p{L}*|event\p{L}*|метрик\p{L}*|metric\p{L}*|объясн\p{L}*|explain\p{L}*|уведомл\p{L}*|notif\p{L}*|предупрежд\p{L}*|warn\p{L}*)/iu;

const ERROR_WORDS =
  /(?<![\p{L}])(?:ошиб\p{L}*|отказ\p{L}*|отклон\p{L}*|запрещ\p{L}*|недопуст\p{L}*|errors?|reject\p{L}*|den(?:y|ied|ies)|fail\p{L}*|forbidden|refus\p{L}*)|(?<![\p{N}])[45]\d\d(?![\p{N}])/iu;

/** Слова, которыми текст задаёт порядок проверок. */
const ORDER_WORDS =
  /(?<![\p{L}])(?:сначала|затем|прежде|приоритет\p{L}*|порядк\p{L}*|порядок|первым|первой|первую|раньше|в\s+первую\s+очередь|first|then|before|after|priority|precedence|order(?:ed)?)(?![\p{L}])/iu;

/** Предложение о кодах: «вернуть код», «с кодом», `code`. */
const ERROR_CONTEXT = /(?<![\p{L}])(?:код\p{L}*|codes?)(?![\p{L}])/iu;

const REJECTION =
  /(?<![\p{L}])(?:отклон\p{L}*|отказ\p{L}*|возвра\p{L}*\s+(?:\p{L}+\s+)?ошибк\p{L}*|запрещ\p{L}*|reject\p{L}*|refus\p{L}*|return\p{L}*\s+(?:an?\s+)?error|fails?\s+with|deny|denies)/iu;

function dictionary(base: readonly Phrase[], extra: { readonly add: readonly string[]; readonly ignore: readonly string[] }): Phrase[] {
  const ignore = new Set(extra.ignore.map((item) => normalizeWord(item.trim())));
  return [
    ...base.filter((item) => !ignore.has(normalizeWord(item.label))),
    ...extra.add.filter((item) => item.trim() !== '').map((item) => phrase(item.trim())),
  ];
}

// ---------------------------------------------------------------------------
// Проверка

interface MutableCounts {
  codesTraced: number;
  codesTotal: number;
  branchesCovered: number;
  branchesTotal: number;
  boundariesCovered: number;
  boundariesTotal: number;
  words: number;
  vague: number;
}

function emptyCounts(): MutableCounts {
  return { codesTraced: 0, codesTotal: 0, branchesCovered: 0, branchesTotal: 0, boundariesCovered: 0, boundariesTotal: 0, words: 0, vague: 0 };
}

function addCounts(target: MutableCounts, source: QualityCounts): void {
  for (const key of Object.keys(target) as (keyof MutableCounts)[]) target[key] += source[key];
}

/** Метрики из счётчиков; доли — от 0 до 1, плотность — на 100 слов. */
export function qualityMetrics(counts: QualityCounts): QualityMetrics {
  const ratio = (part: number, total: number): number | null => (total === 0 ? null : part / total);
  return {
    errorCodeTraceability: ratio(counts.codesTraced, counts.codesTotal),
    branchCoverage: ratio(counts.branchesCovered, counts.branchesTotal),
    boundaryCoverage: ratio(counts.boundariesCovered, counts.boundariesTotal),
    ambiguityDensity: counts.words === 0 ? null : (counts.vague / counts.words) * 100,
  };
}

/** Подпись метрики для сообщений и отчётов. */
export const QUALITY_METRIC_LABELS: Readonly<Record<QualityMetric, string>> = {
  errorCodeTraceability: 'трассируемость кодов ошибок',
  branchCoverage: 'покрытие ветвлений',
  boundaryCoverage: 'покрытие границ',
  ambiguityDensity: 'расплывчатых слов на 100',
};

/** Значение метрики для человека: доли — в процентах, плотность — числом. */
export function formatQualityMetric(metric: QualityMetric, value: number | null): string {
  if (value === null) return '—';
  if (metric === 'ambiguityDensity') return value.toFixed(2).replace('.', ',');
  return `${Math.round(value * 100)} %`;
}

interface Context {
  readonly config: QualityConfig;
  readonly codeRe: RegExp;
  readonly vague: readonly Phrase[];
  readonly internal: readonly Phrase[];
  /** Реестр терминов документа: настройки и разделы Glossary/Configuration спека. */
  readonly terms: ReadonlySet<string>;
  readonly issues: QualityIssue[];
  readonly path: string;
}

/** Уровень правила с учётом настроек. */
export function ruleLevel(config: QualityConfig, rule: QualityRule): QualityLevel | 'off' {
  return config.levels[rule] ?? QUALITY_RULES[rule];
}

function report(context: Context, rule: QualityRule, line: number, message: string): void {
  const severity = ruleLevel(context.config, rule);
  if (severity === 'off') return;
  context.issues.push({ path: context.path, line, level: severity, rule, message });
}

function quote(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function list(items: readonly string[]): string {
  return items.map((item) => `«${item}»`).join(', ');
}

function stepsOf(requirement: Requirement, ...keywords: StepKeyword[]): Step[] {
  return requirement.scenarios.flatMap((scenario) => scenario.steps.filter((step) => keywords.includes(step.keyword)));
}

/**
 * Проверяет качество спеков источников по их настройкам (`sources.quality`,
 * без них — умолчания). С `path` — только этого документа: сверка реестра
 * кодов и пороги метрик считаются только по всему проекту.
 */
export function specQuality(sources: AuthoringSources, path?: string): QualityReport {
  const config = sources.quality ?? DEFAULT_QUALITY_CONFIG;
  const only = path === undefined ? null : normalizePath(path);
  const issues: QualityIssue[] = [];
  const files: QualityFileReport[] = [];
  const total = emptyCounts();
  const codeRe = codeRegex(config);
  const vague = dictionary(VAGUE, config.vagueWords);
  const internal = dictionary(INTERNAL, config.internalTerms);
  const mainTexts = new Map(sources.mainSpecs.map((spec) => [spec.capability, spec.text]));
  /** Коды всех документов — для сверки с реестром. */
  const used = new Map<string, { path: string; line: number }>();

  const documents: { path: string; capability: string; change: string | null; text: string }[] = [];
  if (config.scope === 'all') {
    for (const spec of sources.mainSpecs) documents.push({ path: spec.path, capability: spec.capability, change: null, text: spec.text });
  }
  for (const change of sources.changes) {
    for (const delta of change.deltas) documents.push({ path: delta.path, capability: delta.capability, change: change.name, text: delta.text });
  }

  // Сценарии сравниваются по всем документам, даже когда проверяется один.
  const parsed = documents.map((source) => {
    const document = parseDocument(source.path, source.capability, source.change, source.text);
    const checked = document.requirements.filter((item) => item.operation !== 'REMOVED' && item.operation !== 'RENAMED');
    return { source, document, checked };
  });

  for (const { source, document, checked } of parsed) {
    if (only !== null && normalizePath(source.path) !== only) continue;
    // Термины дельты — из её разделов и из основного спека capability.
    const main = source.change === null ? null : mainTexts.get(source.capability);
    const registryLines = [
      ...document.registry,
      ...(main === undefined || main === null ? [] : parseDocument('', source.capability, null, main).registry),
    ];
    const terms = new Set<string>([...config.glossary, ...Object.keys(config.parameters)]);
    for (const item of registryLines) {
      for (const match of item.text.matchAll(IDENT_CHAIN)) terms.add(match[0]);
    }
    for (const requirement of checked) {
      for (const text of [...requirement.description, ...requirement.scenarios.flatMap((scenario) => scenario.steps)]) {
        for (const code of codes(text.text, codeRe)) {
          if (!used.has(code)) used.set(code, { path: source.path, line: text.line });
        }
      }
    }
    const documentIssues: QualityIssue[] = [];
    const context: Context = { config, codeRe, vague, internal, terms, issues: documentIssues, path: source.path };
    const counts = emptyCounts();

    for (const requirement of checked) {
      addCounts(counts, checkRequirement(context, requirement));
    }
    checkRegistry(context, checked);
    if (source.change === null) checkPurpose(context, document, checked);

    issues.push(...documentIssues);
    files.push({
      path: source.path,
      capability: source.capability,
      change: source.change,
      requirements: checked.length,
      counts,
      metrics: qualityMetrics(counts),
    });
    addCounts(total, counts);
  }

  issues.push(
    ...scenarioConsistency(
      parsed.map(({ source, checked }) => ({ path: source.path, capability: source.capability, change: source.change, requirements: checked })),
      config,
      only,
    ),
    ...artifactRuleIssues(sources, only),
  );

  if (only === null) {
    const global: Context = { config, codeRe, vague, internal, terms: new Set(), issues, path: config.path ?? '' };
    checkErrorRegistry(global, used, documents.length > 0);
    checkThresholds(global, qualityMetrics(total));
  }
  for (const error of config.errors) {
    if (config.path !== null && (only === null || normalizePath(config.path) === only)) {
      issues.push({ path: config.path, line: error.line ?? 1, level: 'error', rule: 'config', message: error.message });
    }
  }
  return { issues, files, counts: total, metrics: qualityMetrics(total) };
}

export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function checkRequirement(context: Context, requirement: Requirement): QualityCounts {
  const counts = emptyCounts();
  const description = sentences(requirement.description);
  const name = `«${requirement.name}»`;

  // R1. Коды ошибок текста и THEN совпадают; коды, которые сценарий подаёт на вход в WHEN, — не коды ошибок.
  // В тексте кодом ошибки считается токен из реестра или из предложения об ошибке, отказе, коде:
  // `OPENSPEC_CLI` в предложении о поиске CLI — имя переменной, а не код.
  const registryCodes = new Set((context.config.registry ?? []).flatMap((file) => file.codes.map((item) => item.code)));
  const textCodes = new Map<string, number>();
  for (const sentence of description) {
    const aboutErrors = ERROR_WORDS.test(prose(sentence.text)) || ERROR_CONTEXT.test(prose(sentence.text));
    for (const code of codes(sentence.text, context.codeRe)) {
      if ((aboutErrors || registryCodes.has(code)) && !textCodes.has(code)) textCodes.set(code, sentence.line);
    }
  }
  const inputCodes = new Set(stepsOf(requirement, 'GIVEN', 'WHEN').flatMap((step) => codes(step.text, context.codeRe)));
  const thenCodes = new Map<string, { line: number; scenario: string }>();
  for (const scenario of requirement.scenarios) {
    for (const step of scenario.steps) {
      if (step.keyword !== 'THEN') continue;
      for (const code of codes(step.text, context.codeRe)) {
        if (!thenCodes.has(code)) thenCodes.set(code, { line: step.line, scenario: scenario.name });
      }
    }
  }
  const all = new Set([...textCodes.keys(), ...thenCodes.keys()].filter((code) => !inputCodes.has(code) || thenCodes.has(code)));
  for (const code of all) {
    counts.codesTotal += 1;
    const inText = textCodes.get(code);
    const inThen = thenCodes.get(code);
    if (inText !== undefined && inThen !== undefined) {
      counts.codesTraced += 1;
    } else if (inThen !== undefined) {
      report(
        context,
        'error-code-trace',
        inThen.line,
        `Код ${code} есть в THEN сценария «${inThen.scenario}», но не назван в тексте требования ${name}: правило, по которому он возникает, не описано`,
      );
    } else if (inText !== undefined) {
      report(
        context,
        'error-code-trace',
        inText,
        `Код ${code} назван в тексте требования ${name}, но ни один сценарий не проверяет его в THEN`,
      );
    }
  }

  // Порядок ошибок: два и больше кодов отказа — текст должен сказать, какой вернуть, если нарушено несколько условий.
  const errorCodes = [...all];
  if (errorCodes.length >= 2 && !description.some((sentence) => ORDER_WORDS.test(prose(sentence.text)))) {
    report(
      context,
      'error-order',
      requirement.line,
      `Требование ${name} называет ${errorCodes.length} кода ошибок (${errorCodes.join(', ')}), но не говорит, ` +
        'какой вернуть, если нарушено несколько условий сразу: задайте порядок проверок',
    );
  }

  // Шаги и имена сценариев: по ним ищется покрытие.
  const whenSteps = stepsOf(requirement, 'GIVEN', 'WHEN');
  const whenTexts = requirement.scenarios.map((scenario) =>
    [scenario.name, ...scenario.steps.filter((step) => step.keyword !== 'THEN').map((step) => step.text)].join(' '),
  );
  const scenarioTexts = requirement.scenarios.map((scenario) => [scenario.name, ...scenario.steps.map((step) => step.text)].join(' '));

  // R2. Условия текста покрыты сценариями.
  for (const sentence of description) {
    for (const condition of conditions(sentence.text)) {
      const words = [...new Set(contentWords(condition.clause))];
      if (words.length === 0) continue;
      counts.branchesTotal += 1;
      const ticks = codeValues(condition.clause);
      const covered = whenTexts.some((text) => {
        const scenarioWords = contentWords(text);
        const found = words.filter((word) => hasWord(scenarioWords, word)).length;
        // Короткое условие покрыто целиком, длинное — хотя бы на 60 %: «клиент заблокирован» не покрывает «клиент продлевает».
        const needed = words.length <= 2 ? words.length : Math.ceil(words.length * 0.6);
        return found >= needed && ticks.every((tick) => text.includes(tick));
      });
      if (covered) {
        counts.branchesCovered += 1;
      } else {
        report(
          context,
          'branch-coverage',
          sentence.line,
          `Условие «${quote(`${condition.marker} ${condition.clause}`)}» требования ${name} не покрыто ни одним сценарием: ` +
            'в WHEN и именах сценариев нет его ключевых слов',
        );
      }
    }
  }

  // R3. Каждый элемент перечисления из текста встречается хотя бы в одном сценарии.
  const missingItems = new Map<number, string[]>();
  for (const sentence of enumerationSources(requirement.description)) {
    for (const item of enumerationItems(sentence.text)) {
      if (scenarioTexts.some((text) => text.includes(valueCore(item)))) continue;
      const items = missingItems.get(sentence.line) ?? [];
      if (!items.includes(item)) items.push(item);
      missingItems.set(sentence.line, items);
    }
  }
  for (const [line, items] of missingItems) {
    report(
      context,
      'enumeration-coverage',
      line,
      `Перечисление в требовании ${name}: ${items.map((item) => `\`${item}\``).join(', ')} не встречается ни в одном сценарии`,
    );
  }

  // R4. Граничные значения: на каждую границу — сценарий на ней и за ней.
  const scenarioValues = new Map<string, number>();
  for (const step of whenSteps) for (const [key, value] of assignments(step.text)) scenarioValues.set(key, value);
  const resolve = (operand: Operand): number | null =>
    operand.value ?? context.config.parameters[operand.name ?? ''] ?? scenarioValues.get(operand.name ?? '') ?? null;
  const intervals: Interval[] = [];
  for (const sentence of description) {
    for (const bound of bounds(sentence.text)) {
      const missing: string[] = [];
      for (const point of bound.points) {
        counts.boundariesTotal += 1;
        const value = resolve(point.operand);
        const ok = whenTexts.some((text) => pointCovered(text, point, value));
        if (ok) counts.boundariesCovered += 1;
        else missing.push(`${POINT_LABEL[point.kind]} ${point.operand.label}`);
      }
      if (missing.length > 0) {
        report(
          context,
          'boundary-values',
          sentence.line,
          `Граница «${quote(bound.text, 40)}» требования ${name}: нет сценариев на значения ${missing.join(', ')}`,
        );
      }
      if (bound.interval !== null) intervals.push({ ...bound.interval, line: sentence.line });
    }
  }

  // R5. Для правила «привести к интервалу» ожидаемое значение THEN равно clamp(x, min, max).
  const clampRule = description.some((sentence) => CLAMP.test(sentence.text));
  if (clampRule) {
    for (const interval of intervals) {
      for (const scenario of requirement.scenarios) {
        const local = new Map<string, number>();
        for (const step of scenario.steps) if (step.keyword !== 'THEN') for (const [key, value] of assignments(step.text)) local.set(key, value);
        const bound = (operand: Operand): number | null =>
          operand.value ?? context.config.parameters[operand.name ?? ''] ?? local.get(operand.name ?? '') ?? null;
        const min = bound(interval.min);
        const max = bound(interval.max);
        if (min === null || max === null) continue;
        const inputs = scenario.steps.filter((step) => step.keyword !== 'THEN').flatMap((step) => inputNumbers(step.text));
        const outputs = scenario.steps.filter((step) => step.keyword === 'THEN').flatMap((step) => inputNumbers(step.text));
        const x = inputs.length === 1 ? inputs[0] : undefined;
        const y = outputs.length === 1 ? outputs[0] : undefined;
        if (x === undefined || y === undefined) continue;
        const expected = Math.min(Math.max(x, min), max);
        if (expected !== y) {
          const thenStep = scenario.steps.find((step) => step.keyword === 'THEN' && inputNumbers(step.text).length > 0);
          report(
            context,
            'clamp-arithmetic',
            thenStep?.line ?? scenario.line,
            `Сценарий «${scenario.name}»: по правилу требования ${name} значение ${x} приводится к [${min}, ${max}] ` +
              `и должно стать ${expected}, а THEN ожидает ${y}`,
          );
        }
      }
    }
  }

  // R6, R7. Детали реализации в WHEN/THEN и параметры вне реестра.
  const reportedTerms = new Set<string>();
  for (const scenario of requirement.scenarios) {
    for (const step of scenario.steps) {
      // В «кавычках» — цитата текста или сообщения, а не шаг сценария.
      const leaks = implementationLeaks(step.text.replace(/«[^»]*»/g, ' '), context.terms);
      if (leaks.length > 0) {
        report(
          context,
          'implementation-leak',
          step.line,
          `${step.keyword} сценария «${scenario.name}» ссылается на реализацию: ${list(leaks)}. ` +
            'Сценарий должен говорить о наблюдаемом поведении — запросе, ответе, коде ошибки',
        );
      }
    }
  }
  if (context.terms.size > 0) {
    const lines: Line[] = [...requirement.description, ...requirement.scenarios.flatMap((scenario) => scenario.steps)];
    for (const item of lines) {
      for (const identifier of camelIdentifiers(item.text)) {
        if (reportedTerms.has(identifier) || inRegistry(identifier, context.terms)) continue;
        reportedTerms.add(identifier);
        report(
          context,
          'parameter-registry',
          item.line,
          `«${identifier}» в требовании ${name} не объявлен ни в разделе Glossary/Configuration спека, ни в glossary/parameters настроек проверки`,
        );
      }
    }
  }

  // R8. Подлежащее при SHALL — из словаря акторов.
  if (context.config.actors.length > 0) {
    for (const sentence of description) {
      const modal = MODAL.exec(sentence.text);
      if (modal === null) continue;
      const subject = sentence.text.slice(0, modal.index);
      if (!hasActor(subject, context.config.actors)) {
        const guess = quote(subject.split(/[,:;]/).pop() ?? subject, 40) || '(нет подлежащего)';
        report(
          context,
          'actor-dictionary',
          sentence.line,
          `Подлежащее при ${modal[0]} в требовании ${name} — «${guess}» — не из словаря акторов: ${context.config.actors.join(', ')}`,
        );
      }
    }
  }

  // R9. Расплывчатые слова.
  const vagueLines: Line[] = [...requirement.description, ...requirement.scenarios.flatMap((scenario) => scenario.steps)];
  for (const item of vagueLines) {
    counts.words += wordCount(item.text);
    const found: string[] = [];
    const text = prose(item.text);
    for (const entry of context.vague) {
      for (const match of text.matchAll(entry.re)) {
        counts.vague += 1;
        if (!found.includes(match[0])) found.push(match[0]);
      }
    }
    if (found.length > 0) {
      report(
        context,
        'vague-wording',
        item.line,
        `Расплывчатая формулировка в требовании ${name}: ${list(found)} — замените проверяемым условием или перечислением`,
      );
    }
  }

  // R10. THEN проверяет наблюдаемое, а не внутреннее состояние.
  for (const scenario of requirement.scenarios) {
    for (const step of scenario.steps) {
      if (step.keyword !== 'THEN') continue;
      const text = prose(step.text);
      const terms = context.internal.flatMap((entry) => [...text.matchAll(entry.re)].map((match) => match[0]));
      if (terms.length === 0) continue;
      if (OBSERVABLE.test(text) || codes(step.text, context.codeRe).length > 0) continue;
      report(
        context,
        'observable-then',
        step.line,
        `THEN сценария «${scenario.name}» проверяет внутреннее состояние (${list([...new Set(terms)])}), ` +
          'а не ответ, код ошибки или состояние, видимое через API',
      );
    }
  }

  // R11. Требование с отказом — и негативный, и позитивный сценарий.
  const rejects = textCodes.size > 0 || description.some((sentence) => REJECTION.test(prose(sentence.text)));
  if (rejects && requirement.scenarios.length > 0) {
    const isError = (scenario: Scenario): boolean =>
      scenario.steps.some(
        (step) => step.keyword === 'THEN' && (ERROR_WORDS.test(prose(step.text)) || codes(step.text, context.codeRe).length > 0),
      );
    const negative = requirement.scenarios.filter(isError).length;
    const positive = requirement.scenarios.length - negative;
    if (negative === 0) {
      report(context, 'negative-scenarios', requirement.line, `Требование ${name} описывает отказ или ошибку, но ни один сценарий не проверяет её в THEN`);
    } else if (positive === 0) {
      report(context, 'negative-scenarios', requirement.line, `У требования ${name} есть только сценарии с ошибкой — нет сценария, где запрос проходит`);
    }
  }

  // R12. Атомарность: нормативные предложения говорят об одном предмете.
  const normative = description.filter((sentence) => MODAL.test(sentence.text));
  if (normative.length > 1) {
    const words = normative.map((sentence) => contentWords(prose(sentence.text)).filter((word) => !GENERIC.has(word)));
    const groups = connectedGroups(words);
    if (groups.length > 1) {
      const first = groups.map((group) => normative[group[0] ?? 0]?.text ?? '');
      report(
        context,
        'atomicity',
        requirement.line,
        `Требование ${name} похоже на ${groups.length} разных: ${first.map((text) => `«${quote(text, 50)}»`).join(' и ')} — ` +
          'у нормативных предложений нет общих слов. Разделите требование',
      );
    }
  }

  return counts;
}

// --- R2: условия

interface Condition {
  readonly marker: string;
  readonly clause: string;
}

const CONDITION =
  /(?<![\p{L}\p{N}_])(если|когда|в\s+случае,?\s+если|в\s+случае|при\s+условии,?\s+что|при|if|when|whenever|unless|in\s+case)\s+/giu;
const NOT_CONDITION = /^(?:этом|чем|помощи|необходимости|возможности|наличии\s+возможности|этой|том)\b/iu;

function conditions(text: string): Condition[] {
  const result: Condition[] = [];
  const { masked, spans } = maskCode(text);
  const unmask = (value: string): string => value.replace(/\uE000(\d+)\uE001/g, (_, index: string) => `\`${spans[Number(index)] ?? ''}\``);
  // «Когда / тогда» в кавычках — название, а не условие.
  const quoted = [...masked.matchAll(/«[^»]*»|"[^"]*"/g)].map((item) => [item.index ?? 0, (item.index ?? 0) + item[0].length] as const);
  for (const match of masked.matchAll(CONDITION)) {
    const at = match.index ?? 0;
    if (quoted.some(([from, to]) => at > from && at < to)) continue;
    // `WHEN`, `IF` заглавными — ключевые слова формата, а не условие.
    if (/^[A-Z\s]+$/.test(match[1] ?? '')) continue;
    const rest = masked.slice(at + match[0].length);
    if (NOT_CONDITION.test(rest)) continue;
    const modal = MODAL.exec(rest);
    let clause = modal === null ? rest : rest.slice(0, modal.index);
    clause = clause.split(/[,;:.!?]|\s(?:то|then|—)\s/u)[0] ?? '';
    const marker = (match[1] ?? '').toLowerCase();
    // «При X …, Y ДОЛЖНО» без запятой: условие — только именная группа после «при».
    if (marker === 'при') clause = clause.split(/\s+/).slice(0, 3).join(' ');
    if (clause.trim() === '') continue;
    result.push({ marker: match[1] ?? '', clause: unmask(clause.trim()) });
  }
  return result;
}

// --- R3: перечисления

/** Источники перечислений: предложения текста и пункты списков из `кода`. */
function enumerationSources(lines: readonly Line[]): Sentence[] {
  const result = sentences(lines);
  // Список из двух и более пунктов, каждый начинается с `кода`, — тоже перечисление.
  const bullets = lines.filter((item) => /^\s*[-*+]\s+`[^`]+`/.test(item.text));
  if (bullets.length >= 2) {
    const first = bullets[0];
    if (first !== undefined) {
      result.push({
        text: bullets.map((item) => /`[^`]+`/.exec(item.text)?.[0] ?? '').join(', '),
        line: first.line,
      });
    }
  }
  return result;
}

const ENUM_GLUE = /^\s*(?:,|;|\/|и|или|либо|and|or|,\s*(?:и|или|либо|а\s+также|and|or)|,?\s*так\s+и)\s*$/iu;

/** Значение поведения: одно слово без пробелов, путей и файлов, хотя бы две буквы или цифры. */
function valueLike(item: string): boolean {
  return (
    item.length <= 40 &&
    !/\s/.test(item) &&
    !item.includes('/') &&
    !FILE_EXTENSION.test(item) &&
    (item.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2
  );
}

/** Значение без обрамляющей пунктуации: `TO:` ищется в сценарии как «TO», `--skip` — как «skip». */
function valueCore(item: string): string {
  return item.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Элементы перечислений из `кода`: «`A`, `B` и `C`», «как `X`, так и `Y`», «(`A`/`B`)». */
function enumerationItems(source: string): string[] {
  // Интервал [`min`, `max`] — граница, его проверяет правило граничных значений.
  const text = source.replace(/\[\s*`[^`]+`\s*[,;]\s*`[^`]+`\s*\]/g, (match) => ' '.repeat(match.length));
  const spans = [...text.matchAll(CODE_SPAN)].map((match) => ({
    // ``\`код\` `` — значение без внутренних обратных кавычек.
    value: (match[1] ?? match[2] ?? '').replace(/^`+|`+$/g, ''),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const result: string[] = [];
  let group: typeof spans = [];
  const flush = (): void => {
    if (group.length >= 2) for (const span of group) if (!result.includes(span.value)) result.push(span.value);
    group = [];
  };
  for (const span of spans) {
    const previous = group[group.length - 1];
    if (previous !== undefined && !ENUM_GLUE.test(text.slice(previous.end, span.start))) flush();
    group.push(span);
  }
  flush();
  return result.filter(valueLike);
}

// --- R4, R5: границы

export interface Operand {
  readonly label: string;
  readonly value: number | null;
  readonly name: string | null;
}

export type PointKind = 'eq' | 'below' | 'above';

export interface BoundPoint {
  readonly kind: PointKind;
  readonly operand: Operand;
}

export interface Bound {
  readonly text: string;
  readonly points: readonly BoundPoint[];
  readonly interval: { readonly min: Operand; readonly max: Operand } | null;
}

interface Interval {
  readonly min: Operand;
  readonly max: Operand;
  readonly line: number;
}

const POINT_LABEL: Record<PointKind, string> = { eq: '=', below: '<', above: '>' };

/** Граница: число, `код` (в тексте — метка \\uE000N\\uE001) или camelCase-параметр. */
const OPERAND = '(-?\\d+(?:[.,]\\d+)?|\\uE000\\d+\\uE001|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)';
const INTERVALS: readonly RegExp[] = [
  new RegExp(`\\[\\s*${OPERAND}\\s*[,;]\\s*${OPERAND}\\s*\\]`, 'gu'),
  new RegExp(`(?<![\\p{L}])от\\s+${OPERAND}\\s+до\\s+${OPERAND}`, 'giu'),
  new RegExp(`(?<![\\p{L}])between\\s+${OPERAND}\\s+and\\s+${OPERAND}`, 'giu'),
];
const UPPER = '(?:не\\s+(?:более|больше|выше|длиннее|позднее|позже)|максимум|не\\s+превыша\\p{L}*|превыша\\p{L}*|достига\\p{L}*|достиг\\p{L}*|больше|более|свыше|at\\s+most|no\\s+more\\s+than|up\\s+to|exceed\\p{L}*|greater\\s+than|more\\s+than|reach\\p{L}*|≤|<=|>=|>|≥)';
const LOWER = '(?:не\\s+(?:менее|меньше|ниже|раньше|короче)|минимум|меньше|менее|ниже|at\\s+least|no\\s+less\\s+than|less\\s+than|fewer\\s+than|below|<)';
const THRESHOLD = new RegExp(`(?<![\\p{L}])(${UPPER}|${LOWER})\\s+${OPERAND}`, 'giu');
const LOWER_RE = new RegExp(`^${LOWER}$`, 'iu');
const CLAMP = /(?<![\p{L}])(?:clamp\p{L}*|привод\p{L}*|привед\p{L}*|привёд\p{L}*|обреза\p{L}*|ограничива\p{L}*|limited\s+to|capped|bounded)/iu;

function operand(raw: string, spans: readonly string[]): Operand | null {
  const placeholder = /^\uE000(\d+)\uE001$/.exec(raw);
  const clean = (placeholder?.[1] === undefined ? raw : (spans[Number(placeholder[1])] ?? '')).trim();
  // Граница из `кода` — число или имя параметра, а не фраза.
  if (!/^-?\d+(?:[.,]\d+)?$|^[A-Za-z_][\w.]*$/.test(clean)) return null;
  const value = /^-?\d+(?:[.,]\d+)?$/.test(clean) ? parseNumber(clean) : null;
  return { label: clean, value, name: value === null ? clean : null };
}

export function bounds(text: string): Bound[] {
  const { masked, spans } = maskCode(text);
  const unmask = (value: string): string => value.replace(/\uE000(\d+)\uE001/g, (_, index: string) => spans[Number(index)] ?? '');
  const result: Bound[] = [];
  const taken: [number, number][] = [];
  for (const re of INTERVALS) {
    for (const match of masked.matchAll(re)) {
      if (match[1] === undefined || match[2] === undefined) continue;
      const min = operand(match[1], spans);
      const max = operand(match[2], spans);
      if (min === null || max === null) continue;
      // Числовой «интервал» вида [3, 1] — не интервал.
      if (min.value !== null && max.value !== null && min.value >= max.value) continue;
      taken.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
      result.push({
        text: unmask(match[0]),
        points: [
          { kind: 'eq', operand: min },
          { kind: 'eq', operand: max },
          { kind: 'below', operand: min },
          { kind: 'above', operand: max },
        ],
        interval: { min, max },
      });
    }
  }
  for (const match of masked.matchAll(THRESHOLD)) {
    const start = match.index ?? 0;
    if (taken.some(([from, to]) => start >= from && start < to)) continue;
    if (match[1] === undefined || match[2] === undefined) continue;
    const target = operand(match[2], spans);
    if (target === null) continue;
    const lower = LOWER_RE.test(match[1].trim());
    result.push({
      text: unmask(match[0]),
      points: [
        { kind: 'eq', operand: target },
        { kind: lower ? 'below' : 'above', operand: target },
      ],
      interval: null,
    });
  }
  return result;
}

const EQ_MARK = /(?:^|[^<>!=])=(?!=)|==|равн\p{L}*|ровно|совпада\p{L}*|достиг\p{L}*|equal\p{L}*|exactly|same\s+as|reach\p{L}*/iu;
const LT_MARK = /<|меньше|ниже|менее|less|below|under|fewer/iu;
const GT_MARK = />|больше|выше|более|превыша\p{L}*|сверх|greater|more\s+than|above|exceed\p{L}*|over/iu;

function pointCovered(source: string, point: BoundPoint, value: number | null): boolean {
  let text = source;
  if (value !== null) {
    const numbers = inputNumbers(text);
    if (point.kind === 'eq' && numbers.includes(value)) return true;
    if (point.kind === 'below' && numbers.some((number) => number < value)) return true;
    if (point.kind === 'above' && numbers.some((number) => number > value)) return true;
  }
  const name = point.operand.name;
  // «`minTtl` = 60» задаёт значение границы, а не проверяет равенство ей.
  text = text.replace(ASSIGNMENT, ' ');
  if (name === null || !text.includes(name)) return false;
  // Сравнение должно стоять рядом с именем границы, а не где-то в шаге.
  const at = text.indexOf(name);
  const near = text.slice(Math.max(0, at - 30), at + name.length + 30);
  if (point.kind === 'eq') return EQ_MARK.test(near);
  if (point.kind === 'below') return LT_MARK.test(near);
  return GT_MARK.test(near);
}

// --- R6, R7: реализация и реестр терминов

const METHOD_CALL = /(?<![\p{L}\p{N}_])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\(([^()]*)\)/gu;

function implementationLeaks(text: string, terms: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(METHOD_CALL)) {
    const name = match[1] ?? '';
    // «ДОЛЖНА (SHALL)», «HTTP(S)» — не вызов: вызов — идентификатор со строчной буквой или с точкой.
    if (!/[a-z]/.test(name) && !name.includes('.')) continue;
    // «scenario(s)» — окончание множественного числа, а не вызов.
    if (/^(?:s|es)$/.test(match[2] ?? '')) continue;
    if (!result.includes(match[0])) result.push(match[0]);
  }
  for (const match of text.matchAll(IDENT_CHAIN)) {
    const chain = match[0];
    const head = chain.split('.')[0] ?? '';
    if (!chain.includes('.') || FILE_EXTENSION.test(chain) || !CAMEL.test(head)) continue;
    if (text[(match.index ?? 0) + chain.length] === '(') continue;
    if (inRegistry(chain, terms) || result.some((item) => item.startsWith(chain))) continue;
    result.push(chain);
  }
  return result;
}

function inRegistry(identifier: string, terms: ReadonlySet<string>): boolean {
  if (terms.has(identifier)) return true;
  for (const term of terms) {
    if (term.endsWith(`.${identifier}`) || identifier.endsWith(`.${term}`) || identifier.startsWith(`${term}.`)) return true;
  }
  return false;
}

// --- R8: акторы

function hasActor(subject: string, actors: readonly string[]): boolean {
  const words = [...subject.matchAll(WORD)].map((match) => normalizeWord(match[0]));
  const lower = normalizeWord(subject);
  return actors.some((actor) => {
    const parts = [...actor.matchAll(WORD)].map((match) => normalizeWord(match[0]));
    if (parts.length === 0) return false;
    if (parts.length > 1) return lower.includes(normalizeWord(actor));
    const single = parts[0] ?? '';
    // Короткие аббревиатуры («КМ») сравниваются целиком, слова — по общему началу.
    return words.some((word) => (single.length <= 3 ? word === single : wordsMatch(word, single)));
  });
}

// --- R12: атомарность

/** Слова, общие для любых требований: не связывают предложения. */
const GENERIC = new Set(
  'должен должна должно должны shall must система systems ide интерфейс пользователь user также при этом'.split(' '),
);

/** Группы предложений, связанных общими словами (компоненты связности). */
function connectedGroups(words: readonly string[][]): number[][] {
  const parent = words.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) index = parent[index] ?? index;
    return index;
  };
  for (let a = 0; a < words.length; a += 1) {
    for (let b = a + 1; b < words.length; b += 1) {
      const left = words[a] ?? [];
      const right = words[b] ?? [];
      if (left.some((word) => hasWord(right, word))) parent[find(b)] = find(a);
    }
  }
  const groups = new Map<number, number[]>();
  words.forEach((_, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  });
  // Предложение без содержательных слов не делает требование составным.
  return [...groups.values()].filter((group) => group.some((index) => (words[index] ?? []).length > 0));
}

// --- R13: Purpose

/** Слова, с которых начинается придаточное или противопоставление, а не элемент списка. */
const CLAUSE_START = /^(?:а|но|что|чтобы|который|которая|которое|которые|где|когда|если|как|поэтому|потому|так|причем|причём|при|без|which|that|so|but|where|when|because)(?![\p{L}])/iu;

/**
 * Что Purpose обещает: пункты списка и перечисления — подряд идущие короткие
 * части предложения через запятую или «и» (после двоеточия — от двух, без
 * него — от трёх). Придаточные («чтобы …», «а не …») перечислением не считаются.
 */
function purposeItems(lines: readonly Line[]): { text: string; line: number }[] {
  const result: { text: string; line: number }[] = [];
  for (const item of lines) {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(item.text);
    if (bullet?.[1] !== undefined) result.push({ text: bullet[1].split(/\s[—–-]\s|:\s/)[0] ?? bullet[1], line: item.line });
  }
  for (const sentence of sentences(lines.filter((item) => !/^\s*[-*+]\s/.test(item.text)))) {
    const text = prose(sentence.text);
    const colon = text.indexOf(':');
    const segments = colon >= 0 ? [{ text: text.slice(colon + 1), min: 2 }, { text: text.slice(0, colon), min: 3 }] : [{ text, min: 3 }];
    for (const segment of segments) {
      const parts = segment.text.split(/,|;|\s(?:и|или|а\s+также|and|or)\s/u).map((part) => part.trim().replace(/[.!?]+$/, ''));
      let run: string[] = [];
      const flush = (): void => {
        if (run.length >= segment.min) for (const part of run) result.push({ text: part, line: sentence.line });
        run = [];
      };
      for (const part of parts) {
        const words = [...part.matchAll(WORD)].length;
        if (part === '' || words > 4 || CLAUSE_START.test(part)) flush();
        else run.push(part);
      }
      flush();
    }
  }
  return result;
}

function checkPurpose(context: Context, document: QualityDocument, requirements: readonly Requirement[]): void {
  if (document.purpose.length === 0 || requirements.length === 0) return;
  const covered = requirements.flatMap((requirement) =>
    contentWords([requirement.name, ...requirement.description.map((item) => item.text)].join(' ')),
  );
  const missing = new Map<number, string[]>();
  for (const item of purposeItems(document.purpose)) {
    const words = [...new Set(contentWords(item.text))];
    if (words.length === 0 || words.length > 6) continue;
    const found = words.filter((word) => hasWord(covered, word)).length;
    if (found >= Math.ceil(words.length / 2)) continue;
    const list = missing.get(item.line) ?? [];
    list.push(quote(item.text, 40));
    missing.set(item.line, list);
  }
  for (const [line, items] of missing) {
    report(
      context,
      'purpose-coverage',
      line,
      `Purpose обещает ${list(items)}, но ни одно требование об этом не говорит — ни в имени, ни в тексте`,
    );
  }
}

// --- R14: реестр кодов ошибок, пороги

function checkRegistry(context: Context, requirements: readonly Requirement[]): void {
  const registry = context.config.registry;
  if (registry === null) return;
  const known = new Set(registry.flatMap((file) => file.codes.map((item) => item.code)));
  const reported = new Set<string>();
  for (const requirement of requirements) {
    const lines: Line[] = [...requirement.description, ...requirement.scenarios.flatMap((scenario) => scenario.steps)];
    for (const item of lines) {
      for (const code of codes(item.text, context.codeRe)) {
        if (known.has(code) || reported.has(code)) continue;
        reported.add(code);
        report(context, 'error-code-registry', item.line, `Кода ${code} нет в реестре кодов ошибок (${registry.map((file) => file.path).join(', ')})`);
      }
    }
  }
}

function checkErrorRegistry(context: Context, used: ReadonlyMap<string, { path: string; line: number }>, hasDocuments: boolean): void {
  const registry = context.config.registry;
  if (registry === null || !hasDocuments) return;
  if (ruleLevel(context.config, 'error-code-registry') === 'off') return;
  for (const file of registry) {
    for (const item of file.codes) {
      if (used.has(item.code)) continue;
      // Код без спеки — пробел в спецификации, а не ошибка кода: сведение.
      context.issues.push({
        path: file.path,
        line: item.line,
        level: 'info',
        rule: 'error-code-registry',
        message: `Код ${item.code} из реестра не упоминается ни в одной спеке — поведение, при котором он возникает, не специфицировано`,
      });
    }
  }
}

function checkThresholds(context: Context, metrics: QualityMetrics): void {
  for (const threshold of context.config.thresholds) {
    const value = metrics[threshold.metric];
    if (value === null) continue;
    const lowerIsBetter = threshold.metric === 'ambiguityDensity';
    const failed = lowerIsBetter ? value > threshold.value : value < threshold.value;
    if (!failed) continue;
    report(
      { ...context, path: context.config.path ?? context.path },
      'metric-threshold',
      threshold.line ?? 1,
      `Метрика «${QUALITY_METRIC_LABELS[threshold.metric]}» — ${formatQualityMetric(threshold.metric, value)}, ` +
        `${lowerIsBetter ? 'выше' : 'ниже'} порога ${formatQualityMetric(threshold.metric, threshold.value)}`,
    );
  }
}
