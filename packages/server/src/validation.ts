import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENSPEC_DIR, parseSpecMarkdown, sameHeader } from '@openspec-ide/core';
import type { CliRunOptions } from './openspec/exec.js';
import { runCliJson } from './openspec/exec.js';
import { type ValidateResult, validateSchema } from './openspec/schemas.js';

/** Одно замечание валидации, уже привязанное к месту в проекте. */
export interface ValidationEntry {
  readonly level: 'ERROR' | 'WARNING' | 'INFO';
  readonly message: string;
  /** Путь файла относительно корня рабочего пространства; `null`, если неизвестен. */
  readonly file: string | null;
  /** Строка в файле; `null`, если CLI её не сообщил. */
  readonly line: number | null;
}

/** Итог одного прогона валидации. */
export interface ValidationRun {
  readonly change: string;
  readonly entries: readonly ValidationEntry[];
  readonly valid: boolean;
  /** Прогон вытеснен более свежим запросом. */
  readonly superseded: boolean;
  /** Ошибка запуска, если валидация вообще не отработала. */
  readonly error: string | null;
  readonly finishedAt: number;
}

/**
 * Запускает валидацию так, чтобы виден был результат последнего запроса.
 *
 * Сохранение артефакта перезапускает валидацию, и при быстрых правках прогоны
 * накладываются. Показывать результат того, который просто завершился позже,
 * нельзя: он может относиться к уже устаревшему содержимому. Поэтому новый
 * запрос прерывает предыдущий.
 */
export class ValidationRunner {
  readonly #options: CliRunOptions;
  readonly #inFlight = new Map<string, AbortController>();

  constructor(options: CliRunOptions) {
    this.#options = options;
  }

  /** Число выполняющихся прогонов — нужно тестам. */
  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  async run(change: string): Promise<ValidationRun> {
    const outcome = await this.#run(change, ['validate', change, '--json', '--strict'], (report) =>
      this.#changeEntries(change, report),
    );
    return { change, ...outcome };
  }

  /**
   * Проверяет все основные спеки одним прогоном CLI. Замечания ложатся на
   * файлы `openspec/specs/<capability>/spec.md`.
   */
  async runSpecs(): Promise<SpecValidationRun> {
    let specCount = 0;
    const outcome = await this.#run(SPECS_KEY, ['validate', '--specs', '--json', '--strict'], async (report) => {
      specCount = report.items.length;
      return this.#specEntries(report);
    });
    return { ...outcome, specCount };
  }

  /**
   * Проверяет, что у архивных changes выполнены все пункты плана
   * (`validate --archived`). Замечания ложатся на файлы в архиве.
   */
  async runArchived(): Promise<SpecValidationRun> {
    let specCount = 0;
    const outcome = await this.#run(ARCHIVED_KEY, ['validate', '--archived', '--json'], async (report) => {
      specCount = report.items.length;
      return report.items.flatMap((item) =>
        item.issues.map((issue) => ({
          level: normalizeLevel(issue.level),
          message: issue.message,
          file:
            issue.path === undefined || issue.path === '' || issue.path === 'file'
              ? `${OPENSPEC_DIR}/changes/archive/${item.id}`
              : `${OPENSPEC_DIR}/changes/archive/${item.id}/${issue.path.replaceAll('\\', '/')}`,
          line: extractLine(issue.message),
        })),
      );
    });
    return { ...outcome, specCount };
  }

  async #run(
    key: string,
    args: readonly string[],
    toEntries: (report: ValidateResult) => Promise<ValidationEntry[]>,
  ): Promise<Omit<ValidationRun, 'change'>> {
    this.#inFlight.get(key)?.abort();

    const controller = new AbortController();
    this.#inFlight.set(key, controller);

    const result = await runCliJson<unknown>({ ...this.#options, signal: controller.signal }, [...args]);

    const superseded = { entries: [], valid: false, superseded: true, error: null, finishedAt: Date.now() };
    // Запрос вытеснен более свежим — его результат показывать нельзя.
    if (this.#inFlight.get(key) === controller) {
      this.#inFlight.delete(key);
    } else {
      return superseded;
    }
    if (!result.ok && result.kind === 'aborted') return superseded;

    // Ненулевой код у `validate` означает найденные замечания, а не сбой:
    // отчёт при этом всё равно напечатан.
    const payload = result.ok ? result.data : parseJson(result.stdout);
    const parsed = validateSchema.safeParse(payload);

    if (!parsed.success) {
      return {
        entries: [],
        valid: false,
        superseded: false,
        error: result.ok ? 'Отчёт валидации не соответствует ожидаемой схеме' : result.message,
        finishedAt: Date.now(),
      };
    }

    return {
      entries: sortEntries(await toEntries(parsed.data)),
      valid: parsed.data.items.every((item) => item.valid),
      superseded: false,
      error: null,
      finishedAt: Date.now(),
    };
  }

  async #changeEntries(change: string, report: ValidateResult): Promise<ValidationEntry[]> {
    const entries: ValidationEntry[] = [];
    const texts = new Map<string, string | null>();
    for (const item of report.items) {
      for (const issue of item.issues) {
        const file = await this.#resolveFile(change, issue.path);
        let line = extractLine(issue.message);
        const name = requirementNameFromMessage(issue.message);
        if (line === null && file !== null && name !== null) {
          if (!texts.has(file)) texts.set(file, await this.#read(file));
          const text = texts.get(file) ?? null;
          line = text === null ? null : requirementLine(text, name);
        }
        entries.push({ level: normalizeLevel(issue.level), message: issue.message, file, line });
      }
    }
    return entries;
  }

  async #specEntries(report: ValidateResult): Promise<ValidationEntry[]> {
    const entries: ValidationEntry[] = [];
    for (const item of report.items) {
      if (item.issues.length === 0) continue;
      const file = `${OPENSPEC_DIR}/specs/${item.id}/spec.md`;
      const text = await this.#read(file);
      for (const issue of item.issues) {
        entries.push({
          level: normalizeLevel(issue.level),
          message: issue.message,
          file,
          line: text === null ? null : specIssueLine(text, issue.path),
        });
      }
    }
    return entries;
  }

  /**
   * Файл замечания change. CLI называет файл то от каталога change
   * (`proposal.md`), то от каталога дельт (`data-export/spec.md`), то словом
   * `file`; берётся тот вариант, который есть на диске.
   */
  async #resolveFile(change: string, path: string | undefined): Promise<string | null> {
    const candidates = fileCandidates(change, path);
    for (const candidate of candidates) {
      if ((await this.#read(candidate)) !== null) return candidate;
    }
    return candidates[0] ?? null;
  }

  async #read(relative: string): Promise<string | null> {
    try {
      return await readFile(join(this.#options.cwd, relative), 'utf8');
    } catch {
      return null;
    }
  }
}

/** Ключ прогона по основным спекам — не пересекается с именами changes. */
const SPECS_KEY = '\u0000specs';
const ARCHIVED_KEY = '\u0000archived';

/** Итог проверки основных спеков. */
export interface SpecValidationRun extends Omit<ValidationRun, 'change'> {
  /** Сколько элементов проверил CLI: спеков или архивных changes. */
  readonly specCount: number;
}

function sortEntries(entries: ValidationEntry[]): ValidationEntry[] {
  const order = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  return entries.sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * Строка замечания основного спека по пути в модели CLI.
 *
 * `requirements[2]` и `requirements.2.scenarios` — третье требование файла,
 * `overview` и `purpose` — раздел назначения. Путь, который не узнан, строки
 * не даёт.
 */
export function specIssueLine(text: string, path: string | undefined): number | null {
  if (path === undefined) return null;
  const index = /^requirements(?:\[(\d+)\]|\.(\d+))/.exec(path);
  if (index !== null) {
    const position = Number(index[1] ?? index[2]);
    return parseSpecMarkdown(text).requirements[position]?.line ?? null;
  }
  if (/^(overview|purpose)\b/i.test(path)) {
    const line = text.split('\n').findIndex((raw) => /^##\s+Purpose\s*$/i.test(raw));
    return line === -1 ? null : line + 1;
  }
  return null;
}

/**
 * Имя требования, которое называет замечание CLI: `MODIFIED "Имя"`,
 * `header "### Requirement: Имя"`, `Requirement "Имя"`.
 */
export function requirementNameFromMessage(message: string): string | null {
  const header = /"###\s*Requirement:\s*([^"]+)"/.exec(message);
  if (header?.[1] !== undefined) return header[1].trim();
  const named = /\b(?:ADDED|MODIFIED|REMOVED|RENAMED|Requirement)\s+"([^"]+)"/.exec(message);
  return named?.[1]?.trim() ?? null;
}

/** Строка заголовка требования в тексте спека или дельты; `null`, если его нет. */
export function requirementLine(text: string, name: string): number | null {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^###\s+Requirement:\s*(.+?)\s*$/.exec(lines[index] ?? '');
    if (match?.[1] !== undefined && sameHeader(match[1], name)) return index + 1;
  }
  return null;
}

function normalizeLevel(level: string): ValidationEntry['level'] {
  const upper = level.toUpperCase();
  return upper === 'ERROR' || upper === 'WARNING' ? upper : 'INFO';
}

function fileCandidates(change: string, path: string | undefined): string[] {
  if (path === undefined || path === '' || path === 'file') return [];
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('openspec/')) return [normalized];
  const dir = `openspec/changes/${change}`;
  return [`${dir}/${normalized}`, `${dir}/specs/${normalized}`];
}

function extractLine(message: string): number | null {
  const match = /(?::|строка\s+|line\s+)(\d+)\b/i.exec(message);
  if (match?.[1] === undefined) return null;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function parseJson(text: string): unknown {
  const start = text.search(/[[{]/);
  try {
    return JSON.parse(start <= 0 ? text : text.slice(start));
  } catch {
    return undefined;
  }
}
