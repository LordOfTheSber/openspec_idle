import { QUALITY_METRICS, QUALITY_METRIC_LABELS, formatQualityMetric } from '@openspec-ide/core';
import {
  CHECKS,
  type CheckFinding,
  type CheckId,
  type CheckLevel,
  type CheckReport,
  CheckUsageError,
  parseCheckList,
} from '@openspec-ide/server';

export type ReportFormat = 'text' | 'json' | 'github';

/** Разобранные аргументы команды. */
export interface CheckArgs {
  readonly root: string | null;
  readonly only: readonly CheckId[];
  readonly skip: readonly CheckId[];
  readonly format: ReportFormat;
  readonly failOn: CheckLevel;
  readonly cli: string | null;
  readonly help: boolean;
}

const FORMATS: readonly ReportFormat[] = ['text', 'json', 'github'];
const LEVELS: readonly CheckLevel[] = ['error', 'warning', 'info'];

export const USAGE = `openspec-ide-check — проверка проекта OpenSpec для CI и pre-commit

Использование: openspec-ide-check [параметры]

  --root <каталог>        откуда искать корень OpenSpec (по умолчанию текущий каталог)
  --only <список>         выполнить только эти проверки, через запятую
  --skip <список>         пропустить эти проверки
  --format <формат>       text (по умолчанию), json или github
  --fail-on <уровень>     error (по умолчанию), warning или info — с какого уровня код 1
  --cli <путь>            путь к CLI OpenSpec (иначе OPENSPEC_CLI, node_modules/.bin, PATH)
  -h, --help              эта справка

Проверки: ${CHECKS.join(', ')}

Код завершения: 0 — замечаний на уровне --fail-on и выше нет, 1 — есть,
2 — ошибка запуска.
`;

/** Разбирает аргументы; неизвестный параметр или значение — ошибка запуска. */
export function parseArgs(argv: readonly string[]): CheckArgs {
  const args = { root: null as string | null, only: [] as CheckId[], skip: [] as CheckId[], format: 'text' as ReportFormat, failOn: 'error' as CheckLevel, cli: null as string | null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? '';
    if (raw === '-h' || raw === '--help') {
      args.help = true;
      continue;
    }
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const value = (): string => {
      if (eq !== -1) return raw.slice(eq + 1);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new CheckUsageError(`Параметру ${name} нужно значение`);
      index += 1;
      return next;
    };
    switch (name) {
      case '--root':
        args.root = value();
        break;
      case '--only':
        args.only = parseCheckList(value());
        break;
      case '--skip':
        args.skip = parseCheckList(value());
        break;
      case '--format': {
        const format = value();
        if (!(FORMATS as readonly string[]).includes(format)) {
          throw new CheckUsageError(`Неизвестный формат «${format}». Доступны: ${FORMATS.join(', ')}`);
        }
        args.format = format as ReportFormat;
        break;
      }
      case '--fail-on': {
        const level = value();
        if (!(LEVELS as readonly string[]).includes(level)) {
          throw new CheckUsageError(`Неизвестный уровень «${level}». Доступны: ${LEVELS.join(', ')}`);
        }
        args.failOn = level as CheckLevel;
        break;
      }
      case '--cli':
        args.cli = value();
        break;
      default:
        throw new CheckUsageError(`Неизвестный параметр «${raw}». Справка: openspec-ide-check --help`);
    }
  }
  return args;
}

const RANK: Record<CheckLevel, number> = { error: 0, warning: 1, info: 2 };

/** Код завершения: 1, если есть замечание уровня `failOn` или серьёзнее. */
export function exitCode(report: CheckReport, failOn: CheckLevel): 0 | 1 {
  return report.findings.some((finding) => RANK[finding.level] <= RANK[failOn]) ? 1 : 0;
}

const LEVEL_TEXT: Record<CheckLevel, string> = { error: 'ошибка', warning: 'предупреждение', info: 'сведение' };

function place(finding: CheckFinding): string {
  if (finding.file === null) return '(проект)';
  return finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
}

function sorted(findings: readonly CheckFinding[]): CheckFinding[] {
  return [...findings].sort(
    (a, b) =>
      RANK[a.level] - RANK[b.level] ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/** Отчёт для человека: замечание на строку и итог по проверкам. */
export function formatText(report: CheckReport, failOn: CheckLevel): string {
  const lines = sorted(report.findings).map(
    (finding) => `${place(finding)}: ${LEVEL_TEXT[finding.level]}: ${finding.message.replace(/\s*\n\s*/g, ' ')} [${finding.check}]`,
  );
  if (lines.length > 0) lines.push('');
  return `${[...lines, summary(report, failOn)].join('\n')}\n`;
}

/** Итог по проверкам и порог. */
function summary(report: CheckReport, failOn: CheckLevel): string {
  const lines: string[] = [];
  const width = Math.max(...report.checks.map((check) => check.check.length));
  lines.push(`Проверки OpenSpec в ${report.root}:`);
  for (const check of report.checks) {
    const name = check.check.padEnd(width);
    if (check.status === 'skipped') {
      lines.push(`  ${name}  пропущена — ${check.reason ?? ''}`);
      continue;
    }
    const counts = [
      check.errors > 0 ? `ошибок ${check.errors}` : null,
      check.warnings > 0 ? `предупреждений ${check.warnings}` : null,
      check.infos > 0 ? `сведений ${check.infos}` : null,
    ].filter((part): part is string => part !== null);
    lines.push(`  ${name}  ${counts.length === 0 ? 'пройдена' : counts.join(', ')}`);
    if (check.metrics !== undefined) lines.push(`  ${' '.repeat(width)}  ${metricsLine(check.metrics)}`);
  }
  const total = (level: CheckLevel): number => report.findings.filter((finding) => finding.level === level).length;
  const code = exitCode(report, failOn);
  lines.push(
    `Ошибок: ${total('error')}, предупреждений: ${total('warning')}, сведений: ${total('info')}. ` +
      `Порог --fail-on ${failOn}: ${code === 0 ? 'проверка пройдена' : 'проверка не пройдена'}.`,
  );
  return lines.join('\n');
}

/** Метрики проверки одной строкой: «трассируемость кодов ошибок 100 %, покрытие ветвлений 50 %, …». */
function metricsLine(metrics: NonNullable<CheckReport['checks'][number]['metrics']>): string {
  return QUALITY_METRICS.filter((metric) => metric in metrics)
    .map((metric) => `${QUALITY_METRIC_LABELS[metric]} ${formatQualityMetric(metric, metrics[metric] ?? null)}`)
    .join(', ');
}

/** Отчёт одним JSON-объектом. */
export function formatJson(report: CheckReport, failOn: CheckLevel): string {
  return `${JSON.stringify({ ...report, findings: sorted(report.findings), failOn, exitCode: exitCode(report, failOn) }, null, 2)}\n`;
}

/** Аннотации GitHub Actions: `::error file=…,line=…,title=…::сообщение`. */
export function formatGithub(report: CheckReport, failOn: CheckLevel): string {
  const command: Record<CheckLevel, string> = { error: 'error', warning: 'warning', info: 'notice' };
  const lines = sorted(report.findings).map((finding) => {
    const properties = [
      finding.file === null ? null : `file=${escapeProperty(finding.file)}`,
      finding.line === null ? null : `line=${finding.line}`,
      `title=${escapeProperty(`openspec-ide/${finding.check}`)}`,
    ].filter((part): part is string => part !== null);
    return `::${command[finding.level]} ${properties.join(',')}::${escapeData(finding.message)}`;
  });
  // Итог — обычным текстом: в журнале шага он читается как у text.
  return `${[...lines, summary(report, failOn)].join('\n')}\n`;
}

function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}
