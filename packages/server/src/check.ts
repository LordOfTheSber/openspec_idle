import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  type AuthoringSources,
  type ContextMap,
  type DriftReport,
  type Trace,
  type WorkspaceTree,
  authoringIssues,
  driftFindings,
} from '@openspec-ide/core';
import { type EmbeddedBackend, createEmbeddedBackend } from './embedded.js';
import { resolveOpenspecRoot } from './fs/workspace.js';
import type { SpecValidationRun, ValidationEntry, ValidationRun } from './validation.js';
import type { RegistryEntry, SchemaCheck } from './schemaRegistry.js';
import type { StructureReport } from './structure.js';

/** Проверки команды `openspec-ide-check` в порядке выполнения. */
export const CHECKS = ['validate', 'archived', 'structure', 'context', 'schemas', 'authoring', 'coverage', 'drift'] as const;

export type CheckId = (typeof CHECKS)[number];

/** Проверки, которым нужен CLI OpenSpec. */
const NEEDS_CLI: ReadonlySet<CheckId> = new Set(['validate', 'archived', 'schemas', 'authoring', 'coverage', 'drift']);

export type CheckLevel = 'error' | 'warning' | 'info';

/** Одно замечание. */
export interface CheckFinding {
  readonly check: CheckId;
  readonly level: CheckLevel;
  /** Путь относительно корня проекта, через `/`; `null` — к проекту в целом. */
  readonly file: string | null;
  readonly line: number | null;
  readonly message: string;
}

/** Итог одной проверки. */
export interface CheckSummary {
  readonly check: CheckId;
  readonly status: 'passed' | 'failed' | 'skipped';
  /** Почему пропущена. */
  readonly reason: string | null;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

/** Отчёт команды. */
export interface CheckReport {
  readonly root: string;
  readonly findings: readonly CheckFinding[];
  readonly checks: readonly CheckSummary[];
}

/** Ошибка запуска — код завершения 2, а не найденные замечания. */
export class CheckUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckUsageError';
  }
}

export interface CheckOptions {
  /** Каталог, от которого ищется корень OpenSpec (как у CLI — вверх по дереву). */
  readonly cwd: string;
  readonly only?: readonly CheckId[];
  readonly skip?: readonly CheckId[];
  /** Путь к CLI OpenSpec; без него — поиск, как в расширении. */
  readonly cliPath?: string | null;
}

/** Разбирает список проверок через запятую; неизвестная — ошибка запуска. */
export function parseCheckList(value: string): CheckId[] {
  const ids = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  for (const id of ids) {
    if (!(CHECKS as readonly string[]).includes(id)) {
      throw new CheckUsageError(`Неизвестная проверка «${id}». Доступны: ${CHECKS.join(', ')}`);
    }
  }
  return ids as CheckId[];
}

type Outcome = { readonly findings: CheckFinding[] } | { readonly skipped: string };

/**
 * Выполняет проверки проекта теми же маршрутами встроенного бэкенда, что
 * показывает расширение: правила CI и IDE не расходятся.
 */
export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const resolution = resolveOpenspecRoot(options.cwd);
  if (resolution.kind !== 'found') {
    throw new CheckUsageError(`В «${options.cwd}» и выше по дереву нет каталога openspec/. Заведите проект: openspec init`);
  }
  const root = resolution.root;
  const selected = CHECKS.filter(
    (id) => (options.only === undefined || options.only.length === 0 || options.only.includes(id)) && !(options.skip ?? []).includes(id),
  );

  // Проверка только читает проект: без наблюдателя и без записи метрик.
  const backend = await createEmbeddedBackend({ root, watch: false, metrics: false, cliPath: options.cliPath ?? null });
  try {
    const workspace = (await backend.request('GET', '/api/workspace')).body as
      | { state: 'ready'; tree: WorkspaceTree }
      | { state: 'cli-missing'; notice?: { title: string; hint: string } }
      | { state: 'not-initialized' };
    const needsCli = selected.filter((id) => NEEDS_CLI.has(id));
    if (workspace.state === 'cli-missing' && needsCli.length > 0) {
      const hint = workspace.notice === undefined ? '' : ` ${workspace.notice.hint}`;
      throw new CheckUsageError(
        `Не найден CLI OpenSpec, а он нужен проверкам ${needsCli.join(', ')}. ` +
          `Установите его: npm install -D @fission-ai/openspec, укажите путь в OPENSPEC_CLI или --cli, ` +
          `либо пропустите их: --skip ${needsCli.join(',')}.${hint}`,
      );
    }
    const tree = workspace.state === 'ready' ? workspace.tree : null;
    const context: RunContext = { backend, root, tree, authoring: null };

    const findings: CheckFinding[] = [];
    const checks: CheckSummary[] = [];
    for (const id of selected) {
      const outcome = await RUNNERS[id](context);
      if ('skipped' in outcome) {
        checks.push({ check: id, status: 'skipped', reason: outcome.skipped, errors: 0, warnings: 0, infos: 0 });
        continue;
      }
      findings.push(...outcome.findings);
      const count = (level: CheckLevel): number => outcome.findings.filter((item) => item.level === level).length;
      checks.push({
        check: id,
        status: count('error') > 0 ? 'failed' : 'passed',
        reason: null,
        errors: count('error'),
        warnings: count('warning'),
        infos: count('info'),
      });
    }
    return { root, findings, checks };
  } finally {
    await backend.close();
  }
}

interface RunContext {
  readonly backend: EmbeddedBackend;
  readonly root: string;
  readonly tree: WorkspaceTree | null;
  authoring: AuthoringSources | null;
}

async function get<T>(context: RunContext, path: string): Promise<T> {
  const reply = await context.backend.request('GET', path);
  if (reply.status < 200 || reply.status >= 300) {
    const error = (reply.body as { error?: string } | null)?.error ?? `код ${reply.status}`;
    throw new Error(`${path}: ${error}`);
  }
  return reply.body as T;
}

async function sources(context: RunContext): Promise<AuthoringSources> {
  context.authoring ??= await get<AuthoringSources>(context, '/api/authoring');
  return context.authoring;
}

const LEVEL: Record<ValidationEntry['level'], CheckLevel> = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

function fromValidation(check: CheckId, run: Omit<ValidationRun, 'change'>, what: string): CheckFinding[] {
  if (run.error !== null) return [{ check, level: 'error', file: null, line: null, message: `${what}: проверка не выполнилась — ${run.error}` }];
  return run.entries.map((entry) => ({ check, level: LEVEL[entry.level], file: entry.file, line: entry.line, message: entry.message }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const RUNNERS: Record<CheckId, (context: RunContext) => Promise<Outcome>> = {
  async validate(context) {
    const findings: CheckFinding[] = [];
    for (const change of context.tree?.changes ?? []) {
      const run = await get<ValidationRun>(context, `/api/validate?change=${encodeURIComponent(change.name)}`);
      findings.push(
        ...fromValidation('validate', run, `change «${change.name}»`).map((finding) =>
          finding.file === null ? { ...finding, file: `openspec/changes/${change.name}` } : finding,
        ),
      );
    }
    findings.push(...fromValidation('validate', await get<SpecValidationRun>(context, '/api/validate/specs'), 'основные спеки'));
    return { findings };
  },

  async archived(context) {
    if ((context.tree?.archived.length ?? 0) === 0) return { skipped: 'архив пуст' };
    return { findings: fromValidation('archived', await get<SpecValidationRun>(context, '/api/validate/archived'), 'архив') };
  },

  async structure(context) {
    const report = await get<StructureReport>(context, '/api/structure');
    if (!report.configured) return { skipped: `нет ${report.path}` };
    const findings: CheckFinding[] = report.errors.map((error) => ({
      check: 'structure' as const,
      level: 'error' as const,
      file: report.path,
      line: error.line,
      message: `Описание структуры: ${error.message}`,
    }));
    for (const issue of report.issues) {
      // Лишний файл — на самом файле, остальное — на строке правила, как в панели «Проблемы».
      const onFile = issue.kind === 'unexpected' && issue.actual === 'file';
      findings.push({
        check: 'structure',
        level: 'error',
        file: onFile ? issue.path : report.path,
        line: onFile ? null : issue.line,
        message: onFile ? `${issue.message} (правило — ${report.path}${issue.line === null ? '' : `:${issue.line}`})` : issue.message,
      });
    }
    return { findings };
  },

  async context(context) {
    const map = await get<ContextMap>(context, '/api/context-map');
    if (!map.configured) return { skipped: 'нет openspec/context/modules и openspec/context/adr' };
    return {
      findings: map.issues.map((issue) => ({
        check: 'context' as const,
        level: issue.severity,
        file: issue.path,
        line: issue.line,
        message: issue.message,
      })),
    };
  },

  async schemas(context) {
    const { schemas } = await get<{ schemas: RegistryEntry[] }>(context, '/api/schemas');
    const project = schemas.filter((entry) => entry.source === 'project');
    if (project.length === 0) return { skipped: 'нет собственных схем в openspec/schemas/' };
    const findings: CheckFinding[] = [];
    for (const entry of project) {
      const file = await schemaFile(context.root, entry.path);
      if (!entry.readable) {
        findings.push({ check: 'schemas', level: 'error', file, line: null, message: `Схема «${entry.name}» не разбирается: ${entry.parseError ?? 'ошибка YAML'}` });
        continue;
      }
      const result = await get<SchemaCheck>(context, `/api/schema/check?name=${encodeURIComponent(entry.name)}`);
      for (const issue of result.structural.issues) {
        findings.push({
          check: 'schemas',
          level: issue.level.toUpperCase() === 'ERROR' ? 'error' : 'warning',
          file,
          line: null,
          message: `Схема «${entry.name}»${issue.artifact === undefined ? '' : `, артефакт ${issue.artifact}`}: ${issue.message}`,
        });
      }
      for (const violation of result.sdd.violations) {
        findings.push({
          check: 'schemas',
          level: violation.level === 'error' ? 'error' : 'warning',
          file,
          line: null,
          message: `Схема «${entry.name}» · ${violation.rule}${violation.artifact === null ? '' : ` · ${violation.artifact}`}: ${violation.message}`,
        });
      }
    }
    return { findings };
  },

  async authoring(context) {
    return {
      findings: authoringIssues(await sources(context)).map((issue) => ({
        check: 'authoring' as const,
        level: issue.level,
        file: issue.path,
        line: issue.line,
        message: issue.message,
      })),
    };
  },

  async coverage(context) {
    const all = await sources(context);
    const findings: CheckFinding[] = [];
    let checked = 0;
    for (const change of context.tree?.changes ?? []) {
      const view = await get<{ planPath: string | null; trace: Trace }>(context, `/api/trace?change=${encodeURIComponent(change.name)}`);
      // Пока в плане нет пунктов, change ещё планируется — покрытие спрашивать рано.
      if (view.planPath === null || view.trace.items.length === 0) continue;
      checked += 1;
      const covered = new Set(view.trace.covered);
      const deltas = all.changes.find((item) => item.name === change.name)?.deltas ?? [];
      for (const scenario of view.trace.scenarios) {
        if (covered.has(scenario.key)) continue;
        findings.push({
          check: 'coverage',
          level: 'warning',
          file: deltas.find((delta) => delta.capability === scenario.capability)?.path ?? null,
          line: scenario.line,
          message:
            `Сценарий «${scenario.name}» (${scenario.capability} / ${scenario.requirement}) не покрыт ни одним пунктом плана ` +
            `change «${change.name}». Добавьте пункт со строкой «↳ ${scenario.capability} / ${scenario.name}»`,
        });
      }
    }
    return checked === 0 ? { skipped: 'нет changes с пунктами плана' } : { findings };
  },

  async drift(context) {
    if ((context.tree?.changes.length ?? 0) === 0) return { skipped: 'нет активных changes' };
    const report = await get<DriftReport>(context, '/api/drift');
    return {
      findings: driftFindings(report).map((finding) => ({
        check: 'drift' as const,
        level: finding.level,
        file: finding.path,
        line: finding.line,
        message: finding.message,
      })),
    };
  },
};

/** Файл схемы относительно корня. */
async function schemaFile(root: string, path: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : join(root, path);
  const file = absolute.endsWith('.yaml') || absolute.endsWith('.yml') ? absolute : join(absolute, 'schema.yaml');
  const relativePath = relative(root, (await exists(file)) ? file : absolute);
  return relativePath.replaceAll('\\', '/');
}
