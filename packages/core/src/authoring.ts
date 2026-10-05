/**
 * Помощь при написании спеков, дельт и плана в редакторе.
 *
 * Модуль чистый: на вход — тексты основных спеков, дельт и планов активных
 * changes и текст открытого документа (с несохранёнными правками), на выход —
 * символы, дополнения, исправления, проверки, наведение, переходы и подсказки
 * над строками. Редактор переводит их в свои типы; команда проверки для CI
 * берёт отсюда те же проверки ссылок.
 *
 * Строки — с 1, символы в строке — с 0.
 */
import { buildDeltaView, similarNames } from './delta.js';
import type { DeltaOperation } from './specMarkdown.js';
import { fenceMask, normalizeRequirementName, requirementBlocks, type RequirementBlock } from './specChange.js';
import { type Trace, buildTrace } from './trace.js';
import type { QualityConfig } from './specQuality.js';
import { parseTrackedDocument } from './trackedItems.js';

/** Основной спек capability. */
export interface AuthoringSpec {
  readonly capability: string;
  /** Путь относительно корня рабочего пространства, через `/`. */
  readonly path: string;
  readonly text: string;
}

/** Файл дельты change. */
export interface AuthoringDelta {
  readonly capability: string;
  readonly path: string;
  readonly text: string;
}

/** Активный change: его дельты и отслеживаемый артефакт. */
export interface AuthoringChange {
  readonly name: string;
  readonly deltas: readonly AuthoringDelta[];
  /** План; `null`, если схема не объявила отслеживаемый артефакт или файла нет. */
  readonly plan: { readonly path: string; readonly text: string } | null;
}

/** Всё, что нужно языковым функциям. */
export interface AuthoringSources {
  readonly mainSpecs: readonly AuthoringSpec[];
  readonly changes: readonly AuthoringChange[];
  /** Настройки проверки качества спеков; без них — умолчания. */
  readonly quality?: QualityConfig;
}

/** Вид документа OpenSpec. */
export type AuthoringDocument =
  | { readonly kind: 'spec'; readonly capability: string }
  | { readonly kind: 'delta'; readonly change: string; readonly capability: string }
  | { readonly kind: 'plan'; readonly change: string };

/** Место в файле. */
export interface AuthoringLocation {
  readonly path: string;
  readonly line: number;
}

/** Диапазон в документе. */
export interface AuthoringRange {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

/** Правка документа. */
export interface AuthoringEdit {
  readonly path: string;
  readonly range: AuthoringRange;
  readonly newText: string;
}

/** Путь к файлу в едином виде. */
function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** Определяет вид документа по источникам; `null` — документ не OpenSpec. */
export function documentKind(sources: AuthoringSources, path: string): AuthoringDocument | null {
  const target = normalizePath(path);
  const spec = sources.mainSpecs.find((item) => normalizePath(item.path) === target);
  if (spec !== undefined) return { kind: 'spec', capability: spec.capability };
  for (const change of sources.changes) {
    const delta = change.deltas.find((item) => normalizePath(item.path) === target);
    if (delta !== undefined) return { kind: 'delta', change: change.name, capability: delta.capability };
    if (change.plan !== null && normalizePath(change.plan.path) === target) return { kind: 'plan', change: change.name };
  }
  return null;
}

/** Источники, в которых текст документа заменён текстом редактора. */
export function withDocumentText(sources: AuthoringSources, path: string, text: string): AuthoringSources {
  const target = normalizePath(path);
  return {
    ...sources,
    mainSpecs: sources.mainSpecs.map((item) => (normalizePath(item.path) === target ? { ...item, text } : item)),
    changes: sources.changes.map((change) => ({
      ...change,
      deltas: change.deltas.map((item) => (normalizePath(item.path) === target ? { ...item, text } : item)),
      plan: change.plan !== null && normalizePath(change.plan.path) === target ? { ...change.plan, text } : change.plan,
    })),
  };
}

// ---------------------------------------------------------------------------
// Разбор дельты по строкам

/** Упоминание требования в дельте: заголовок или строка `FROM:`/`TO:` в RENAMED. */
export interface DeltaMention {
  readonly operation: DeltaOperation;
  readonly role: 'header' | 'from' | 'to';
  readonly name: string;
  readonly line: number;
  /** Где в строке начинается и кончается имя. */
  readonly nameStart: number;
  readonly nameEnd: number;
}

/** Секция дельты, начинающаяся на строке. */
interface DeltaSection {
  readonly operation: DeltaOperation | null;
  readonly line: number;
}

const RE_DELTA_SECTION = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/;
const RE_SECTION = /^##\s+/;
const RE_REQUIREMENT_HEADER = /^(###\s+Requirement:\s*)(.*?)\s*$/;
const RE_RENAME_LINE = /^(\s*[-*+]?\s*(FROM|TO):\s*`?(?:###\s*Requirement:\s*)?)(.*?)`?\s*$/;

function splitLines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/\r$/, ''));
}

/** Секции и упоминания требований дельты. */
export function scanDelta(text: string): { sections: DeltaSection[]; mentions: DeltaMention[] } {
  const lines = splitLines(text);
  const mask = fenceMask(lines);
  const sections: DeltaSection[] = [];
  const mentions: DeltaMention[] = [];
  let operation: DeltaOperation | null = null;

  lines.forEach((raw, index) => {
    if (mask[index] === true) return;
    const line = index + 1;
    const section = RE_DELTA_SECTION.exec(raw);
    if (section?.[1] !== undefined) {
      operation = section[1] as DeltaOperation;
      sections.push({ operation, line });
      return;
    }
    if (RE_SECTION.test(raw)) {
      operation = null;
      sections.push({ operation, line });
      return;
    }
    if (operation === null) return;
    const header = RE_REQUIREMENT_HEADER.exec(raw);
    if (header?.[1] !== undefined && header[2] !== undefined) {
      const name = normalizeRequirementName(header[2]);
      if (name === '') return;
      mentions.push({
        operation,
        role: 'header',
        name,
        line,
        nameStart: header[1].length,
        nameEnd: header[1].length + header[2].length,
      });
      return;
    }
    if (operation !== 'RENAMED') return;
    const rename = RE_RENAME_LINE.exec(raw);
    if (rename?.[1] !== undefined && rename[3] !== undefined && rename[3].trim() !== '') {
      mentions.push({
        operation,
        role: rename[2] === 'FROM' ? 'from' : 'to',
        name: normalizeRequirementName(rename[3]),
        line,
        nameStart: rename[1].length,
        nameEnd: rename[1].length + rename[3].length,
      });
    }
  });

  return { sections, mentions };
}

/** Операция секции, в которой стоит строка. */
function operationAt(sections: readonly DeltaSection[], line: number): DeltaOperation | null {
  let current: DeltaOperation | null = null;
  for (const section of sections) {
    if (section.line > line) break;
    current = section.operation;
  }
  return current;
}

/** Блоки требований основного спека capability; `null`, если спека нет. */
function mainBlocks(sources: AuthoringSources, capability: string): { spec: AuthoringSpec; blocks: RequirementBlock[] } | null {
  const spec = sources.mainSpecs.find((item) => item.capability === capability);
  return spec === undefined ? null : { spec, blocks: requirementBlocks(spec.text) };
}

/** Требование основного спека с тем же именем — как его находит архивация CLI. */
function findBlock(blocks: readonly RequirementBlock[], name: string): RequirementBlock | undefined {
  const wanted = normalizeRequirementName(name);
  return blocks.find((block) => block.name === wanted);
}

/** Похожие имена: сначала отличающиеся только регистром и пробелами, затем по общим словам. */
function suggestions(blocks: readonly RequirementBlock[], name: string): string[] {
  const loose = (value: string): string => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const exactish = blocks.filter((block) => loose(block.name) === loose(name)).map((block) => block.name);
  const byWords = similarNames(name, blocks.map((block) => block.name));
  return [...new Set([...exactish, ...byWords])].slice(0, 3);
}

function changeOf(sources: AuthoringSources, name: string): AuthoringChange | undefined {
  return sources.changes.find((change) => change.name === name);
}

function deltaOf(sources: AuthoringSources, change: string, capability: string): AuthoringDelta | undefined {
  return changeOf(sources, change)?.deltas.find((delta) => delta.capability === capability);
}

// ---------------------------------------------------------------------------
// Структура плана и символы

/** Узел структуры документа. */
export interface AuthoringSymbol {
  readonly name: string;
  readonly detail: string;
  readonly kind: 'group' | 'item';
  readonly line: number;
  readonly endLine: number;
  readonly children: readonly AuthoringSymbol[];
}

/** Структура плана: группы и пункты. Для спеков и дельт её даёт Markdown редактора. */
export function planSymbols(text: string): AuthoringSymbol[] {
  const document = parseTrackedDocument(text);
  const total = splitLines(text).length;
  const references = planReferenceLines(text);

  const itemSymbol = (item: (typeof document.items)[number], endLine: number): AuthoringSymbol => {
    const refs = references.get(item.line) ?? 0;
    return {
      name: item.declaredNumber === null ? item.text : `${item.declaredNumber} ${item.text}`,
      detail: [item.done ? '✓ выполнен' : 'не выполнен', refs > 0 ? `ссылок: ${refs}` : null]
        .filter((part): part is string => part !== null)
        .join(' · '),
      kind: 'item',
      line: item.line,
      endLine,
      children: [],
    };
  };

  const items = document.items;
  const endOfItem = (index: number, limit: number): number => {
    const next = items[index + 1];
    return next !== undefined && next.line <= limit ? next.line - 1 : limit;
  };

  if (document.groups.length === 0) {
    return items.map((item, index) => itemSymbol(item, endOfItem(index, total)));
  }

  return document.groups.map((group, groupIndex) => {
    const next = document.groups[groupIndex + 1];
    const endLine = next === undefined ? total : next.line - 1;
    const children = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.group === group.number)
      .map(({ item, index }) => itemSymbol(item, endOfItem(index, endLine)));
    const done = children.filter((child) => child.detail.startsWith('✓')).length;
    return {
      name: `${group.number}. ${group.title}`.trim(),
      detail: `${done}/${children.length}`,
      kind: 'group' as const,
      line: group.line,
      endLine,
      children,
    };
  });
}

/** Число строк ссылок под каждым пунктом плана. */
function planReferenceLines(text: string): Map<number, number> {
  const result = new Map<number, number>();
  let current: number | null = null;
  splitLines(text).forEach((raw, index) => {
    if (/^##\s+\d+\./.test(raw)) current = null;
    else if (/^\s*[-*]\s*\[[^\]]*\]/.test(raw)) current = index + 1;
    else if (current !== null && /^\s*(?:↳|->)\s*\S/.test(raw)) result.set(current, (result.get(current) ?? 0) + 1);
  });
  return result;
}

/** Символ рабочей области: требование или сценарий. */
export interface WorkspaceSymbolEntry {
  readonly name: string;
  readonly kind: 'requirement' | 'scenario';
  /** Где лежит: capability, операция и change. */
  readonly container: string;
  readonly location: AuthoringLocation;
}

/** Требования и сценарии основных спеков и дельт, чьё имя содержит запрос. */
export function workspaceSymbols(sources: AuthoringSources, query: string): WorkspaceSymbolEntry[] {
  const wanted = query.trim().toLocaleLowerCase();
  const matches = (name: string): boolean => wanted === '' || name.toLocaleLowerCase().includes(wanted);
  const result: WorkspaceSymbolEntry[] = [];

  const collect = (text: string, path: string, container: (operation: DeltaOperation | null) => string, delta: boolean): void => {
    const lines = splitLines(text);
    const mask = fenceMask(lines);
    let operation: DeltaOperation | null = null;
    lines.forEach((raw, index) => {
      if (mask[index] === true) return;
      const section = RE_DELTA_SECTION.exec(raw);
      if (section?.[1] !== undefined) {
        operation = section[1] as DeltaOperation;
        return;
      }
      if (RE_SECTION.test(raw)) {
        operation = null;
        return;
      }
      if (delta && operation === null) return;
      const header = RE_REQUIREMENT_HEADER.exec(raw);
      if (header?.[2] !== undefined) {
        const name = normalizeRequirementName(header[2]);
        if (name !== '' && matches(name)) {
          result.push({ name, kind: 'requirement', container: container(operation), location: { path, line: index + 1 } });
        }
        return;
      }
      const scenario = /^####\s+Scenario:\s*(.+?)\s*$/.exec(raw);
      if (scenario?.[1] !== undefined && matches(scenario[1])) {
        result.push({ name: scenario[1], kind: 'scenario', container: container(operation), location: { path, line: index + 1 } });
      }
    });
  };

  for (const spec of sources.mainSpecs) collect(spec.text, spec.path, () => spec.capability, false);
  for (const change of sources.changes) {
    for (const delta of change.deltas) {
      collect(delta.text, delta.path, (operation) => `${delta.capability} · ${operation ?? ''} · ${change.name}`, true);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Дополнения

/** Вариант дополнения. */
export interface AuthoringCompletion {
  readonly label: string;
  /** Вставляемый текст; у шаблона — в синтаксисе сниппетов VS Code. */
  readonly insertText: string;
  readonly snippet: boolean;
  /** По чему редактор фильтрует вариант. */
  readonly filterText: string;
  readonly kind: 'section' | 'requirement' | 'reference' | 'template';
  readonly detail: string;
  readonly documentation: string | null;
  /** С какого символа строки текст заменяется вставкой. */
  readonly replaceFrom: number;
}

const SECTION_HEADERS: readonly { operation: DeltaOperation; detail: string }[] = [
  { operation: 'ADDED', detail: 'новые требования' },
  { operation: 'MODIFIED', detail: 'изменённые требования — блок целиком' },
  { operation: 'REMOVED', detail: 'удалённые требования — с Reason и Migration' },
  { operation: 'RENAMED', detail: 'переименования — FROM и TO' },
];

const REQUIREMENT_TEMPLATE =
  '### Requirement: ${1:Имя требования}\n\nСистема ДОЛЖНА (SHALL) ${2:поведение}.\n\n#### Scenario: ${3:Имя сценария}\n\n- **WHEN** ${4:условие}\n- **THEN** ${5:результат}\n';
const SCENARIO_TEMPLATE = '#### Scenario: ${1:Имя сценария}\n\n- **WHEN** ${2:условие}\n- **THEN** ${3:результат}\n';

/**
 * Дополнения в позиции курсора. `line` — с 1, `character` — с 0; текст — из
 * редактора.
 */
export function completions(
  sources: AuthoringSources,
  path: string,
  text: string,
  line: number,
  character: number,
): AuthoringCompletion[] {
  const document = documentKind(sources, path);
  if (document === null) return [];
  const current = withDocumentText(sources, path, text);
  const raw = splitLines(text)[line - 1] ?? '';
  const prefix = raw.slice(0, character);

  if (document.kind === 'plan') return planCompletions(current, document.change, prefix);

  const result: AuthoringCompletion[] = [];
  if (/^#*$/.test(prefix)) {
    result.push(
      {
        label: 'Требование со сценарием',
        insertText: REQUIREMENT_TEMPLATE,
        snippet: true,
        filterText: '### Requirement:',
        kind: 'template',
        detail: 'шаблон OpenSpec',
        documentation: 'Заголовок требования, формулировка с ДОЛЖНА (SHALL) и сценарий WHEN/THEN',
        replaceFrom: 0,
      },
      {
        label: 'Сценарий',
        insertText: SCENARIO_TEMPLATE,
        snippet: true,
        filterText: '#### Scenario:',
        kind: 'template',
        detail: 'шаблон OpenSpec',
        documentation: 'Сценарий требования с шагами WHEN/THEN',
        replaceFrom: 0,
      },
    );
  }
  if (document.kind !== 'delta') return result;

  if (/^#{0,2}\s*[A-Za-z]*$/.test(prefix) && !/^#{3}/.test(prefix)) {
    for (const header of SECTION_HEADERS) {
      const heading = `## ${header.operation} Requirements`;
      result.push({
        label: heading,
        insertText: heading,
        snippet: false,
        filterText: heading,
        kind: 'section',
        detail: header.detail,
        documentation: null,
        replaceFrom: 0,
      });
    }
  }

  const { sections, mentions } = scanDelta(text);
  const operation = operationAt(sections, line);
  const main = mainBlocks(current, document.capability);
  if (main === null || operation === null) return result;

  const header = /^(###\s+Requirement:\s*)/.exec(prefix);
  const rename = /^(\s*[-*+]?\s*FROM:\s*)(`?)(###\s*Requirement:\s*)?/.exec(prefix);
  let replaceFrom: number | null = null;
  let wrap = (name: string): string => name;
  if (header?.[1] !== undefined && (operation === 'MODIFIED' || operation === 'REMOVED')) {
    replaceFrom = header[1].length;
  } else if (rename?.[1] !== undefined && operation === 'RENAMED') {
    replaceFrom = rename[1].length;
    wrap = (name) => `\`### Requirement: ${name}\``;
  }
  if (replaceFrom === null) return result;

  const used = new Set(
    mentions
      .filter((mention) => mention.line !== line && operationAt(sections, mention.line) === operation)
      .filter((mention) => mention.role !== 'to')
      .map((mention) => mention.name),
  );
  for (const block of main.blocks) {
    if (used.has(block.name)) continue;
    result.push({
      label: block.name,
      insertText: wrap(block.name),
      snippet: false,
      filterText: prefix.slice(replaceFrom).startsWith('`') ? wrap(block.name) : block.name,
      kind: 'requirement',
      detail: `${document.capability} · сценариев: ${block.scenarios.length}`,
      documentation: block.body,
      replaceFrom,
    });
  }
  return result;
}

function planCompletions(sources: AuthoringSources, change: string, prefix: string): AuthoringCompletion[] {
  const arrow = /^(\s*(?:↳|->)\s*)/.exec(prefix);
  if (arrow?.[1] === undefined) return [];
  const replaceFrom = arrow[1].length;
  const result: AuthoringCompletion[] = [];
  for (const delta of changeOf(sources, change)?.deltas ?? []) {
    const view = buildDeltaView(delta.capability, delta.text);
    for (const group of view.groups) {
      if (group.operation !== 'ADDED' && group.operation !== 'MODIFIED') continue;
      for (const requirement of group.requirements) {
        const reference = `${delta.capability} / ${requirement.name}`;
        result.push({
          label: reference,
          insertText: reference,
          snippet: false,
          filterText: reference,
          kind: 'requirement',
          detail: `требование ${group.operation} · все сценарии: ${requirement.scenarios.length}`,
          documentation: requirement.description,
          replaceFrom,
        });
        for (const scenario of requirement.scenarios) {
          const target = `${delta.capability} / ${scenario.name}`;
          result.push({
            label: target,
            insertText: target,
            snippet: false,
            filterText: target,
            kind: 'reference',
            detail: `сценарий · ${requirement.name}`,
            documentation: scenario.steps.join('\n'),
            replaceFrom,
          });
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Проверки ссылок

/** Замечание к ссылке дельты или плана. */
export interface AuthoringIssue {
  readonly path: string;
  readonly line: number;
  readonly level: 'error' | 'warning';
  readonly code:
    | 'delta/missing-target'
    | 'delta/missing-spec'
    | 'delta/already-exists'
    | 'plan/unresolved-reference';
  readonly message: string;
  /** Похожие имена основного спека — для исправления. */
  readonly suggestions: readonly string[];
}

/**
 * Проверки ссылок всех дельт и планов источников. С `path` — только этого
 * документа.
 */
export function authoringIssues(sources: AuthoringSources, path?: string): AuthoringIssue[] {
  const only = path === undefined ? null : normalizePath(path);
  const issues: AuthoringIssue[] = [];

  for (const change of sources.changes) {
    for (const delta of change.deltas) {
      if (only !== null && normalizePath(delta.path) !== only) continue;
      issues.push(...deltaIssues(sources, delta));
    }
    const plan = change.plan;
    if (plan === null || (only !== null && normalizePath(plan.path) !== only)) continue;
    const trace = changeTrace(change);
    for (const item of trace.items) {
      for (const reference of item.references) {
        if (reference.resolved) continue;
        issues.push({
          path: plan.path,
          line: reference.line,
          level: 'warning',
          code: 'plan/unresolved-reference',
          message:
            `Ссылка «${reference.capability} / ${reference.target}» не находит ни сценария, ни требования ` +
            `ADDED или MODIFIED в дельтах change «${change.name}» — сценарий не будет считаться покрытым`,
          suggestions: [],
        });
      }
    }
  }
  return issues;
}

function deltaIssues(sources: AuthoringSources, delta: AuthoringDelta): AuthoringIssue[] {
  const main = mainBlocks(sources, delta.capability);
  const issues: AuthoringIssue[] = [];
  for (const mention of scanDelta(delta.text).mentions) {
    const needsTarget =
      (mention.role === 'header' && (mention.operation === 'MODIFIED' || mention.operation === 'REMOVED')) ||
      mention.role === 'from';
    const mustBeNew = (mention.role === 'header' && mention.operation === 'ADDED') || mention.role === 'to';
    const label = mention.role === 'header' ? mention.operation : `RENAMED ${mention.role === 'from' ? 'FROM' : 'TO'}`;

    if (needsTarget && main === null) {
      issues.push({
        path: delta.path,
        line: mention.line,
        level: 'error',
        code: 'delta/missing-spec',
        message: `${label} «${mention.name}»: основного спека «${delta.capability}» нет — изменять нечего, архивация откажет`,
        suggestions: [],
      });
      continue;
    }
    if (main === null) continue;
    const found = findBlock(main.blocks, mention.name);
    if (needsTarget && found === undefined) {
      const similar = suggestions(main.blocks, mention.name);
      issues.push({
        path: delta.path,
        line: mention.line,
        level: 'error',
        code: 'delta/missing-target',
        message:
          `${label} «${mention.name}»: такого требования нет в основном спеке «${delta.capability}», архивация откажет` +
          (similar.length > 0 ? `. Похожие: ${similar.map((name) => `«${name}»`).join(', ')}` : ''),
        suggestions: similar,
      });
    }
    if (mustBeNew && found !== undefined) {
      issues.push({
        path: delta.path,
        line: mention.line,
        level: 'error',
        code: 'delta/already-exists',
        message:
          `${label} «${mention.name}»: требование уже есть в основном спеке «${delta.capability}», архивация откажет. ` +
          'Чтобы изменить его, перенесите блок в MODIFIED',
        suggestions: [],
      });
    }
  }
  return issues;
}

function changeTrace(change: AuthoringChange): Trace {
  const views = change.deltas.map((delta) => buildDeltaView(delta.capability, delta.text));
  return buildTrace(views, change.plan?.text ?? null);
}

// ---------------------------------------------------------------------------
// Исправления

/** Действие над документом. */
export interface AuthoringAction {
  readonly title: string;
  readonly kind: 'quickfix' | 'refactor';
  readonly preferred: boolean;
  readonly edits: readonly AuthoringEdit[];
}

/** Действия для строки документа. */
export function codeActions(sources: AuthoringSources, path: string, text: string, line: number): AuthoringAction[] {
  const document = documentKind(sources, path);
  if (document?.kind !== 'delta') return [];
  const current = withDocumentText(sources, path, text);
  const main = mainBlocks(current, document.capability);
  if (main === null) return [];

  const mention = scanDelta(text).mentions.find((item) => item.line === line);
  if (mention === undefined) return [];
  const actions: AuthoringAction[] = [];
  const found = findBlock(main.blocks, mention.name);
  const needsTarget = mention.role === 'from' || (mention.role === 'header' && (mention.operation === 'MODIFIED' || mention.operation === 'REMOVED'));

  if (needsTarget && found === undefined) {
    for (const name of suggestions(main.blocks, mention.name)) {
      actions.push({
        title: `Заменить на «${name}»`,
        kind: 'quickfix',
        preferred: actions.length === 0,
        edits: [
          {
            path,
            range: { startLine: line, startCharacter: mention.nameStart, endLine: line, endCharacter: mention.nameEnd },
            newText: name,
          },
        ],
      });
    }
  }

  if (mention.role === 'header' && mention.operation === 'MODIFIED' && found !== undefined) {
    const edit = copyRequirementEdit(text, line, found.body);
    if (edit !== null) {
      actions.push({
        title: 'Скопировать требование из основного спека',
        kind: 'quickfix',
        preferred: false,
        edits: [{ path, ...edit }],
      });
    }
  }
  return actions;
}

/**
 * Правка, которая ставит в блок требования дельты тело требования основного
 * спека. Заголовок и строки вне блока не меняются. Блок — от строки после
 * заголовка до следующего заголовка требования или секции.
 */
export function copyRequirementEdit(
  text: string,
  headerLine: number,
  body: string,
): { range: AuthoringRange; newText: string } | null {
  const lines = text.split('\n');
  if (headerLine < 1 || headerLine > lines.length) return null;
  const mask = fenceMask(lines.map((line) => line.replace(/\r$/, '')));
  let next = headerLine; // индекс (с 0) строки, где блок кончился
  while (next < lines.length) {
    const raw = (lines[next] ?? '').replace(/\r$/, '');
    if (mask[next] !== true && (/^###\s+Requirement:/.test(raw) || RE_SECTION.test(raw))) break;
    next += 1;
  }
  const eol = (lines[headerLine - 1] ?? '').endsWith('\r') ? '\r\n' : '\n';
  const bodyText = body.split('\n').join(eol);

  if (next < lines.length) {
    return {
      range: { startLine: headerLine, startCharacter: (lines[headerLine - 1] ?? '').replace(/\r$/, '').length, endLine: next + 1, endCharacter: 0 },
      newText: `${eol}${eol}${bodyText}${eol}${eol}`,
    };
  }
  const lastLine = lines.length;
  const trailingNewline = text.endsWith('\n');
  return {
    range: {
      startLine: headerLine,
      startCharacter: (lines[headerLine - 1] ?? '').replace(/\r$/, '').length,
      endLine: lastLine,
      endCharacter: (lines[lastLine - 1] ?? '').length,
    },
    newText: `${eol}${eol}${bodyText}${trailingNewline ? eol : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Наведение и переход

/** Сценарии и требования, на которые указывает строка ссылки плана. */
function referenceTargets(
  sources: AuthoringSources,
  change: string,
  text: string,
  line: number,
): { capability: string; requirement: string; scenario: string | null; location: AuthoringLocation; steps: readonly string[] }[] {
  const raw = splitLines(text)[line - 1] ?? '';
  const match = /^\s*(?:↳|->)\s*(.+?)\s*$/.exec(raw);
  if (match?.[1] === undefined) return [];
  const spaced = match[1].indexOf(' / ');
  const slash = match[1].indexOf('/');
  const cut = spaced > 0 ? { at: spaced, width: 3 } : slash > 0 ? { at: slash, width: 1 } : null;
  if (cut === null) return [];
  const capability = match[1].slice(0, cut.at).trim();
  const target = normalizeName(match[1].slice(cut.at + cut.width));
  const delta = deltaOf(sources, change, capability);
  if (delta === undefined) return [];

  const view = buildDeltaView(capability, delta.text);
  const result: ReturnType<typeof referenceTargets> = [];
  for (const group of view.groups) {
    if (group.operation !== 'ADDED' && group.operation !== 'MODIFIED') continue;
    for (const requirement of group.requirements) {
      if (normalizeName(requirement.name) === target) {
        result.push({
          capability,
          requirement: requirement.name,
          scenario: null,
          location: { path: delta.path, line: requirement.line },
          steps: requirement.scenarios.flatMap((scenario) => [`#### Scenario: ${scenario.name}`, ...scenario.steps]),
        });
        continue;
      }
      for (const scenario of requirement.scenarios) {
        if (normalizeName(scenario.name) !== target) continue;
        result.push({
          capability,
          requirement: requirement.name,
          scenario: scenario.name,
          location: { path: delta.path, line: scenario.line },
          steps: scenario.steps,
        });
      }
    }
  }
  return result;
}

/** Название для сравнения ссылок — как в трассировке. */
function normalizeName(value: string): string {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[«»"'`“”„]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Текст подсказки при наведении, в markdown; `null` — подсказки нет. */
export function hover(sources: AuthoringSources, path: string, text: string, line: number): string | null {
  const document = documentKind(sources, path);
  if (document === null) return null;
  const current = withDocumentText(sources, path, text);

  if (document.kind === 'plan') {
    const targets = referenceTargets(current, document.change, text, line);
    if (targets.length === 0) return null;
    return targets
      .map((target) =>
        [
          `**${target.capability} / ${target.requirement}**${target.scenario === null ? ' — требование целиком' : ''}`,
          '',
          ...(target.scenario === null ? [] : [`#### Scenario: ${target.scenario}`]),
          ...target.steps,
        ].join('\n'),
      )
      .join('\n\n---\n\n');
  }

  if (document.kind !== 'delta') return null;
  const mention = scanDelta(text).mentions.find((item) => item.line === line);
  if (mention === undefined || mention.role === 'to' || mention.operation === 'ADDED') return null;
  const main = mainBlocks(current, document.capability);
  const found = main === null ? undefined : findBlock(main.blocks, mention.name);
  if (found === undefined) return null;
  const body = found.body.split('\n');
  const shown = body.length > 40 ? [...body.slice(0, 40), '…'] : body;
  return [`**Сейчас в основном спеке «${document.capability}»:**`, '', `### Requirement: ${found.name}`, ...shown].join('\n');
}

/** Куда ведёт переход к определению со строки. */
export function definition(sources: AuthoringSources, path: string, text: string, line: number): AuthoringLocation[] {
  const document = documentKind(sources, path);
  if (document === null) return [];
  const current = withDocumentText(sources, path, text);
  if (document.kind === 'plan') {
    return referenceTargets(current, document.change, text, line).map((target) => target.location);
  }
  if (document.kind !== 'delta') return [];
  const mention = scanDelta(text).mentions.find((item) => item.line === line);
  if (mention === undefined || mention.role === 'to' || mention.operation === 'ADDED') return [];
  const main = mainBlocks(current, document.capability);
  const found = main === null ? undefined : findBlock(main.blocks, mention.name);
  return main === null || found === undefined ? [] : [{ path: main.spec.path, line: found.line }];
}

// ---------------------------------------------------------------------------
// Подсказки над строками

/** Что делает подсказка над строкой. */
export type AuthoringLensAction =
  | { readonly kind: 'open'; readonly location: AuthoringLocation }
  | {
      readonly kind: 'add-plan-item';
      readonly change: string;
      readonly capability: string;
      readonly requirement: string;
    }
  | { readonly kind: 'none' };

/** Подсказка над строкой. */
export interface AuthoringLens {
  readonly line: number;
  readonly title: string;
  readonly action: AuthoringLensAction;
}

/** Подсказки над строками документа. */
export function codeLenses(sources: AuthoringSources, path: string, text: string): AuthoringLens[] {
  const document = documentKind(sources, path);
  if (document === null || document.kind === 'spec') return [];
  const current = withDocumentText(sources, path, text);
  const change = changeOf(current, document.change);
  if (change === undefined) return [];
  const trace = changeTrace(change);
  const lenses: AuthoringLens[] = [];

  if (document.kind === 'plan') {
    for (const item of trace.items) {
      const scenarios = trace.links.filter((link) => link.item === item.line);
      if (scenarios.length === 0) continue;
      const first = trace.scenarios.find((scenario) => scenario.key === scenarios[0]?.scenario);
      const location = first === undefined ? null : deltaOf(current, change.name, first.capability);
      lenses.push({
        line: item.line,
        title: `Покрывает сценариев: ${scenarios.length}`,
        action:
          first === undefined || location === undefined || location === null
            ? { kind: 'none' }
            : { kind: 'open', location: { path: location.path, line: first.line } },
      });
    }
    return lenses;
  }

  const main = mainBlocks(current, document.capability);
  const view = buildDeltaView(document.capability, text);
  for (const group of view.groups) {
    for (const requirement of group.requirements) {
      if (group.operation === 'ADDED' || group.operation === 'MODIFIED') {
        const keys = new Set(
          trace.scenarios
            .filter((scenario) => scenario.capability === document.capability && scenario.requirement === requirement.name)
            .map((scenario) => scenario.key),
        );
        const items = [...new Set(trace.links.filter((link) => keys.has(link.scenario)).map((link) => link.item))].sort(
          (a, b) => a - b,
        );
        if (items.length > 0 && change.plan !== null) {
          lenses.push({
            line: requirement.line,
            title: `Пунктов плана: ${items.length}`,
            action: { kind: 'open', location: { path: change.plan.path, line: items[0] ?? 1 } },
          });
        } else if (keys.size > 0 && change.plan !== null) {
          lenses.push({
            line: requirement.line,
            title: 'Не покрыт планом — добавить пункт',
            action: { kind: 'add-plan-item', change: change.name, capability: document.capability, requirement: requirement.name },
          });
        }
      }
      if (group.operation !== 'ADDED' && main !== null) {
        const found = findBlock(main.blocks, requirement.name);
        if (found !== undefined) {
          lenses.push({
            line: requirement.line,
            title: 'Основной спек',
            action: { kind: 'open', location: { path: main.spec.path, line: found.line } },
          });
        }
      }
    }
  }
  return lenses.sort((a, b) => a.line - b.line);
}
