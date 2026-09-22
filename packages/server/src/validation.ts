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
    this.#inFlight.get(change)?.abort();

    const controller = new AbortController();
    this.#inFlight.set(change, controller);

    const result = await runCliJson<unknown>(
      { ...this.#options, signal: controller.signal },
      ['validate', change, '--json', '--strict'],
    );

    // Запрос вытеснен более свежим — его результат показывать нельзя.
    if (this.#inFlight.get(change) === controller) {
      this.#inFlight.delete(change);
    } else {
      return {
        change,
        entries: [],
        valid: false,
        superseded: true,
        error: null,
        finishedAt: Date.now(),
      };
    }

    if (!result.ok && result.kind === 'aborted') {
      return {
        change,
        entries: [],
        valid: false,
        superseded: true,
        error: null,
        finishedAt: Date.now(),
      };
    }

    // Ненулевой код у `validate` означает найденные замечания, а не сбой:
    // отчёт при этом всё равно напечатан.
    const payload = result.ok ? result.data : parseJson(result.stdout);
    const parsed = validateSchema.safeParse(payload);

    if (!parsed.success) {
      return {
        change,
        entries: [],
        valid: false,
        superseded: false,
        error: result.ok ? 'Отчёт валидации не соответствует ожидаемой схеме' : result.message,
        finishedAt: Date.now(),
      };
    }

    return {
      change,
      entries: toEntries(change, parsed.data),
      valid: parsed.data.items.every((item) => item.valid),
      superseded: false,
      error: null,
      finishedAt: Date.now(),
    };
  }
}

/**
 * Приводит замечания к виду «файл и строка».
 *
 * CLI кладёт в `path` то относительный путь файла, то слово `file` без
 * уточнения, а строку не сообщает вовсе. Номер строки извлекается из текста
 * сообщения, если он там есть, и остаётся `null`, когда его нет: выдумывать
 * строку, чтобы «переход куда-нибудь» работал, хуже, чем честно её не знать.
 */
function toEntries(change: string, report: ValidateResult): ValidationEntry[] {
  const entries: ValidationEntry[] = [];

  for (const item of report.items) {
    for (const issue of item.issues) {
      const level = normalizeLevel(issue.level);
      const file = resolveFile(change, issue.path);
      entries.push({ level, message: issue.message, file, line: extractLine(issue.message) });
    }
  }

  const order = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  return entries.sort((a, b) => order[a.level] - order[b.level]);
}

function normalizeLevel(level: string): ValidationEntry['level'] {
  const upper = level.toUpperCase();
  return upper === 'ERROR' || upper === 'WARNING' ? upper : 'INFO';
}

function resolveFile(change: string, path: string | undefined): string | null {
  if (path === undefined || path === '' || path === 'file') return null;
  if (path.startsWith('openspec/')) return path;
  return `openspec/changes/${change}/${path}`;
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
