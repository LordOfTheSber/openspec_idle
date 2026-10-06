/**
 * Сводка качества спеков для раздела «Качество»: правила с уровнями и
 * числом замечаний, файлы с метриками, changes, невыполненные пороги и
 * исключённые замечания. Чистая функция над отчётом `specQuality` и
 * замечаниями проверок по диску.
 */
import type { AuthoringSources } from './authoring.js';
import {
  DEFAULT_QUALITY_CONFIG,
  type ExcludedIssue,
  QUALITY_RULES,
  QUALITY_RULE_INFO,
  type QualityConfigError,
  type QualityCounts,
  type QualityExclusion,
  type QualityIssue,
  type QualityLevel,
  type QualityMetric,
  type QualityMetrics,
  type QualityReport,
  type QualityRule,
  type QualityRuleGroup,
  type QualityThreshold,
  applyExclusions,
  normalizePath,
  ruleLevel,
} from './specQuality.js';

/** Число замечаний по уровням. */
export interface LevelCounts {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
}

export interface QualityRuleSummary {
  readonly id: QualityRule;
  readonly group: QualityRuleGroup;
  readonly title: string;
  readonly description: string;
  readonly defaultLevel: QualityLevel;
  /** Уровень с учётом настроек; `off` — правило выключено. */
  readonly level: QualityLevel | 'off';
  /** Уровень задан в `rules` настроек. */
  readonly configured: boolean;
  readonly counts: LevelCounts;
  /** Сколько замечаний правила снято исключениями. */
  readonly excluded: number;
}

export type QualityFileKind = 'spec' | 'delta' | 'artifact' | 'config' | 'code';

export interface QualityFileSummary {
  readonly path: string;
  readonly kind: QualityFileKind;
  readonly capability: string | null;
  readonly change: string | null;
  /** Требований — у спеков и дельт. */
  readonly requirements: number | null;
  /** Метрики — у спеков и дельт. */
  readonly metrics: QualityMetrics | null;
  readonly counts: LevelCounts;
  readonly excluded: number;
  /** Файл исключён целиком — в сводные метрики не входит. */
  readonly wholeExcluded: boolean;
}

export interface QualityThresholdFailure {
  readonly metric: QualityMetric;
  readonly value: number;
  readonly threshold: number;
  readonly line: number | null;
}

export interface QualityOverview {
  readonly config: {
    /** Путь файла настроек от корня. */
    readonly path: string;
    /** Файл настроек есть. */
    readonly exists: boolean;
    readonly scope: 'all' | 'changes';
    readonly errors: readonly QualityConfigError[];
    readonly exclusions: readonly QualityExclusion[];
    readonly thresholds: readonly QualityThreshold[];
  };
  readonly metrics: QualityMetrics;
  readonly counts: QualityCounts;
  readonly totals: LevelCounts & { readonly excluded: number };
  readonly documents: { readonly mainSpecs: number; readonly changes: number; readonly deltas: number };
  readonly rules: readonly QualityRuleSummary[];
  readonly files: readonly QualityFileSummary[];
  readonly issues: readonly QualityIssue[];
  readonly excluded: readonly ExcludedIssue[];
  readonly changes: readonly ({ readonly name: string } & LevelCounts)[];
  readonly thresholdFailures: readonly QualityThresholdFailure[];
}

const QUALITY_PATH = 'openspec/quality.yaml';

function emptyLevels(): { error: number; warning: number; info: number } {
  return { error: 0, warning: 0, info: 0 };
}

const RANK: Record<QualityLevel, number> = { error: 0, warning: 1, info: 2 };

/**
 * Собирает сводку раздела. `project` — замечания проверок по диску (ссылки на
 * тесты, сверка с кодом) до исключений: исключения применяются здесь.
 */
export function qualityOverview(
  sources: AuthoringSources,
  report: QualityReport,
  project: readonly QualityIssue[] = [],
): QualityOverview {
  const config = sources.quality ?? DEFAULT_QUALITY_CONFIG;
  const fromProject = applyExclusions(project, config);
  const issues = [...report.issues, ...fromProject.kept].sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || RANK[a.level] - RANK[b.level],
  );
  const excluded = [...report.excluded, ...fromProject.excluded];

  const rules: QualityRuleSummary[] = (Object.keys(QUALITY_RULES) as QualityRule[]).map((id) => {
    const counts = emptyLevels();
    for (const issue of issues) if (issue.rule === id) counts[issue.level] += 1;
    const info = QUALITY_RULE_INFO[id];
    return {
      id,
      group: info.group,
      title: info.title,
      description: info.description,
      defaultLevel: QUALITY_RULES[id],
      level: ruleLevel(config, id),
      configured: config.levels[id] !== undefined,
      counts,
      excluded: excluded.filter((issue) => issue.rule === id).length,
    };
  });

  const mainPaths = new Set(sources.mainSpecs.map((spec) => normalizePath(spec.path)));
  const deltaPaths = new Map<string, string>();
  for (const change of sources.changes) for (const delta of change.deltas) deltaPaths.set(normalizePath(delta.path), change.name);
  const reports = new Map(report.files.map((file) => [normalizePath(file.path), file]));
  const files = new Map<string, { counts: { error: number; warning: number; info: number }; excluded: number }>();
  const touch = (path: string) => {
    const key = normalizePath(path);
    let entry = files.get(key);
    if (entry === undefined) {
      entry = { counts: emptyLevels(), excluded: 0 };
      files.set(key, entry);
    }
    return entry;
  };
  for (const issue of issues) touch(issue.path).counts[issue.level] += 1;
  for (const issue of excluded) touch(issue.path).excluded += 1;
  for (const file of report.files) touch(file.path);

  const changeOf = (path: string): string | null => /^openspec\/changes\/([^/]+)\//.exec(path)?.[1] ?? null;
  const summaries: QualityFileSummary[] = [...files].map(([path, entry]) => {
    const file = reports.get(path);
    const kind: QualityFileKind = mainPaths.has(path)
      ? 'spec'
      : deltaPaths.has(path)
        ? 'delta'
        : path === normalizePath(config.path ?? QUALITY_PATH)
          ? 'config'
          : changeOf(path) !== null
            ? 'artifact'
            : 'code';
    return {
      path,
      kind,
      capability: file?.capability ?? null,
      change: file?.change ?? deltaPaths.get(path) ?? changeOf(path),
      requirements: file?.requirements ?? null,
      metrics: file?.metrics ?? null,
      counts: entry.counts,
      excluded: entry.excluded,
      wholeExcluded: file?.excluded ?? false,
    };
  });
  // Сверху — файлы с ошибками, затем по числу предупреждений и сведений.
  summaries.sort(
    (a, b) =>
      b.counts.error - a.counts.error || b.counts.warning - a.counts.warning || b.counts.info - a.counts.info || a.path.localeCompare(b.path),
  );

  const changes = new Map<string, { error: number; warning: number; info: number }>();
  for (const change of sources.changes) changes.set(change.name, emptyLevels());
  for (const issue of issues) {
    const name = changeOf(normalizePath(issue.path));
    const entry = name === null ? undefined : changes.get(name);
    if (entry !== undefined) entry[issue.level] += 1;
  }

  const thresholdFailures: QualityThresholdFailure[] = [];
  for (const threshold of config.thresholds) {
    const value = report.metrics[threshold.metric];
    if (value === null) continue;
    const failed = threshold.metric === 'ambiguityDensity' ? value > threshold.value : value < threshold.value;
    if (failed) thresholdFailures.push({ metric: threshold.metric, value, threshold: threshold.value, line: threshold.line });
  }

  const totals = { ...emptyLevels(), excluded: excluded.length };
  for (const issue of issues) totals[issue.level] += 1;

  return {
    config: {
      path: config.path ?? QUALITY_PATH,
      exists: config.path !== null,
      scope: config.scope,
      errors: config.errors,
      exclusions: config.exclusions,
      thresholds: config.thresholds,
    },
    metrics: report.metrics,
    counts: report.counts,
    totals,
    documents: {
      mainSpecs: config.scope === 'all' ? sources.mainSpecs.length : 0,
      changes: sources.changes.filter((change) => change.deltas.length > 0).length,
      deltas: sources.changes.reduce((sum, change) => sum + change.deltas.length, 0),
    },
    rules,
    files: summaries,
    issues,
    excluded,
    changes: [...changes].map(([name, counts]) => ({ name, ...counts })),
    thresholdFailures,
  };
}
