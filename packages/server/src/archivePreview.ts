import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  OPENSPEC_DIR,
  type RenamePair,
  type SpecChange,
  describeSpecChange,
  renamePairs,
} from '@openspec-ide/core';
import { runCli } from './openspec/exec.js';

/** Префикс временных каталогов предпросмотра — по нему их видно в tmp. */
export const PREVIEW_DIR_PREFIX = 'openspec-ide-preview-';

/** Код отказа CLI, означающий, что архивацию остановила проверка change. */
const VALIDATION_FAILED = 'archive_validation_failed';

/** Change с таким именем нет среди активных. */
export class UnknownChangeError extends Error {
  constructor(readonly change: string) {
    super(`Изменение «${change}» не найдено среди активных`);
    this.name = 'UnknownChangeError';
  }
}

/** Замечание CLI, остановившее архивацию. */
export interface ArchiveProblem {
  readonly code: string | null;
  readonly message: string;
  /** Подсказка CLI, как исправить. */
  readonly fix: string | null;
}

/** Основной спек, который архивация создаст или изменит. */
export interface SpecPreview extends SpecChange {
  /** Путь capability относительно `openspec/specs/`. */
  readonly capability: string;
  /** Путь файла спека относительно корня рабочего пространства. */
  readonly path: string;
  /** Текущий текст спека; `null`, если capability ещё нет. */
  readonly before: string | null;
  /** Текст спека после архивации. */
  readonly after: string;
}

/**
 * Исход предпросмотра:
 * - `ready` — архивация пройдёт;
 * - `validation-failed` — её остановит проверка, спеки показаны такими, какими
 *   их сделает архивация после исправления ошибок;
 * - `refused` — CLI откажет по другой причине, спеков после архивации нет.
 */
export type ArchiveOutcome = 'ready' | 'validation-failed' | 'refused';

/** Предпросмотр архивации change. */
export interface ArchivePreview {
  readonly change: string;
  readonly outcome: ArchiveOutcome;
  readonly problems: readonly ArchiveProblem[];
  /** Вывод CLI целиком, если его не удалось разобрать. */
  readonly output: string;
  /** Предупреждения CLI, с которыми архивация всё же проходит. */
  readonly warnings: readonly string[];
  /** Итоги CLI по операциям; `null`, если архивация не выполнилась даже в копии. */
  readonly totals: {
    readonly added: number;
    readonly modified: number;
    readonly removed: number;
    readonly renamed: number;
  } | null;
  readonly specs: readonly SpecPreview[];
}

/** Что сообщает `openspec archive --json`. */
interface ArchiveJson {
  readonly archive?: {
    readonly totals?: { added?: number; modified?: number; removed?: number; renamed?: number };
    readonly warnings?: readonly unknown[];
  } | null;
  readonly status?: readonly { severity?: string; code?: string; message?: string; fix?: string }[];
}

/** Один прогон архивации во временной копии. */
type SandboxRun =
  | {
      readonly ok: true;
      readonly totals: NonNullable<ArchivePreview['totals']>;
      readonly warnings: string[];
      readonly specs: Map<string, string>;
    }
  | { readonly ok: false; readonly problems: ArchiveProblem[]; readonly output: string };

/**
 * Строит предпросмотр архивации настоящим CLI на временной копии.
 *
 * Своей реализации слияния дельт здесь нет и быть не должно: правила слияния
 * принадлежат CLI, и только его прогон гарантирует, что предпросмотр совпадёт
 * с архивацией.
 */
export class ArchivePreviewService {
  readonly #root: string;
  readonly #bin: string;

  constructor(root: string, bin: string) {
    this.#root = root;
    this.#bin = bin;
  }

  async preview(change: string): Promise<ArchivePreview> {
    const changeDir = await this.#changeDir(change);

    let run = await this.#runInSandbox(change, []);
    let outcome: ArchiveOutcome = 'ready';
    let problems: ArchiveProblem[] = [];
    let output = '';

    if (!run.ok) {
      problems = run.problems;
      output = run.output;
      if (problems.some((problem) => problem.code === VALIDATION_FAILED)) {
        // Архивацию остановит проверка, но пользователю всё равно важно
        // увидеть, что станет со спеками после исправления ошибок.
        outcome = 'validation-failed';
        run = await this.#runInSandbox(change, ['--no-validate']);
        if (!run.ok) {
          outcome = 'refused';
          problems = [...problems, ...run.problems];
          output = run.output;
        }
      } else {
        outcome = 'refused';
      }
    }

    if (!run.ok) {
      return { change, outcome, problems, output, warnings: [], totals: null, specs: [] };
    }

    const renames = await this.#renamesByCapability(changeDir);
    const current = await readSpecs(join(this.#root, OPENSPEC_DIR, 'specs'));
    const specs: SpecPreview[] = [];
    for (const [capability, after] of [...run.specs].sort(([a], [b]) => a.localeCompare(b))) {
      const before = current.get(capability) ?? null;
      if (before === after) continue;
      specs.push({
        capability,
        path: `${OPENSPEC_DIR}/specs/${capability}/spec.md`,
        before,
        after,
        ...describeSpecChange(before, after, renames.get(capability) ?? []),
      });
    }

    return { change, outcome, problems, output, warnings: run.warnings, totals: run.totals, specs };
  }

  /** Каталог активного change; имя не должно выводить за пределы `changes/`. */
  async #changeDir(change: string): Promise<string> {
    if (change === '' || change === 'archive' || /[\\/]/.test(change) || change.startsWith('.')) {
      throw new UnknownChangeError(change);
    }
    const dir = join(this.#root, OPENSPEC_DIR, 'changes', change);
    try {
      if (!(await stat(dir)).isDirectory()) throw new UnknownChangeError(change);
    } catch (error) {
      if (error instanceof UnknownChangeError) throw error;
      throw new UnknownChangeError(change);
    }
    return dir;
  }

  async #runInSandbox(change: string, extra: readonly string[]): Promise<SandboxRun> {
    const sandbox = await mkdtemp(join(tmpdir(), PREVIEW_DIR_PREFIX));
    try {
      await copyForArchive(join(this.#root, OPENSPEC_DIR), join(sandbox, OPENSPEC_DIR), change);

      const result = await runCli(
        // Предпросмотр — не архивация: считать его ею в телеметрии CLI нельзя.
        { bin: this.#bin, cwd: sandbox, env: { OPENSPEC_TELEMETRY: '0' } },
        ['archive', change, '--yes', '--json', ...extra],
      );
      const output = `${result.stdout}\n${result.stderr}`.trim();
      const parsed = parseArchiveJson(result.stdout);

      if (result.code === 0 && parsed?.archive !== null && parsed?.archive !== undefined) {
        const totals = parsed.archive.totals ?? {};
        return {
          ok: true,
          totals: {
            added: totals.added ?? 0,
            modified: totals.modified ?? 0,
            removed: totals.removed ?? 0,
            renamed: totals.renamed ?? 0,
          },
          warnings: (parsed.archive.warnings ?? []).filter((item): item is string => typeof item === 'string'),
          specs: await readSpecs(join(sandbox, OPENSPEC_DIR, 'specs')),
        };
      }

      const problems = (parsed?.status ?? [])
        .filter((entry) => entry.severity === undefined || entry.severity === 'error')
        .map((entry) => ({
          code: entry.code ?? null,
          message: entry.message ?? 'CLI не сообщил причину',
          fix: entry.fix ?? null,
        }));
      return {
        ok: false,
        problems:
          problems.length > 0
            ? problems
            : [
                {
                  code: null,
                  message:
                    parsed === null
                      ? 'Вывод openspec archive не разбирается как JSON'
                      : `openspec archive завершился с кодом ${result.code ?? 'неизвестно'}`,
                  fix: null,
                },
              ],
        output,
      };
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }

  /** Пары RENAMED из дельт change по capability. */
  async #renamesByCapability(changeDir: string): Promise<Map<string, RenamePair[]>> {
    const deltas = await readSpecs(join(changeDir, 'specs'));
    return new Map([...deltas].map(([capability, text]) => [capability, renamePairs(text)]));
  }
}

/**
 * Копирует `openspec/` для прогона архивации одного change.
 *
 * CLI нужны конфигурация, схемы проекта и основные спеки; чужие changes и
 * архив ему не нужны, а архив со временем растёт.
 */
async function copyForArchive(source: string, target: string, change: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'changes') continue;
    await cp(join(source, entry.name), join(target, entry.name), { recursive: true });
  }
  await mkdir(join(target, 'changes', 'archive'), { recursive: true });
  await cp(join(source, 'changes', change), join(target, 'changes', change), { recursive: true });
}

/** Все `spec.md` под каталогом: путь capability → текст. */
async function readSpecs(dir: string): Promise<Map<string, string>> {
  const specs = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name === 'spec.md' && current !== dir) {
        specs.set(relative(dir, current).split(sep).join('/'), await readFile(full, 'utf8'));
      }
    }
  };
  await walk(dir);
  return specs;
}

function parseArchiveJson(stdout: string): ArchiveJson | null {
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  try {
    const value: unknown = JSON.parse(stdout.slice(start));
    return typeof value === 'object' && value !== null ? (value as ArchiveJson) : null;
  } catch {
    return null;
  }
}
