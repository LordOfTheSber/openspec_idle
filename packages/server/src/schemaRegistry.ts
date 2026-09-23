import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ConformanceReport,
  OPENSPEC_DIR,
  type SchemaDocument,
  type SchemaPreview,
  checkConformance,
  previewSchema,
  schemaFromPlain,
} from '@openspec-ide/core';
import { LineCounter, parseDocument } from 'yaml';
import { resolveInsideWorkspace } from './http/paths.js';
import type { OpenspecClient } from './openspec/client.js';
import { runCli, runCliJson } from './openspec/exec.js';
import { schemaValidateSchema } from './openspec/schemas.js';

/** Ошибка операции над схемой; текст предназначен пользователю. */
export class SchemaOperationError extends Error {
  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'SchemaOperationError';
  }
}

/** Схема в реестре. */
export interface RegistryEntry {
  readonly name: string;
  readonly description: string | null;
  readonly source: 'package' | 'project';
  readonly path: string;
  /** Схемы, которые эта затеняет, — источник и путь. */
  readonly shadows: readonly { readonly source: string; readonly path: string }[];
  readonly isDefault: boolean;
  /** Файл схемы разобрался; нечитаемые показываются с текстом ошибки. */
  readonly readable: boolean;
  readonly parseError: string | null;
  /**
   * CLI не показал схему, хотя YAML разобрался (например, цикл зависимостей):
   * текст первой ошибки `schema validate`. Такую схему можно открыть и исправить.
   */
  readonly cliError: string | null;
  readonly artifacts: readonly string[];
  /** Итог проверки SDD; `null` у нечитаемой схемы. */
  readonly conformance: {
    readonly errors: number;
    readonly warnings: number;
    readonly assignable: boolean;
    readonly waived: readonly string[];
  } | null;
}

/** Ошибка разбора YAML с местом, где она случилась. */
export interface YamlProblem {
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
}

/** Схема, открытая в конструкторе. */
export interface SchemaSource {
  readonly name: string;
  readonly source: 'package' | 'project';
  /** Встроенные схемы правятся только через форк. */
  readonly readOnly: boolean;
  readonly path: string;
  readonly text: string;
  readonly document: SchemaDocument | null;
  readonly yamlError: YamlProblem | null;
  readonly templates: readonly {
    readonly artifact: string;
    readonly template: string | null;
    readonly exists: boolean;
  }[];
}

/** Запись структурного слоя проверки. */
export interface StructuralIssue {
  readonly level: string;
  readonly message: string;
  /** Артефакт, к которому относится запись, если его удалось определить. */
  readonly artifact?: string;
}

/** Итог двухслойной проверки. */
export interface SchemaCheck {
  readonly name: string;
  /** Слой CLI: `openspec schema validate` по сохранённой версии. */
  readonly structural: {
    readonly valid: boolean;
    readonly issues: readonly StructuralIssue[];
  };
  /** Слой IDE: правила SDD. */
  readonly sdd: ConformanceReport;
  /** Можно назначить: оба слоя без ошибок. */
  readonly assignable: boolean;
}

/** Итог назначения схемы проекту. */
export interface AssignResult {
  readonly previous: string | null;
  /** Сколько активных changes остались на своих схемах. */
  readonly activeChanges: number;
  /** Changes, которым прежняя схема записана явно. */
  readonly pinned: readonly string[];
  /** Предупреждения SDD: назначению не мешают, но показываются при назначении. */
  readonly warnings: readonly string[];
}

const SCHEMAS_DIR = 'schemas';
/** Схема, которую CLI берёт, когда проект свою не задал. */
const DEFAULT_SCHEMA = 'spec-driven';

/** Разбирает YAML, сообщая строку и столбец ошибки. */
export function parseSchemaText(text: string, fallbackName: string): {
  document: SchemaDocument | null;
  error: YamlProblem | null;
} {
  const counter = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: counter, prettyErrors: false });
  const first = parsed.errors[0];
  if (first !== undefined) {
    const offset = first.pos[0];
    const position = counter.linePos(offset);
    return {
      document: null,
      error: { message: first.message.split('\n')[0] ?? first.message, line: position.line, column: position.col },
    };
  }
  return { document: schemaFromPlain(parsed.toJS(), fallbackName).document, error: null };
}

/**
 * Реестр схем проекта.
 *
 * Список строится по `openspec schemas --json` и дополняется обходом
 * `openspec/schemas/`: схему с битым YAML CLI молча пропускает, а реестр
 * обязан её показать — иначе пользователь не узнает, почему процесс пропал.
 */
export class SchemaRegistry {
  readonly #client: OpenspecClient;
  readonly #bin: string;

  constructor(client: OpenspecClient, bin: string) {
    this.#client = client;
    this.#bin = bin;
  }

  get #projectDir(): string {
    return join(this.#client.root, OPENSPEC_DIR, SCHEMAS_DIR);
  }

  async list(): Promise<RegistryEntry[]> {
    this.#client.invalidate();
    const listed = await this.#client.listSchemas();
    if (!listed.ok) throw new SchemaOperationError(listed.message);

    const defaultName = await this.defaultSchema();
    const entries: RegistryEntry[] = [];

    for (const schema of listed.data) {
      const which = await this.#client.schemaWhich(schema.name);
      const path = which.ok ? which.data.path : '';
      const text = await readText(join(path, 'schema.yaml'));
      const { document, error } =
        text === null
          ? { document: null, error: { message: 'Файл схемы не читается', line: null, column: null } }
          : parseSchemaText(text, schema.name);
      const report = document === null ? null : checkConformance(document);

      entries.push({
        name: schema.name,
        description: schema.description ?? null,
        source: schema.source === 'project' ? 'project' : 'package',
        path,
        shadows: which.ok ? (which.data.shadows ?? []).map(({ source, path: shadowPath }) => ({ source, path: shadowPath })) : [],
        isDefault: schema.name === defaultName,
        readable: document !== null,
        parseError: error === null ? null : formatProblem(error),
        cliError: null,
        artifacts: schema.artifacts,
        conformance:
          report === null
            ? null
            : {
                errors: report.errors,
                warnings: report.warnings,
                assignable: report.assignable,
                waived: report.waived.map((item) => item.rule.id),
              },
      });
    }

    // Проектные схемы, которые CLI не показал: битый YAML или структура,
    // которую CLI отверг.
    const known = new Set(entries.filter((entry) => entry.source === 'project').map((entry) => entry.name));
    for (const name of await this.#projectSchemaDirs()) {
      if (known.has(name)) continue;
      const path = join(this.#projectDir, name);
      const text = await readText(join(path, 'schema.yaml'));
      const parsed = text === null ? null : parseSchemaText(text, name);
      const document = parsed?.document ?? null;
      const report = document === null ? null : checkConformance(document);
      entries.push({
        name,
        description: document?.description ?? null,
        source: 'project',
        path,
        shadows: [],
        isDefault: name === defaultName,
        readable: document !== null,
        parseError:
          parsed === null
            ? 'В каталоге схемы нет файла schema.yaml'
            : parsed.error === null
              ? null
              : formatProblem(parsed.error),
        cliError:
          document === null
            ? null
            : ((await this.#structural(name)).issues[0]?.message ?? 'CLI OpenSpec не принял эту схему'),
        artifacts: document?.artifacts.map((artifact) => artifact.id) ?? [],
        conformance:
          report === null
            ? null
            : {
                errors: report.errors,
                warnings: report.warnings,
                // Отвергнутую CLI схему назначить нельзя, что бы ни говорил SDD.
                assignable: false,
                waived: report.waived.map((item) => item.rule.id),
              },
      });
    }

    return entries.sort((a, b) =>
      a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'project' ? -1 : 1,
    );
  }

  /** Имя схемы проекта по умолчанию из `openspec/config.yaml`. */
  async defaultSchema(): Promise<string | null> {
    const text = await readText(join(this.#client.root, OPENSPEC_DIR, 'config.yaml'));
    if (text === null) return null;
    const match = /^schema:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(text);
    return match?.[1] ?? null;
  }

  /** Открывает схему для конструктора. */
  async read(name: string): Promise<SchemaSource> {
    const location = await this.#locate(name);
    const text = (await readText(join(location.path, 'schema.yaml'))) ?? '';
    const { document, error } = parseSchemaText(text, name);

    const templates = [];
    for (const artifact of document?.artifacts ?? []) {
      const template = artifact.template;
      const exists =
        template === null ? false : (await readText(join(location.path, 'templates', template))) !== null;
      templates.push({ artifact: artifact.id, template, exists });
    }

    return {
      name,
      source: location.source,
      readOnly: location.source === 'package',
      path: location.path,
      text,
      document,
      yamlError: error,
      templates,
    };
  }

  /**
   * Сохраняет текст схемы.
   *
   * Нарушения SDD сохранение не блокируют: схему собирают постепенно, и
   * запрещать черновик бессмысленно. Блокирует только неразбираемый YAML —
   * такой файл нельзя ни показать на графе, ни проверить.
   */
  async save(name: string, text: string): Promise<SchemaSource> {
    const location = await this.#locate(name);
    if (location.source === 'package') {
      throw new SchemaOperationError(
        `Встроенная схема «${name}» не правится. Сделайте её форк и правьте копию.`,
      );
    }
    const { error } = parseSchemaText(text, name);
    if (error !== null) {
      throw new SchemaOperationError('YAML схемы не разбирается — сохранение остановлено', [
        formatProblem(error),
      ]);
    }
    await writeAtomically(join(location.path, 'schema.yaml'), text);
    this.#client.invalidate();
    return this.read(name);
  }

  /** Создаёт схему с нуля или форком существующей. */
  async create(name: string, from: string | null): Promise<SchemaSource> {
    const trimmed = name.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
      throw new SchemaOperationError(
        `Недопустимое имя схемы «${name}»: нужны строчные латинские буквы, цифры и дефисы.`,
      );
    }
    // Занятость проверяется до вызова CLI: сам он на занятое имя отвечает
    // ошибкой, но проверка по спецификации — забота IDE.
    if ((await this.#projectSchemaDirs()).includes(trimmed)) {
      throw new SchemaOperationError(
        `Проектная схема «${trimmed}» уже существует. Выберите другое имя или откройте её.`,
      );
    }

    const args =
      from === null
        ? ['schema', 'init', trimmed, '--no-default', '--json']
        : ['schema', 'fork', from, trimmed, '--json'];
    const result = await runCli({ bin: this.#bin, cwd: this.#client.root }, args);
    if (result.code !== 0 || /"error"\s*:/.test(result.stdout)) {
      throw new SchemaOperationError(`Не удалось создать схему «${trimmed}»`, [
        `${result.stdout}\n${result.stderr}`.trim(),
      ]);
    }
    this.#client.invalidate();
    return this.read(trimmed);
  }

  /** Двухслойная проверка: структура от CLI и правила SDD от IDE. */
  async check(name: string): Promise<SchemaCheck> {
    const source = await this.read(name);
    if (source.document === null) {
      throw new SchemaOperationError('YAML схемы не разбирается', [
        source.yamlError === null ? 'неизвестная ошибка' : formatProblem(source.yamlError),
      ]);
    }

    // Отсутствующий файл шаблона CLI сам считает ошибкой структуры.
    const structuralResult = await this.#structural(name);

    const sdd = checkConformance(source.document);
    return {
      name,
      structural: structuralResult,
      sdd,
      assignable: structuralResult.valid && sdd.assignable,
    };
  }

  /**
   * Проверяет, что схему можно назначить — проекту или новому change.
   * Бросает ошибку с перечнем нарушений и способами их исправить.
   */
  async ensureAssignable(name: string): Promise<SchemaCheck> {
    const check = await this.check(name);
    if (!check.assignable) {
      const details = [
        ...check.structural.issues
          .filter((issue) => issue.level === 'error')
          .map((issue) => `структура: ${issue.message}`),
        ...check.sdd.violations
          .filter((violation) => violation.level === 'error')
          .map((violation) => `SDD ${violation.rule}: ${violation.message} ${violation.fix}`),
      ];
      throw new SchemaOperationError(
        `Схему «${name}» нельзя назначить: процесс не проходит проверку`,
        details,
      );
    }
    return check;
  }

  /**
   * Назначает схему проекту.
   *
   * Меняется только строка `schema:` в `openspec/config.yaml` — комментарии,
   * контекст и правила проекта остаются побайтово прежними.
   */
  async assign(name: string): Promise<AssignResult> {
    const check = await this.ensureAssignable(name);

    const configPath = join(this.#client.root, OPENSPEC_DIR, 'config.yaml');
    const text = (await readText(configPath)) ?? '';
    const previous = await this.defaultSchema();
    const next = /^schema:.*$/m.test(text)
      ? text.replace(/^schema:.*$/m, `schema: ${name}`)
      : `schema: ${name}\n${text}`;
    await writeAtomically(configPath, next);
    this.#client.invalidate();

    // Change без явной схемы в `.openspec.yaml` берёт схему проекта — смена
    // схемы молча перевела бы его на другой процесс. Такие changes получают
    // прежнюю схему явно.
    const pinned: string[] = [];
    const changes = await this.#client.listChanges();
    const active = changes.ok ? changes.data.changes.map((change) => change.name) : [];
    for (const change of active) {
      const metaPath = join(this.#client.root, OPENSPEC_DIR, 'changes', change, '.openspec.yaml');
      const meta = await readText(metaPath);
      if (meta !== null && /^schema:/m.test(meta)) continue;
      const schema = previous ?? DEFAULT_SCHEMA;
      if (schema === name) continue;
      await writeAtomically(metaPath, `schema: ${schema}\n${meta ?? ''}`);
      pinned.push(change);
    }
    this.#client.invalidate();
    const warnings = check.sdd.violations
      .filter((violation) => violation.level === 'warning')
      .map((violation) => `${violation.rule}: ${violation.message}`);
    return { previous, activeChanges: active.length, pinned, warnings };
  }

  /** Как процесс будет выглядеть в работе. */
  preview(document: SchemaDocument): SchemaPreview {
    return previewSchema(document);
  }

  /** Читает шаблон артефакта. */
  async readTemplate(name: string, template: string): Promise<string | null> {
    const location = await this.#locate(name);
    return readText(this.#templatePath(location.path, template));
  }

  /** Записывает шаблон артефакта — в том числе объявленный, но отсутствующий. */
  async writeTemplate(name: string, template: string, content: string): Promise<void> {
    const location = await this.#locate(name);
    if (location.source === 'package') {
      throw new SchemaOperationError(`Шаблоны встроенной схемы «${name}» не правятся — сделайте форк.`);
    }
    const path = this.#templatePath(location.path, template);
    await mkdir(dirname(path), { recursive: true });
    await writeAtomically(path, content);
  }

  /** Структурный слой: `openspec schema validate` по сохранённой версии. */
  async #structural(name: string): Promise<{ valid: boolean; issues: StructuralIssue[] }> {
    this.#client.invalidate();
    const structural = await runCliJson<unknown>(
      { bin: this.#bin, cwd: this.#client.root },
      ['schema', 'validate', name, '--json'],
    );
    // Ненулевой код у `schema validate` означает найденные нарушения: отчёт
    // при этом напечатан.
    const payload = structural.ok ? structural.data : parseLoose(structural.stdout);
    const parsed = schemaValidateSchema.safeParse(payload);
    if (parsed.success) {
      return {
        valid: parsed.data.valid,
        issues: parsed.data.issues.map((issue) => {
          // CLI адресует запись путём вида `artifacts.<id>.template`.
          const artifact = /^artifacts\.([^.]+)\./.exec(issue.path ?? '')?.[1];
          return artifact === undefined
            ? { level: issue.level, message: issue.message }
            : { level: issue.level, message: issue.message, artifact };
        }),
      };
    }
    return {
      valid: false,
      issues: [
        {
          level: 'error',
          message: structural.ok ? 'Ответ schema validate не разобран' : structural.message,
        },
      ],
    };
  }

  #templatePath(schemaPath: string, template: string): string {
    const root = join(schemaPath, 'templates');
    // Путь шаблона приходит от пользователя — выход за каталог шаблонов запрещён.
    return resolveInsideWorkspace(root, template);
  }

  async #locate(name: string): Promise<{ path: string; source: 'package' | 'project' }> {
    const projectPath = join(this.#projectDir, name);
    try {
      await stat(join(projectPath, 'schema.yaml'));
      return { path: projectPath, source: 'project' };
    } catch {
      // не проектная — ищем у CLI
    }
    const which = await this.#client.schemaWhich(name);
    if (!which.ok) throw new SchemaOperationError(`Схема «${name}» не найдена`);
    return { path: which.data.path, source: which.data.source === 'project' ? 'project' : 'package' };
  }

  async #projectSchemaDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.#projectDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

function formatProblem(problem: YamlProblem): string {
  return problem.line === null ? problem.message : `строка ${problem.line}, столбец ${problem.column}: ${problem.message}`;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

function parseLoose(text: string): unknown {
  const start = text.search(/[[{]/);
  try {
    return JSON.parse(start <= 0 ? text : text.slice(start));
  } catch {
    return undefined;
  }
}
