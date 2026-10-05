import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  QUALITY_METRIC_LABELS,
  type ExcludedIssue,
  type QualityFileSummary,
  type QualityIssue,
  type QualityLevel,
  type QualityMetric,
  type QualityOverview,
  type QualityRule,
  type QualityRuleGroup,
  type QualityRuleSummary,
  formatQualityMetric,
} from '@openspec-ide/core';
import {
  addQualityExclusion,
  fetchQuality,
  initQuality,
  removeQualityExclusion,
  setQualityRule,
} from '../lib/api.js';
import { plural } from '../lib/format.js';
import { inVsCode } from '../lib/host.js';
import { PageActions, useNotify, useWidth } from '../lib/ui.js';
import { Icon, type IconName } from './Icon.js';

/** Уже этой ширины раздел складывается в одну колонку. */
const NARROW_BELOW_PX = 760;
/** Сколько файлов показывать до «Показать все». */
const TOP_FILES = 12;

type LevelFilter = 'all' | QualityLevel;
type Grouping = 'files' | 'rules';

const LEVEL_ICON: Record<QualityLevel, { icon: IconName; className: string; label: string }> = {
  error: { icon: 'error', className: 'bad-icon', label: 'ошибка' },
  warning: { icon: 'alert', className: 'warn-icon', label: 'предупреждение' },
  info: { icon: 'info', className: 'info-icon', label: 'сведение' },
};

const LEVEL_FORMS: Record<QualityLevel, readonly [string, string, string]> = {
  error: ['ошибка', 'ошибки', 'ошибок'],
  warning: ['предупреждение', 'предупреждения', 'предупреждений'],
  info: ['сведение', 'сведения', 'сведений'],
};

const GROUP_TITLE: Record<QualityRuleGroup, string> = {
  requirement: 'Требование',
  consistency: 'Согласованность',
  artifacts: 'Артефакты',
  metrics: 'Метрики',
};

const KIND_LABEL: Record<QualityFileSummary['kind'], string> = {
  spec: 'основной спек',
  delta: 'дельта',
  artifact: 'артефакт',
  config: 'настройки',
  code: 'файл проекта',
};

const METRICS: readonly QualityMetric[] = ['errorCodeTraceability', 'branchCoverage', 'boundaryCoverage', 'ambiguityDensity'];

const METRIC_TITLE: Record<QualityMetric, string> = {
  errorCodeTraceability: 'Трассируемость кодов ошибок',
  branchCoverage: 'Покрытие ветвлений',
  boundaryCoverage: 'Покрытие границ',
  ambiguityDensity: 'Расплывчатость',
};

const LEVEL_RANK: Record<QualityLevel | 'off', number> = { error: 0, warning: 1, info: 2, off: 3 };

/** Имя файла по пути: у спека и дельты — capability, у остальных — имя файла. */
function fileLabel(path: string): string {
  const parts = path.split('/');
  return path.endsWith('/spec.md') ? (parts.at(-2) ?? path) : (parts.at(-1) ?? path);
}

/** Короткое имя файла: capability, имя артефакта или путь. */
function shortName(file: QualityFileSummary): string {
  if (file.capability !== null) return file.capability;
  return file.path.split('/').pop() ?? file.path;
}

function LevelIcon({ level, size = 14 }: { readonly level: QualityLevel; readonly size?: number }) {
  const item = LEVEL_ICON[level];
  return (
    <span title={item.label} aria-label={item.label} role="img" className="q-level">
      <Icon name={item.icon} size={size} className={item.className} />
    </span>
  );
}

function Counts({ counts, compact = false }: { readonly counts: { error: number; warning: number; info: number }; readonly compact?: boolean }) {
  const levels = (['error', 'warning', 'info'] as const).filter((level) => counts[level] > 0);
  if (levels.length === 0) return <span className="chip ok">без замечаний</span>;
  return (
    <span className="q-counts">
      {levels.map((level) => (
        <span key={level} className={`chip ${level === 'error' ? 'bad' : level === 'warning' ? 'warn' : 'info'}`}>
          {compact ? (
            <>
              <Icon name={LEVEL_ICON[level].icon} size={12} />
              {counts[level]}
            </>
          ) : (
            plural(counts[level], LEVEL_FORMS[level])
          )}
        </span>
      ))}
    </span>
  );
}

function Meter({ value, tone, threshold }: { readonly value: number | null; readonly tone?: 'purple'; readonly threshold?: number | null }) {
  if (value === null) return <span className="muted">—</span>;
  const width = Math.max(0, Math.min(100, Math.round(value * 100)));
  const bad = threshold !== undefined && threshold !== null && value < threshold;
  return (
    <span className={['bar', 'q-meter', tone ?? null, bad ? 'low' : null].filter(Boolean).join(' ')}>
      <span className="track">
        <span className="fill" style={{ width: `${width}%` }} />
        {threshold !== undefined && threshold !== null && (
          <span className="q-threshold" style={{ left: `${threshold * 100}%` }} title={`Порог ${Math.round(threshold * 100)} %`} />
        )}
      </span>
      <span className="val">{width} %</span>
    </span>
  );
}

/**
 * Раздел «Качество»: метрики спеков, замечания линтера по файлам и по
 * правилам, уровни правил и исключения из `openspec/quality.yaml`.
 */
export function Quality({
  revision,
  focusChange,
  onClearFocus,
  onOpenFile,
}: {
  readonly revision: number;
  /** Показать только файлы этого change — переход с доски. */
  readonly focusChange: string | null;
  readonly onClearFocus: () => void;
  readonly onOpenFile: (path: string, line: number | null) => void;
}) {
  const [overview, setOverview] = useState<QualityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState<LevelFilter>('all');
  const [grouping, setGrouping] = useState<Grouping>('files');
  const [query, setQuery] = useState('');
  const [changesOnly, setChangesOnly] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [rule, setRule] = useState<QualityRule | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [allFiles, setAllFiles] = useState(false);
  const [rootRef, width] = useWidth<HTMLDivElement>();
  const notify = useNotify();
  const narrow = width !== null && width < NARROW_BELOW_PX;

  const load = useCallback(async () => {
    try {
      setOverview(await fetchQuality());
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  /** Правка настроек: ответ сервера — новая сводка. */
  const apply = useCallback(
    async (action: () => Promise<QualityOverview>, done: string) => {
      setBusy(true);
      try {
        setOverview(await action());
        setError(null);
        notify({ kind: 'ok', title: done });
      } catch (problem) {
        notify({ kind: 'bad', title: 'Настройки не изменены', detail: problem instanceof Error ? problem.message : String(problem) });
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (issue: QualityIssue): boolean => {
      if (level !== 'all' && issue.level !== level) return false;
      if (rule !== null && grouping === 'files' && issue.rule !== rule) return false;
      if (changesOnly && !issue.path.startsWith('openspec/changes/')) return false;
      if (focusChange !== null && !issue.path.startsWith(`openspec/changes/${focusChange}/`)) return false;
      if (text === '') return true;
      return [issue.message, issue.path, issue.rule, issue.requirement ?? ''].some((part) => part.toLowerCase().includes(text));
    };
  }, [query, level, rule, grouping, changesOnly, focusChange]);

  if (error !== null && overview === null) {
    return (
      <div className="section-pad">
        <p className="notice error" role="alert">
          {error}
        </p>
      </div>
    );
  }
  if (overview === null) {
    return (
      <div className="page-skeleton section-pad" aria-busy="true" aria-label="Проверка качества спеков">
        <div className="skeleton-grid">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className="skeleton" style={{ height: 76 }} />
          ))}
        </div>
        <span className="skeleton" style={{ height: 280 }} />
      </div>
    );
  }

  const vscode = inVsCode();
  const config = overview.config;
  const issues = overview.issues.filter(matches);
  const excluded = overview.excluded.filter(matches);
  const nothing = overview.files.length === 0 && overview.documents.mainSpecs === 0 && overview.documents.deltas === 0;

  const actions = (
    <PageActions>
      <span className="muted small" data-testid="quality-summary">
        {plural(overview.documents.mainSpecs, ['основной спек', 'основных спека', 'основных спеков'])} · дельты{' '}
        {plural(overview.documents.changes, ['change', 'changes', 'changes'])} · ≈ {overview.counts.words.toLocaleString('ru-RU')} слов
      </span>
      {config.exists && vscode && (
        <button type="button" className="btn" onClick={() => onOpenFile(config.path, null)} data-testid="quality-open-config">
          <Icon name="settings" size={15} />
          quality.yaml
        </button>
      )}
      <button type="button" className="icon-btn" aria-label="Пересчитать" title="Пересчитать" onClick={() => void load()}>
        <Icon name="refresh" />
      </button>
    </PageActions>
  );

  if (nothing) {
    return (
      <div className="quality section-pad" data-testid="quality">
        {actions}
        <div className="state-card" data-testid="quality-empty">
          <span className="state-icon info">
            <Icon name="shield" size={22} />
          </span>
          <h2>Спеков пока нет</h2>
          <p>
            Качество проверяется по основным спекам <code>openspec/specs/</code> и дельтам активных changes. Создайте change — замечания
            появятся, как только в нём будет дельта.
          </p>
        </div>
      </div>
    );
  }

  const ruleById = new Map(overview.rules.map((item) => [item.id, item]));
  const selectedRule = rule === null ? null : (ruleById.get(rule) ?? null);
  const fileSummary = file === null ? null : (overview.files.find((item) => item.path === file) ?? null);
  const visibleFiles = overview.files.filter((item) => {
    if (changesOnly && item.kind !== 'delta' && item.kind !== 'artifact') return false;
    if (focusChange !== null && item.change !== focusChange) return false;
    if (rule !== null || level !== 'all' || query.trim() !== '') {
      return issues.some((issue) => issue.path === item.path) || (showExcluded && excluded.some((issue) => issue.path === item.path));
    }
    return true;
  });

  const exclude = (input: { rule: QualityRule | null; path: string | null; requirement: string | null; reason: string | null }) =>
    void apply(() => addQualityExclusion(input), 'Исключение добавлено в quality.yaml');

  return (
    <div ref={rootRef} className={narrow ? 'quality narrow' : 'quality'} data-testid="quality">
      {actions}

      {focusChange !== null && (
        <p className="notice info q-focus" data-testid="quality-focus">
          Только change <b>{focusChange}</b>.{' '}
          <button type="button" className="linkish" onClick={onClearFocus}>
            Показать весь проект
          </button>
        </p>
      )}

      {overview.thresholdFailures.map((failure) => (
        <div key={failure.metric} className="notice error" role="alert" data-testid="quality-threshold">
          <p>
            <b>
              Порог не выполнен: {QUALITY_METRIC_LABELS[failure.metric]} {formatQualityMetric(failure.metric, failure.value)} при пороге{' '}
              {formatQualityMetric(failure.metric, failure.threshold)}.
            </b>{' '}
            Проверка <code>quality</code> в CI завершится с кодом 1.{' '}
            {failure.line !== null && (
              <button type="button" className="linkish mono" onClick={() => onOpenFile(config.path, failure.line)} disabled={!vscode}>
                {config.path}:{failure.line}
              </button>
            )}
          </p>
        </div>
      ))}

      {config.errors.length > 0 && (
        <div className="notice error" role="alert" data-testid="quality-config-errors">
          <p>
            <b>Ошибки в {config.path}</b> — остальные настройки действуют:
          </p>
          <ul className="failure-details">
            {config.errors.map((item, index) => (
              <li key={`${item.line ?? 0}-${index}`}>
                {item.line !== null && (
                  <button type="button" className="linkish" onClick={() => onOpenFile(config.path, item.line)} disabled={!vscode}>
                    строка {item.line}
                  </button>
                )}{' '}
                {item.message.replace(`${config.path}: `, '')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!config.exists && (
        <div className="notice info q-noconfig" data-testid="quality-no-config">
          <p>
            <b>Настроек нет — действуют умолчания.</b> Правила со словарём молчат: словарь акторов, реестр параметров и кодов ошибок,
            пороги метрик, правила артефактов и исключения задаются в <code>{config.path}</code>. Уровень правила и исключение можно
            задать и отсюда — файл создастся сам.
          </p>
          <button type="button" className="btn primary small" disabled={busy} onClick={() => void apply(initQuality, `Создан ${config.path}`)} data-testid="quality-init">
            <Icon name="plus" size={13} />
            Создать quality.yaml
          </button>
        </div>
      )}

      <div className="tiles q-tiles" data-testid="quality-metrics">
        {METRICS.map((metric) => (
          <MetricTile key={metric} metric={metric} overview={overview} />
        ))}
      </div>

      <div className="q-toolbar">
        <div className="segmented" role="group" aria-label="Уровень">
          <button type="button" aria-pressed={level === 'all'} onClick={() => setLevel('all')}>
            Все
          </button>
          {(['error', 'warning', 'info'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={level === item}
              onClick={() => setLevel(item)}
              title={LEVEL_ICON[item].label}
              data-testid={`quality-level-${item}`}
            >
              <Icon name={LEVEL_ICON[item].icon} size={13} className={LEVEL_ICON[item].className} />
              {overview.totals[item]}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Группировка">
          <button type="button" aria-pressed={grouping === 'files'} onClick={() => setGrouping('files')} data-testid="quality-by-files">
            По файлам
          </button>
          <button
            type="button"
            aria-pressed={grouping === 'rules'}
            onClick={() => {
              setGrouping('rules');
              if (rule === null) setRule(overview.rules.find((item) => total(item) > 0)?.id ?? null);
            }}
            data-testid="quality-by-rules"
          >
            По правилам
          </button>
        </div>
        <label className="field-search q-search">
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder="Текст, файл или правило"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid="quality-search"
          />
        </label>
        <label className="q-check">
          <input type="checkbox" checked={changesOnly} onChange={(event) => setChangesOnly(event.target.checked)} />
          только активные changes
        </label>
        {overview.totals.excluded > 0 && (
          <label className="q-check" data-testid="quality-show-excluded">
            <input type="checkbox" checked={showExcluded} onChange={(event) => setShowExcluded(event.target.checked)} />
            исключённые ({overview.totals.excluded})
          </label>
        )}
      </div>

      <div className="q-body">
        {(narrow ? grouping === 'rules' : grouping === 'rules' || fileSummary === null) && (
          <aside className="q-rules" aria-label="Правила">
            <div className="q-rules-head">
              <span className="section-label">Правила</span>
              {rule !== null && grouping === 'files' && (
                <button type="button" className="linkish small" onClick={() => setRule(null)}>
                  сбросить фильтр
                </button>
              )}
            </div>
            <RuleList rules={overview.rules} selected={rule} onSelect={(id) => setRule(rule === id && grouping === 'files' ? null : id)} />
          </aside>
        )}

        {grouping === 'files' ? (
          <section className={fileSummary !== null && !narrow ? 'q-main split' : 'q-main'}>
            {fileSummary === null || narrow === false ? (
              <FilesTable
                files={allFiles ? visibleFiles : visibleFiles.slice(0, TOP_FILES)}
                more={allFiles ? 0 : Math.max(0, visibleFiles.length - TOP_FILES)}
                onMore={() => setAllFiles(true)}
                selected={file}
                onSelect={(path) => setFile(file === path ? null : path)}
                narrow={narrow}
              />
            ) : null}
            {fileSummary !== null && (
              <FileDetail
                file={fileSummary}
                issues={issues.filter((issue) => issue.path === fileSummary.path)}
                excluded={showExcluded ? excluded.filter((issue) => issue.path === fileSummary.path) : []}
                overview={overview}
                busy={busy}
                onClose={() => setFile(null)}
                onOpenFile={onOpenFile}
                onExclude={exclude}
                onRemoveExclusion={(index) => void apply(() => removeQualityExclusion(index), 'Исключение снято')}
              />
            )}
          </section>
        ) : (
          <section className="q-main">
            {selectedRule === null ? (
              <p className="empty">Выберите правило слева.</p>
            ) : (
              <RuleCard
                rule={selectedRule}
                issues={issues.filter((issue) => issue.rule === selectedRule.id)}
                excluded={showExcluded ? excluded.filter((issue) => issue.rule === selectedRule.id) : []}
                overview={overview}
                busy={busy}
                onLevel={(next) =>
                  void apply(
                    () => setQualityRule(selectedRule.id, next),
                    next === null ? `Правило ${selectedRule.id}: уровень по умолчанию` : `Правило ${selectedRule.id}: ${next === 'off' ? 'выключено' : LEVEL_ICON[next].label}`,
                  )
                }
                onOpenFile={onOpenFile}
                onExclude={exclude}
                onRemoveExclusion={(index) => void apply(() => removeQualityExclusion(index), 'Исключение снято')}
              />
            )}
          </section>
        )}
      </div>

      <Exclusions overview={overview} busy={busy} onOpenFile={onOpenFile} onRemove={(index) => void apply(() => removeQualityExclusion(index), 'Исключение снято')} />
    </div>
  );
}

function total(rule: QualityRuleSummary): number {
  return rule.counts.error + rule.counts.warning + rule.counts.info;
}

function MetricTile({ metric, overview }: { readonly metric: QualityMetric; readonly overview: QualityOverview }) {
  const value = overview.metrics[metric];
  const counts = overview.counts;
  const threshold = overview.config.thresholds.find((item) => item.metric === metric) ?? null;
  const failed = overview.thresholdFailures.some((item) => item.metric === metric);
  const sub: Record<QualityMetric, string> = {
    errorCodeTraceability: counts.codesTotal === 0 ? 'в спеках нет кодов ошибок' : `${counts.codesTraced} из ${counts.codesTotal} кодов`,
    branchCoverage: counts.branchesTotal === 0 ? 'условий нет' : `${counts.branchesCovered} из ${counts.branchesTotal} условий`,
    boundaryCoverage: counts.boundariesTotal === 0 ? 'границ нет' : `${counts.boundariesCovered} из ${counts.boundariesTotal} точек`,
    ambiguityDensity: `на 100 слов · ${plural(counts.vague, ['слово', 'слова', 'слов'])}`,
  };
  const ratio = metric !== 'ambiguityDensity';
  return (
    <div className={failed ? 'tile q-tile bad' : 'tile q-tile'} data-testid={`quality-metric-${metric}`}>
      <span className="k">{METRIC_TITLE[metric]}</span>
      <span className="q-tile-value">
        <span className="v">{formatQualityMetric(metric, value)}</span>
        <span className="sub">{sub[metric]}</span>
      </span>
      {ratio && value !== null ? (
        <Meter value={value} {...(metric === 'boundaryCoverage' ? { tone: 'purple' as const } : {})} threshold={threshold?.value ?? null} />
      ) : null}
      <span className="sub muted">
        {threshold === null ? 'порог не задан' : `порог ${formatQualityMetric(metric, threshold.value)}${ratio ? ' и выше' : ' и ниже'}`}
      </span>
    </div>
  );
}

function RuleList({
  rules,
  selected,
  onSelect,
}: {
  readonly rules: readonly QualityRuleSummary[];
  readonly selected: QualityRule | null;
  readonly onSelect: (rule: QualityRule) => void;
}) {
  const [openGroups, setOpenGroups] = useState<ReadonlySet<QualityRuleGroup>>(new Set());
  const groups = (['requirement', 'consistency', 'artifacts', 'metrics'] as const).map((group) => ({
    group,
    rules: rules.filter((rule) => rule.group === group),
  }));
  return (
    <div className="q-rule-list" data-testid="quality-rules">
      {groups.map(({ group, rules: list }) => {
        // Сверху — правила с замечаниями: ошибки, предупреждения, сведения, внутри — по числу.
        const active = list
          .filter((rule) => total(rule) > 0 || rule.id === selected)
          .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || total(b) - total(a));
        const quiet = list.filter((rule) => !active.includes(rule));
        const open = openGroups.has(group);
        return (
          <div key={group} className="q-rule-group">
            <p className="q-group-label">{GROUP_TITLE[group]}</p>
            {[...active, ...(open ? quiet : [])].map((rule) => (
              <button
                key={rule.id}
                type="button"
                className={['q-rule', rule.id === selected ? 'on' : null, total(rule) === 0 ? 'quiet' : null, rule.level === 'off' ? 'off' : null]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onSelect(rule.id)}
                aria-pressed={rule.id === selected}
                data-testid={`quality-rule-${rule.id}`}
              >
                {rule.level === 'off' ? <Icon name="ban" size={13} className="muted" /> : <LevelIcon level={rule.level} size={13} />}
                <span className="q-rule-name">
                  <span className="t">{rule.title}</span>
                  <span className="mono muted">{rule.id}</span>
                </span>
                <span className={`badge ${rule.level === 'error' && total(rule) > 0 ? 'bad' : rule.level === 'warning' && total(rule) > 0 ? 'warn' : ''}`}>
                  {rule.level === 'off' ? 'выкл.' : total(rule)}
                </span>
              </button>
            ))}
            {quiet.length > 0 && (
              <button
                type="button"
                className="linkish small q-rule-more"
                onClick={() => setOpenGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group)) next.delete(group);
                  else next.add(group);
                  return next;
                })}
              >
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                {open ? 'скрыть правила без замечаний' : `ещё ${quiet.length} без замечаний`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FilesTable({
  files,
  more,
  onMore,
  selected,
  onSelect,
  narrow,
}: {
  readonly files: readonly QualityFileSummary[];
  readonly more: number;
  readonly onMore: () => void;
  readonly selected: string | null;
  readonly onSelect: (path: string) => void;
  readonly narrow: boolean;
}) {
  if (files.length === 0) return <p className="empty">Под фильтр ничего не подходит.</p>;
  if (narrow) {
    return (
      <div className="q-file-cards" data-testid="quality-files">
        {files.map((file) => (
          <button key={file.path} type="button" className="q-file-card" onClick={() => onSelect(file.path)} data-testid={`quality-file-${file.path}`}>
            <span className="q-file-card-head">
              <Icon name={file.kind === 'spec' || file.kind === 'delta' ? 'spec' : 'file'} size={14} className="muted" />
              <b>{shortName(file)}</b>
              <Counts counts={file.counts} compact />
            </span>
            <span className="muted small">
              {file.change ?? KIND_LABEL[file.kind]}
              {file.metrics?.branchCoverage !== null && file.metrics?.branchCoverage !== undefined && ` · ветвления ${Math.round(file.metrics.branchCoverage * 100)} %`}
            </span>
          </button>
        ))}
        {more > 0 && (
          <button type="button" className="linkish small" onClick={onMore}>
            ещё {plural(more, ['файл', 'файла', 'файлов'])}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="ctx-control-card q-files-card">
      <table className="ctx-control-table q-files" data-testid="quality-files">
        <thead>
          <tr>
            <th scope="col">Файл</th>
            <th scope="col" className="num">
              Требований
            </th>
            <th scope="col">Ветвления</th>
            <th scope="col">Границы</th>
            <th scope="col" className="num" title="Расплывчатых слов на 100">
              Расплывч.
            </th>
            <th scope="col">Замечания</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr
              key={file.path}
              className={file.path === selected ? 'on' : undefined}
              onClick={() => onSelect(file.path)}
              data-testid={`quality-file-${file.path}`}
            >
              <td>
                <span className="q-file-name">
                  <Icon name={file.kind === 'spec' || file.kind === 'delta' ? 'spec' : 'file'} size={14} className="muted" />
                  <span>
                    <b>{shortName(file)}</b>
                    <span className="muted small q-file-kind">
                      {KIND_LABEL[file.kind]}
                      {file.change !== null && file.kind !== 'spec' ? ` · ${file.change}` : ''}
                      {file.wholeExcluded ? ' · исключён целиком' : ''}
                    </span>
                  </span>
                </span>
              </td>
              <td className="num">{file.requirements ?? '—'}</td>
              <td>{file.metrics === null ? <span className="muted">—</span> : <Meter value={file.metrics.branchCoverage} />}</td>
              <td>{file.metrics === null ? <span className="muted">—</span> : <Meter value={file.metrics.boundaryCoverage} tone="purple" />}</td>
              <td className="num">
                {file.metrics?.ambiguityDensity === null || file.metrics === null ? (
                  <span className="muted">—</span>
                ) : (
                  <span className={file.metrics.ambiguityDensity > 0.2 ? 'warn-text mono' : 'mono'}>
                    {formatQualityMetric('ambiguityDensity', file.metrics.ambiguityDensity)}
                  </span>
                )}
              </td>
              <td>
                <Counts counts={file.counts} compact />
                {file.excluded > 0 && <span className="chip no">исключено {file.excluded}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && (
        <p className="muted small q-more">
          ещё {plural(more, ['файл', 'файла', 'файлов'])} ·{' '}
          <button type="button" className="linkish" onClick={onMore}>
            показать все
          </button>
        </p>
      )}
    </div>
  );
}

type ExcludeHandler = (input: { rule: QualityRule | null; path: string | null; requirement: string | null; reason: string | null }) => void;

/** Замечания, сгруппированные по требованию (без требования — в конце). */
function byRequirement(issues: readonly QualityIssue[]): { title: string | null; issues: QualityIssue[] }[] {
  const groups = new Map<string, QualityIssue[]>();
  for (const issue of issues) {
    const key = issue.requirement ?? '';
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  return [...groups]
    .map(([title, list]) => ({ title: title === '' ? null : title, issues: list.sort((a, b) => a.line - b.line) }))
    .sort((a, b) => (a.title === null ? 1 : b.title === null ? -1 : (a.issues[0]?.line ?? 0) - (b.issues[0]?.line ?? 0)));
}

function FileDetail({
  file,
  issues,
  excluded,
  overview,
  busy,
  onClose,
  onOpenFile,
  onExclude,
  onRemoveExclusion,
}: {
  readonly file: QualityFileSummary;
  readonly issues: readonly QualityIssue[];
  readonly excluded: readonly ExcludedIssue[];
  readonly overview: QualityOverview;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onOpenFile: (path: string, line: number | null) => void;
  readonly onExclude: ExcludeHandler;
  readonly onRemoveExclusion: (index: number) => void;
}) {
  const metrics = file.metrics;
  return (
    <section className="ctx-control-card q-detail" data-testid="quality-file-detail" aria-label={`Замечания ${file.path}`}>
      <div className="q-detail-head">
        <Icon name={file.kind === 'spec' || file.kind === 'delta' ? 'spec' : 'file'} size={16} className="muted" />
        <span className="q-detail-title">
          <b>{shortName(file)}</b>
          <span className="mono muted small">
            {file.path} · {KIND_LABEL[file.kind]}
            {file.requirements !== null && ` · ${plural(file.requirements, ['требование', 'требования', 'требований'])}`}
          </span>
        </span>
        <button type="button" className="btn small" onClick={() => onOpenFile(file.path, null)}>
          <Icon name="external" size={13} />
          Открыть файл
        </button>
        <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {metrics !== null && (
        <div className="q-detail-metrics">
          <span>
            <span className="muted small">Ветвления</span>
            <Meter value={metrics.branchCoverage} />
          </span>
          <span>
            <span className="muted small">Границы</span>
            <Meter value={metrics.boundaryCoverage} tone="purple" />
          </span>
          <span>
            <span className="muted small">Расплывчатость</span>
            <span className="mono">{formatQualityMetric('ambiguityDensity', metrics.ambiguityDensity)}</span>
          </span>
        </div>
      )}
      <div className="q-detail-counts">
        <Counts counts={file.counts} />
        {file.excluded > 0 && <span className="chip no">исключено {file.excluded}</span>}
      </div>
      {issues.length === 0 && excluded.length === 0 ? (
        <p className="empty">Под фильтр ничего не подходит.</p>
      ) : (
        byRequirement([...issues, ...excluded]).map((group) => (
          <div key={group.title ?? '—'} className="q-group">
            <p className="q-group-title">{group.title ?? 'Вне требований'}</p>
            {group.issues.map((issue) => (
              <IssueRow
                key={`${issue.rule}-${issue.line}-${issue.message}`}
                issue={issue}
                overview={overview}
                busy={busy}
                onOpenFile={onOpenFile}
                onExclude={onExclude}
                onRemoveExclusion={onRemoveExclusion}
              />
            ))}
          </div>
        ))
      )}
    </section>
  );
}

function IssueRow({
  issue,
  overview,
  busy,
  showPath = false,
  showRule = true,
  onOpenFile,
  onExclude,
  onRemoveExclusion,
}: {
  readonly issue: QualityIssue | ExcludedIssue;
  readonly overview: QualityOverview;
  readonly busy: boolean;
  readonly showPath?: boolean;
  /** Имя правила у строки — не нужно в карточке самого правила. */
  readonly showRule?: boolean;
  readonly onOpenFile: (path: string, line: number | null) => void;
  readonly onExclude: ExcludeHandler;
  readonly onRemoveExclusion: (index: number) => void;
}) {
  const [form, setForm] = useState(false);
  const [scope, setScope] = useState<'requirement' | 'file'>(issue.requirement === undefined ? 'file' : 'requirement');
  const [reason, setReason] = useState('');
  const exclusion = 'exclusion' in issue ? overview.config.exclusions[issue.exclusion] : undefined;
  const excludedIndex = 'exclusion' in issue ? issue.exclusion : null;
  const canExclude = issue.rule !== 'config' && excludedIndex === null;

  return (
    <div className={excludedIndex === null ? 'q-issue' : 'q-issue excluded'} data-testid="quality-issue" data-rule={issue.rule}>
      <LevelIcon level={issue.level} />
      <span className="mono muted q-line">стр. {issue.line}</span>
      <span className="q-issue-body">
        {showPath && <span className="mono muted small q-issue-path">{issue.path}</span>}
        <span>{issue.message}</span>
        {exclusion !== undefined && excludedIndex !== null && (
          <span className="muted small q-excluded-note">
            <Icon name="ban" size={12} /> исключено{exclusion.reason === null ? '' : `: ${exclusion.reason}`} ·{' '}
            <button type="button" className="linkish" disabled={busy} onClick={() => onRemoveExclusion(excludedIndex)}>
              снять исключение
            </button>
          </span>
        )}
        {form && (
          <span className="q-exclude-form" data-testid="quality-exclude-form">
            <span className="segmented" role="group" aria-label="Что исключить">
              {issue.requirement !== undefined && (
                <button type="button" aria-pressed={scope === 'requirement'} onClick={() => setScope('requirement')}>
                  в требовании «{issue.requirement}»
                </button>
              )}
              <button type="button" aria-pressed={scope === 'file'} onClick={() => setScope('file')}>
                во всём файле
              </button>
            </span>
            <input
              className="q-reason"
              placeholder="Причина — для ревью (необязательно)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              data-testid="quality-exclude-reason"
            />
            <button
              type="button"
              className="btn primary small"
              disabled={busy}
              onClick={() => {
                onExclude({
                  rule: issue.rule === 'config' ? null : issue.rule,
                  path: issue.path,
                  requirement: scope === 'requirement' ? (issue.requirement ?? null) : null,
                  reason: reason.trim() === '' ? null : reason.trim(),
                });
                setForm(false);
              }}
              data-testid="quality-exclude-confirm"
            >
              Исключить {issue.rule}
            </button>
            <button type="button" className="btn small" onClick={() => setForm(false)}>
              Отмена
            </button>
          </span>
        )}
      </span>
      {showRule && <span className="chip mono q-rule-chip">{issue.rule}</span>}
      {canExclude && (
        <button
          type="button"
          className="icon-btn q-act"
          aria-label="Исключить правило здесь"
          title="Исключить правило здесь"
          onClick={() => setForm(!form)}
          data-testid="quality-exclude"
        >
          <Icon name="ban" size={14} />
        </button>
      )}
      <button
        type="button"
        className="icon-btn q-act"
        aria-label={`Открыть на строке ${issue.line}`}
        title={`Открыть на строке ${issue.line}`}
        onClick={() => onOpenFile(issue.path, issue.line)}
      >
        <Icon name="external" size={14} />
      </button>
    </div>
  );
}

const LEVEL_OPTIONS: readonly { value: QualityLevel | 'off'; label: string }[] = [
  { value: 'error', label: 'ошибка' },
  { value: 'warning', label: 'предупреждение' },
  { value: 'info', label: 'сведение' },
  { value: 'off', label: 'выключено' },
];

function RuleCard({
  rule,
  issues,
  excluded,
  overview,
  busy,
  onLevel,
  onOpenFile,
  onExclude,
  onRemoveExclusion,
}: {
  readonly rule: QualityRuleSummary;
  readonly issues: readonly QualityIssue[];
  readonly excluded: readonly ExcludedIssue[];
  readonly overview: QualityOverview;
  readonly busy: boolean;
  readonly onLevel: (level: QualityLevel | 'off' | null) => void;
  readonly onOpenFile: (path: string, line: number | null) => void;
  readonly onExclude: ExcludeHandler;
  readonly onRemoveExclusion: (index: number) => void;
}) {
  const byFile = new Map<string, (QualityIssue | ExcludedIssue)[]>();
  for (const issue of [...issues, ...excluded]) byFile.set(issue.path, [...(byFile.get(issue.path) ?? []), issue]);
  const files = [...byFile].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const exclusions = overview.config.exclusions
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.rule === rule.id || item.rule === null);

  return (
    <section className="ctx-control-card q-rule-card" data-testid="quality-rule-card" data-rule={rule.id}>
      <div className="q-rule-card-head">
        <span className="q-rule-card-title">
          {rule.level === 'off' ? <Icon name="ban" size={16} className="muted" /> : <LevelIcon level={rule.level} size={16} />}
          <b>{rule.title}</b>
          <span className="chip mono">{rule.id}</span>
        </span>
        <label className="q-level-select">
          Уровень
          <select
            value={rule.configured ? rule.level : 'default'}
            disabled={busy}
            onChange={(event) => onLevel(event.target.value === 'default' ? null : (event.target.value as QualityLevel | 'off'))}
            data-testid="quality-rule-level"
          >
            <option value="default">по умолчанию — {LEVEL_ICON[rule.defaultLevel].label}</option>
            {LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="t2">{rule.description}</p>
      <p className="muted small">
        {rule.configured ? (
          <>
            Уровень задан в <span className="mono">rules</span> файла {overview.config.path}.
          </>
        ) : (
          <>Выбор уровня запишется в <span className="mono">rules</span> файла {overview.config.path}{overview.config.exists ? '' : ' — файл создастся'}.</>
        )}
      </p>
      <div className="q-detail-counts">
        <Counts counts={rule.counts} />
        {files.length > 0 && <span className="muted small">в {plural(files.length, ['файле', 'файлах', 'файлах'])}</span>}
        {rule.excluded > 0 && <span className="chip no">исключено {rule.excluded}</span>}
      </div>
      {exclusions.length > 0 && (
        <p className="muted small">
          Исключения правила:{' '}
          {exclusions.map(({ item, index }) => (
            <span key={index} className="chip no">
              {item.path ?? 'все файлы'}
              {item.requirement === null ? '' : ` · «${item.requirement}»`}
            </span>
          ))}
        </p>
      )}
      {rule.level === 'off' ? (
        <p className="empty">Правило выключено — замечаний не даёт.</p>
      ) : files.length === 0 ? (
        <p className="empty">Замечаний нет.</p>
      ) : (
        files.map(([path, list]) => (
          <div key={path} className="q-group">
            <p className="q-group-title">
              {fileLabel(path)}{' '}
              <span className="mono muted small">{path}</span>
            </p>
            {list
              .sort((a, b) => a.line - b.line)
              .map((issue) => (
                <IssueRow
                  key={`${issue.line}-${issue.message}`}
                  issue={issue}
                  overview={overview}
                  busy={busy}
                  showRule={false}
                  onOpenFile={onOpenFile}
                  onExclude={onExclude}
                  onRemoveExclusion={onRemoveExclusion}
                />
              ))}
          </div>
        ))
      )}
    </section>
  );
}

function Exclusions({
  overview,
  busy,
  onOpenFile,
  onRemove,
}: {
  readonly overview: QualityOverview;
  readonly busy: boolean;
  readonly onOpenFile: (path: string, line: number | null) => void;
  readonly onRemove: (index: number) => void;
}) {
  const list = overview.config.exclusions;
  if (list.length === 0) return null;
  const counts = new Map<number, number>();
  for (const issue of overview.excluded) counts.set(issue.exclusion, (counts.get(issue.exclusion) ?? 0) + 1);
  return (
    <section className="ctx-control-card q-exclusions" data-testid="quality-exclusions">
      <h3>Исключения</h3>
      <p className="muted small">
        Исключённые замечания не показываются в «Проблемах» и не идут в CI. Файл, исключённый целиком, не входит в метрики.
      </p>
      <table className="ctx-control-table">
        <thead>
          <tr>
            <th scope="col">Правило</th>
            <th scope="col">Где</th>
            <th scope="col">Причина</th>
            <th scope="col" className="num">
              Снято
            </th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {list.map((item, index) => (
            <tr key={index} data-testid="quality-exclusion">
              <td className="mono">{item.rule ?? 'все правила'}</td>
              <td>
                <span className="mono">{item.path ?? 'любой файл'}</span>
                {item.requirement !== null && <span className="muted"> · «{item.requirement}»</span>}
              </td>
              <td className={item.reason === null ? 'muted' : undefined}>{item.reason ?? 'не указана'}</td>
              <td className="num">{counts.get(index) ?? 0}</td>
              <td className="num">
                {item.line !== null && (
                  <button type="button" className="linkish small" onClick={() => onOpenFile(overview.config.path, item.line)}>
                    строка {item.line}
                  </button>
                )}{' '}
                <button type="button" className="btn small" disabled={busy} onClick={() => onRemove(index)} data-testid="quality-exclusion-remove">
                  Снять
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
