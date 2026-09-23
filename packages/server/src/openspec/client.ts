import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENSPEC_DIR } from '@openspec-ide/core';
import type { z } from 'zod';
import { type CliFailure, type CliResult, runCliJson } from './exec.js';
import {
  type ApplyInstructions,
  type ArtifactInstructions,
  type ChangeStatus,
  type ListChanges,
  type ListSpecs,
  type SchemaListEntry,
  type SchemaWhich,
  type TemplatesMap,
  type ValidateResult,
  applyInstructionsSchema,
  instructionsSchema,
  listChangesSchema,
  listSpecsSchema,
  schemaWhichSchema,
  schemasListSchema,
  statusSchema,
  templatesSchema,
  validateSchema,
} from './schemas.js';

/** Настройки клиента OpenSpec. */
export interface OpenspecClientOptions {
  /** Корень рабочего пространства — каталог, содержащий `openspec/`. */
  readonly root: string;
  /** Путь к исполняемому файлу `openspec`. */
  readonly bin: string;
  /** Предел времени на один вызов, мс. */
  readonly timeoutMs?: number;
  /** Время жизни кэша при неизменных файлах, мс. По умолчанию без предела. */
  readonly cacheTtlMs?: number;
}

export type { CliFailure, CliResult };

/** Вызов не дал результата, потому что ответ не соответствует ожидаемой схеме. */
export interface SchemaMismatch extends CliFailure {
  readonly kind: 'parse';
}

interface CacheEntry {
  readonly stamp: string;
  readonly at: number;
  readonly value: CliResult<unknown>;
}

/**
 * Единственная точка обращения к CLI OpenSpec.
 *
 * Прямые вызовы CLI из других слоёв запрещены: всё идёт через этот клиент,
 * чтобы разбор вывода, обработка ошибок и кэширование были в одном месте.
 */
export class OpenspecClient {
  readonly #options: OpenspecClientOptions;
  readonly #cache = new Map<string, CacheEntry>();
  /** Выполняющиеся вызовы: одинаковый запрос при том же состоянии файлов ждёт первый. */
  readonly #inflight = new Map<string, Promise<CliResult<unknown>>>();

  constructor(options: OpenspecClientOptions) {
    this.#options = options;
  }

  get root(): string {
    return this.#options.root;
  }

  /** Сбрасывает кэш целиком — например, когда изменились файлы на диске. */
  invalidate(): void {
    this.#cache.clear();
  }

  /** Число записей в кэше. Нужно тестам, чтобы отличить попадание от промаха. */
  get cacheSize(): number {
    return this.#cache.size;
  }

  listChanges(): Promise<CliResult<ListChanges>> {
    return this.#cached('list', ['list', '--json'], listChangesSchema);
  }

  listSpecs(): Promise<CliResult<ListSpecs>> {
    return this.#cached('list-specs', ['list', '--specs', '--json'], listSpecsSchema);
  }

  status(change: string): Promise<CliResult<ChangeStatus>> {
    return this.#cached(
      `status:${change}`,
      ['status', '--change', change, '--json'],
      statusSchema,
    );
  }

  validate(change: string, strict = true): Promise<CliResult<ValidateResult>> {
    const args = ['validate', change, '--json', ...(strict ? ['--strict'] : [])];
    return this.#cached(`validate:${change}:${strict}`, args, validateSchema, {
      allowNonZeroExit: true,
    });
  }

  instructions(artifact: string, change: string): Promise<CliResult<ArtifactInstructions>> {
    return this.#cached(
      `instructions:${change}:${artifact}`,
      ['instructions', artifact, '--change', change, '--json'],
      instructionsSchema,
    );
  }

  /** Инструкции начала работ по change: контекстные файлы и указание схемы. */
  applyInstructions(change: string): Promise<CliResult<ApplyInstructions>> {
    return this.#cached(
      `instructions:${change}:apply`,
      ['instructions', 'apply', '--change', change, '--json'],
      applyInstructionsSchema,
    );
  }

  templates(schemaName: string): Promise<CliResult<TemplatesMap>> {
    return this.#cached(
      `templates:${schemaName}`,
      ['templates', '--schema', schemaName, '--json'],
      templatesSchema,
    );
  }

  listSchemas(): Promise<CliResult<SchemaListEntry[]>> {
    return this.#cached('schemas', ['schemas', '--json'], schemasListSchema);
  }

  schemaWhich(schemaName: string): Promise<CliResult<SchemaWhich>> {
    return this.#cached(
      `schema-which:${schemaName}`,
      ['schema', 'which', schemaName, '--json'],
      schemaWhichSchema,
    );
  }

  /** Проверяет, что исполняемый файл CLI доступен, и возвращает его версию. */
  async probe(): Promise<{ available: true; version: string } | { available: false; reason: CliFailure }> {
    const result = await runCliJson<unknown>(this.#runOptions(), ['--version']);
    if (result.ok) {
      return { available: true, version: String(result.data) };
    }
    if (result.kind === 'parse') {
      // `--version` печатает не JSON, а голую строку версии.
      const version = result.stdout.trim();
      if (version !== '') return { available: true, version };
    }
    return { available: false, reason: result };
  }

  #runOptions() {
    const { bin, root, timeoutMs } = this.#options;
    return timeoutMs === undefined ? { bin, cwd: root } : { bin, cwd: root, timeoutMs };
  }

  async #cached<T>(
    key: string,
    args: readonly string[],
    schema: z.ZodType<T>,
    options: { allowNonZeroExit?: boolean } = {},
  ): Promise<CliResult<T>> {
    const stamp = await this.#stamp();
    const hit = this.#cache.get(key);
    const ttl = this.#options.cacheTtlMs;
    const fresh = hit !== undefined && hit.stamp === stamp && (ttl === undefined || Date.now() - hit.at < ttl);
    if (fresh) return hit.value as CliResult<T>;

    const flightKey = `${key}\u0000${stamp}`;
    const pending = this.#inflight.get(flightKey);
    if (pending !== undefined) return pending as Promise<CliResult<T>>;
    const call = this.#call(key, stamp, args, schema, options);
    this.#inflight.set(flightKey, call as Promise<CliResult<unknown>>);
    try {
      return await call;
    } finally {
      this.#inflight.delete(flightKey);
    }
  }

  async #call<T>(
    key: string,
    stamp: string,
    args: readonly string[],
    schema: z.ZodType<T>,
    options: { allowNonZeroExit?: boolean },
  ): Promise<CliResult<T>> {
    const raw = await runCliJson<unknown>(this.#runOptions(), args);

    // `validate` сообщает о найденных замечаниях ненулевым кодом, но при этом
    // печатает полноценный отчёт: это результат, а не отказ.
    const usable =
      raw.ok || (options.allowNonZeroExit === true && raw.kind === 'exit-code' && raw.stdout.trim() !== '');

    let value: CliResult<T>;
    if (!usable) {
      value = raw as CliFailure;
    } else {
      const payload = raw.ok ? raw.data : safeParseJson(raw.stdout);
      const parsed = schema.safeParse(payload);
      value = parsed.success
        ? { ok: true, data: parsed.data, stdout: raw.ok ? raw.stdout : raw.stdout }
        : {
            ok: false,
            kind: 'parse',
            code: raw.ok ? 0 : raw.code,
            message:
              `Ответ команды «openspec ${args.join(' ')}» не соответствует ожидаемой схеме: ` +
              parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '<корень>'}: ${issue.message}`)
                .join('; '),
            stdout: raw.stdout,
            stderr: raw.ok ? '' : raw.stderr,
          };
    }

    this.#cache.set(key, { stamp, at: Date.now(), value });
    return value;
  }

  /**
   * Отпечаток состояния каталога `openspec/`: самое позднее время изменения и
   * число файлов. Меняется при любой правке, создании и удалении.
   */
  async #stamp(): Promise<string> {
    const base = join(this.#options.root, OPENSPEC_DIR);
    let newest = 0;
    let count = 0;

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        count += 1;
        try {
          const info = await stat(full);
          if (info.mtimeMs > newest) newest = info.mtimeMs;
        } catch {
          // Файл исчез между чтением каталога и stat — отпечаток всё равно
          // изменится за счёт числа файлов при следующем обходе.
        }
      }
    };

    try {
      statSync(base);
    } catch {
      return 'no-openspec';
    }

    await walk(base);
    return `${newest}:${count}`;
  }
}

function safeParseJson(text: string): unknown {
  const start = text.search(/[[{]/);
  try {
    return JSON.parse(start <= 0 ? text : text.slice(start));
  } catch {
    return undefined;
  }
}
