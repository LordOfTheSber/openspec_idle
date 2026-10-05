/**
 * Согласованность спеков между собой, с артефактами change, с тестами и с
 * кодом — продолжение проверки качества (`specQuality.ts`) за пределами одного
 * требования.
 *
 * Модуль чистый. То, что нужно читать с диска или из git, — файлы тестов из
 * плана, код модулей домена, спеки базовой ревизии, — сервер готовит заранее
 * и передаёт сюда данными.
 *
 * Строки — с 1.
 */
import type { AuthoringSources } from './authoring.js';
import { fenceMask } from './specChange.js';
import {
  DEFAULT_QUALITY_CONFIG,
  QUALITY_METRICS,
  QUALITY_METRIC_LABELS,
  type QualityConfig,
  type QualityIssue,
  type QualityReport,
  type QualityRule,
  type Requirement,
  type Scenario,
  bounds,
  formatQualityMetric,
  normalizePath,
  parseDocument,
  ruleLevel,
  sentences,
} from './specQuality.js';

function push(issues: QualityIssue[], config: QualityConfig, rule: QualityRule, path: string, line: number, message: string): void {
  const level = ruleLevel(config, rule);
  if (level !== 'off') issues.push({ path, line, level, rule, message });
}

function quote(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Противоречия и дубли сценариев

/** Текст шага для сравнения: регистр, «ё», `код`, кавычки и пунктуация не важны. */
function normalizeStep(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[`«»"'“”„]/g, '')
    .replace(/[^\p{L}\p{N}_\s./-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '');
}

interface ScenarioEntry {
  readonly path: string;
  readonly capability: string;
  readonly change: string | null;
  readonly requirement: string;
  readonly scenario: Scenario;
  readonly when: string;
  readonly then: string;
}

function entryLabel(entry: ScenarioEntry): string {
  return `«${entry.scenario.name}» (${entry.capability} / ${entry.requirement}${entry.change === null ? '' : `, change ${entry.change}`})`;
}

/**
 * Сценарии с одинаковыми WHEN (с GIVEN): в одном требовании разные THEN —
 * противоречие, в разных требованиях — пересечение, которое стоит сверить;
 * одинаковые THEN — дубль. Дельта и основной спек одной capability, дельты
 * разных changes одной capability друг с другом не сравниваются: это версии
 * одного спека, их сводит архивация, а пересечения changes показывает drift.
 */
export function scenarioConsistency(
  documents: readonly { readonly path: string; readonly capability: string; readonly change: string | null; readonly requirements: readonly Requirement[] }[],
  config: QualityConfig = DEFAULT_QUALITY_CONFIG,
  only: string | null = null,
): QualityIssue[] {
  const groups = new Map<string, ScenarioEntry[]>();
  for (const document of documents) {
    for (const requirement of document.requirements) {
      for (const scenario of requirement.scenarios) {
        const when = scenario.steps
          .filter((step) => step.keyword !== 'THEN')
          .map((step) => normalizeStep(step.text))
          .join(' | ');
        if (when === '') continue;
        const then = [...new Set(scenario.steps.filter((step) => step.keyword === 'THEN').map((step) => normalizeStep(step.text)))]
          .sort()
          .join(' | ');
        const list = groups.get(when) ?? [];
        list.push({ path: document.path, capability: document.capability, change: document.change, requirement: requirement.name, scenario, when, then });
        groups.set(when, list);
      }
    }
  }

  const issues: QualityIssue[] = [];
  const sameRequirement = (a: ScenarioEntry, b: ScenarioEntry): boolean =>
    a.path === b.path && a.requirement === b.requirement;
  // Дельта повторяет основной спек своей capability (MODIFIED, RENAMED), дельты разных changes
  // одной capability сводит архивация: такие пары — одно требование в разных версиях.
  const copies = (a: ScenarioEntry, b: ScenarioEntry): boolean =>
    a.path !== b.path && a.capability === b.capability && (a.change !== null || b.change !== null);

  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    for (const entry of entries) {
      if (only !== null && normalizePath(entry.path) !== only) continue;
      const others = entries.filter((other) => other !== entry && !copies(entry, other));
      // Внутри требования — по одному замечанию на пару: у второго сценария.
      const inside = others.find((other) => sameRequirement(entry, other) && other.scenario.line < entry.scenario.line);
      if (inside !== undefined) {
        if (inside.then === entry.then) {
          push(issues, config, 'scenario-duplicate', entry.path, entry.scenario.line,
            `Сценарий «${entry.scenario.name}» повторяет сценарий «${inside.scenario.name}» того же требования — и WHEN, и THEN`);
        } else {
          push(issues, config, 'scenario-conflict', entry.path, entry.scenario.line,
            `Сценарий «${entry.scenario.name}» и сценарий «${inside.scenario.name}» требования «${entry.requirement}» ` +
              'начинаются с одного WHEN, но ожидают разное — противоречие или один сценарий, разделённый на два');
        }
        continue;
      }
      const outside = others.find((other) => !sameRequirement(entry, other));
      if (outside === undefined) continue;
      if (outside.then === entry.then) {
        push(issues, config, 'scenario-duplicate', entry.path, entry.scenario.line,
          `Сценарий «${entry.scenario.name}» дословно повторяет сценарий ${entryLabel(outside)}: при правке одного второй разойдётся с ним`);
      } else {
        push(issues, config, 'scenario-overlap', entry.path, entry.scenario.line,
          `Сценарий «${entry.scenario.name}» начинается с того же WHEN, что и ${entryLabel(outside)}, но ожидает другое — ` +
            'сверьте, что исходы не противоречат друг другу');
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Исполняемые правила артефактов

interface Unit {
  readonly line: number;
  readonly label: string;
  readonly text: string;
}

const DEFAULT_HEADING = '^#{2,3}\\s';
const PLAN_ITEM = /^\s*[-*]\s+\[[ xX]\]\s*(.*)$/;

/** Разделы файла: заголовок и текст до следующего; раздел без текста не проверяется. */
function sectionUnits(text: string, heading: string | null): Unit[] {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const mask = fenceMask(lines);
  const re = new RegExp(heading ?? DEFAULT_HEADING, 'u');
  const units: { line: number; label: string; body: string[] }[] = [];
  lines.forEach((line, index) => {
    if (mask[index] !== true && re.test(line)) {
      units.push({ line: index + 1, label: line.replace(/^#+\s*/, ''), body: [line] });
    } else {
      units.at(-1)?.body.push(line);
    }
  });
  return units
    .filter((unit) => unit.body.slice(1).some((line) => line.trim() !== ''))
    .map((unit) => ({ line: unit.line, label: unit.label, text: unit.body.join('\n') }));
}

/** Пункты плана с продолжением — строками до следующего пункта или заголовка. */
function itemUnits(text: string): Unit[] {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const mask = fenceMask(lines);
  const units: { line: number; label: string; body: string[] }[] = [];
  let open = false;
  lines.forEach((line, index) => {
    const item = mask[index] === true ? null : PLAN_ITEM.exec(line);
    if (item !== null) {
      units.push({ line: index + 1, label: item[1] ?? '', body: [line] });
      open = true;
    } else if (/^#{1,6}\s/.test(line)) {
      open = false;
    } else if (open) {
      units.at(-1)?.body.push(line);
    }
  });
  return units.map((unit) => ({ line: unit.line, label: unit.label, text: unit.body.join('\n') }));
}

/**
 * Проверяет файлы артефактов активных changes исполняемыми правилами
 * настроек: «у каждого решения design есть альтернатива», «у каждого пункта
 * плана есть проверка».
 */
export function artifactRuleIssues(sources: AuthoringSources, only: string | null = null): QualityIssue[] {
  const config = sources.quality ?? DEFAULT_QUALITY_CONFIG;
  if (config.artifactRules.length === 0) return [];
  const issues: QualityIssue[] = [];
  const configured = ruleLevel(config, 'artifact-rule');
  if (configured === 'off') return [];
  for (const change of sources.changes) {
    for (const file of change.artifacts ?? []) {
      if (only !== null && normalizePath(file.path) !== only) continue;
      for (const rule of config.artifactRules) {
        if (rule.artifact !== file.id) continue;
        const units: Unit[] =
          rule.each === 'file'
            ? [{ line: 1, label: file.path.split('/').pop() ?? file.path, text: file.text }]
            : rule.each === 'section'
              ? sectionUnits(file.text, rule.heading)
              : itemUnits(file.text);
        const require = rule.require === null ? null : new RegExp(rule.require, 'iu');
        const forbid = rule.forbid === null ? null : new RegExp(rule.forbid, 'iu');
        for (const unit of units) {
          const failed = (require !== null && !require.test(unit.text)) || (forbid !== null && forbid.test(unit.text));
          if (!failed) continue;
          issues.push({
            path: file.path,
            line: unit.line,
            level: rule.level ?? configured,
            rule: 'artifact-rule',
            message: `${rule.message}: «${quote(unit.label)}» (правило «${rule.id}» в ${config.path ?? 'настройках'})`,
          });
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Ссылки плана на тесты

/** Файл теста: `*.test.ts`, `*.spec.tsx`, `*_test.go`, `FooTest.java`, `test_foo.py`… */
export const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.(?:go|py)|Tests?\.(?:java|kt|cs|scala)|(?:^|\/)test_[^/]+\.py)$/;

/** Ссылка пункта плана на тест: файл и, если указаны, имена тестов в «кавычках». */
export interface PlanTestRef {
  /** План, в котором ссылка. */
  readonly path: string;
  readonly line: number;
  /** Файл теста от корня проекта. */
  readonly file: string;
  /** Имена тестов; имя с «…» на конце — начало имени. */
  readonly names: readonly string[];
}

/** «…» с вложенными «…» — до парной закрывающей кавычки. */
function balancedQuote(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '«') return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '«') depth += 1;
    else if (text[index] === '»') {
      depth -= 1;
      if (depth === 0) return { value: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

/** Ссылки на тесты в планах активных changes: `` `файл.test.ts` «имя», «имя» ``. */
export function planTestReferences(sources: AuthoringSources): PlanTestRef[] {
  const refs: PlanTestRef[] = [];
  for (const change of sources.changes) {
    const plan = change.plan;
    if (plan === null) continue;
    const lines = plan.text.split('\n').map((line) => line.replace(/\r$/, ''));
    const mask = fenceMask(lines);
    lines.forEach((line, index) => {
      if (mask[index] === true) return;
      for (const match of line.matchAll(/`([^`\s]+)`/g)) {
        const file = (match[1] ?? '').replace(/^\.\//, '');
        if (!file.includes('/') || !TEST_FILE.test(file)) continue;
        const names: string[] = [];
        let cursor = (match.index ?? 0) + match[0].length;
        for (;;) {
          const gap = /^\s*(?:,|и|and)?\s*/u.exec(line.slice(cursor))?.[0] ?? '';
          const quoted = balancedQuote(line, cursor + gap.length);
          if (quoted === null) break;
          names.push(quoted.value.trim());
          cursor = quoted.end;
        }
        refs.push({ path: plan.path, line: index + 1, file, names });
      }
    });
  }
  return refs;
}

/**
 * Проверяет ссылки плана на тесты по текстам файлов (`null` — файла нет):
 * файл есть, и в нём есть тест с таким именем. Имя с «…» на конце ищется как
 * начало.
 */
export function planTestRefIssues(
  refs: readonly PlanTestRef[],
  files: ReadonlyMap<string, string | null>,
  config: QualityConfig = DEFAULT_QUALITY_CONFIG,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const ref of refs) {
    const text = files.get(ref.file) ?? null;
    if (text === null) {
      push(issues, config, 'plan-test-ref', ref.path, ref.line, `Пункт плана ссылается на тест \`${ref.file}\`, а такого файла нет`);
      continue;
    }
    const missing = ref.names.filter((name) => {
      const needle = name.replace(/\s*(?:…|\.\.\.)$/, '').trim();
      return needle !== '' && !text.includes(needle);
    });
    if (missing.length > 0) {
      push(issues, config, 'plan-test-ref', ref.path, ref.line,
        `В \`${ref.file}\` нет ${missing.length === 1 ? 'теста' : 'тестов'} ${missing.map((name) => `«${quote(name, 80)}»`).join(', ')} — ` +
          'тест переименован или удалён, и пункт плана больше не говорит, чем проверен');
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Спека ↔ код модулей домена

/** Код модулей, у которых capability в поле `domains` карты контекста. */
export interface DomainCode {
  readonly capability: string;
  readonly modules: readonly string[];
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

/**
 * Самый длинный постоянный кусок цитаты: числа, «…», `<имя>`, `{имя}` и N в
 * цитате — переменные. Кусок из одного слова (`design.md`, «Контроль») — имя,
 * а не сообщение: его не ищем.
 */
function stableFragment(quoted: string): string | null {
  const fragments = quoted
    .split(/\d+(?:[.,]\d+)?|…|\.\.\.|<[^>]*>|\{[^}]*\}|(?<![\p{L}])[NXМ](?![\p{L}])/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8 && /\s/.test(part));
  if (fragments.length === 0) return null;
  return fragments.reduce((best, part) => (part.length > best.length ? part : best));
}

/** Число литералом в коде: `8000`, `8_000`, для процентов — и доля `0.3`. */
function numberVariants(value: number): string[] {
  const plain = String(value);
  const variants = [plain];
  if (Number.isInteger(value) && Math.abs(value) >= 1000) variants.push(plain.replace(/\B(?=(\d{3})+(?!\d))/g, '_'));
  if (value > 1 && value <= 100) variants.push(String(value / 100));
  return variants;
}

/**
 * Сверяет спеки с кодом модулей их домена: цитата сообщения из THEN должна
 * находиться в коде (`code-message`), число-граница из текста требования —
 * литералом (`code-constant`). Спеки без модулей в карте контекста не
 * проверяются.
 */
export function specCodeIssues(sources: AuthoringSources, code: readonly DomainCode[]): QualityIssue[] {
  const config = sources.quality ?? DEFAULT_QUALITY_CONFIG;
  const byCapability = new Map(code.map((item) => [item.capability, item]));
  const issues: QualityIssue[] = [];
  const documents = [
    ...(config.scope === 'all' ? sources.mainSpecs.map((spec) => ({ ...spec, change: null as string | null })) : []),
    ...sources.changes.flatMap((change) => change.deltas.map((delta) => ({ ...delta, change: change.name as string | null }))),
  ];
  const corpusCache = new Map<string, string>();
  for (const source of documents) {
    const domain = byCapability.get(source.capability);
    if (domain === undefined || domain.files.length === 0) continue;
    let corpus = corpusCache.get(source.capability);
    if (corpus === undefined) {
      corpus = domain.files.map((file) => file.text).join('\n');
      corpusCache.set(source.capability, corpus);
    }
    const where = `модулей ${domain.modules.join(', ')} домена «${source.capability}»`;
    const document = parseDocument(source.path, source.capability, source.change, source.text);
    for (const requirement of document.requirements) {
      if (requirement.operation === 'REMOVED' || requirement.operation === 'RENAMED') continue;
      for (const scenario of requirement.scenarios) {
        for (const step of scenario.steps) {
          if (step.keyword !== 'THEN') continue;
          for (const match of step.text.matchAll(/«([^«»]+)»/g)) {
            const fragment = stableFragment(match[1] ?? '');
            if (fragment === null || corpus.includes(fragment)) continue;
            push(issues, config, 'code-message', source.path, step.line,
              `Цитата «${quote(match[1] ?? '', 70)}» из THEN сценария «${scenario.name}» не найдена в коде ${where}: ` +
                'сообщение изменилось в коде или в спеке, либо модуль, который его показывает, не связан с доменом');
          }
        }
      }
      const reported = new Set<number>();
      for (const sentence of sentences(requirement.description)) {
        for (const bound of bounds(sentence.text)) {
          for (const point of bound.points) {
            const value = point.operand.value;
            if (value === null || Math.abs(value) <= 2 || reported.has(value)) continue;
            reported.add(value);
            const found = numberVariants(value).some((variant) =>
              new RegExp(`(?<![\\w.])${variant.replace('.', '\\.')}(?![\\w])`).test(corpus as string),
            );
            if (!found) {
              push(issues, config, 'code-constant', source.path, sentence.line,
                `Граница ${value} из текста требования «${requirement.name}» не найдена литералом в коде ${where}: ` +
                  'значение могло измениться в коде, или оно вычисляется');
            }
          }
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Регресс относительно базовой ревизии

/** Правила, чьи замечания считаются долгом качества; пороги и регресс — нет. */
function debtRules(issue: QualityIssue): boolean {
  return issue.level !== 'info' && issue.rule !== 'metric-threshold' && issue.rule !== 'metric-regression' && issue.rule !== 'config';
}

/**
 * Сравнивает отчёт качества с отчётом базовой ревизии: метрика хуже —
 * регресс; предупреждений и ошибок качества стало больше — регресс с
 * разбивкой по правилам. Возвращает сообщения.
 */
export function metricRegressions(current: QualityReport, baseline: QualityReport, ref: string): string[] {
  const messages: string[] = [];
  for (const metric of QUALITY_METRICS) {
    const now = current.metrics[metric];
    const before = baseline.metrics[metric];
    if (now === null || before === null) continue;
    const worse = metric === 'ambiguityDensity' ? now > before + 1e-9 : now < before - 1e-9;
    if (worse) {
      messages.push(
        `Метрика «${QUALITY_METRIC_LABELS[metric]}» ухудшилась относительно ${ref}: ` +
          `${formatQualityMetric(metric, before)} → ${formatQualityMetric(metric, now)}`,
      );
    }
  }
  const count = (report: QualityReport): Map<string, number> => {
    const result = new Map<string, number>();
    for (const issue of report.issues.filter(debtRules)) result.set(issue.rule, (result.get(issue.rule) ?? 0) + 1);
    return result;
  };
  const nowCounts = count(current);
  const beforeCounts = count(baseline);
  const total = (counts: Map<string, number>): number => [...counts.values()].reduce((sum, value) => sum + value, 0);
  if (total(nowCounts) > total(beforeCounts)) {
    const grown = [...nowCounts]
      .map(([rule, value]) => [rule, value - (beforeCounts.get(rule) ?? 0)] as const)
      .filter(([, delta]) => delta > 0)
      .map(([rule, delta]) => `${rule} +${delta}`);
    messages.push(
      `Предупреждений и ошибок качества спеков стало больше, чем в ${ref}: ${total(beforeCounts)} → ${total(nowCounts)}` +
        (grown.length > 0 ? ` (${grown.join(', ')})` : ''),
    );
  }
  return messages;
}
