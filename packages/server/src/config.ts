import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** Каталог, в котором IDE держит свои данные внутри рабочего пространства. */
export const IDE_DIR = '.openspec-ide';

/** Имя файла конфигурации внутри `IDE_DIR`. */
export const CONFIG_FILE = 'config.json';

/**
 * Поля конфигурации, помеченные как секретные.
 *
 * Значения этих полей IDE не хранит: в файл попадает только *имя* переменной
 * окружения. Попытка записать непустое значение отклоняется.
 */
export const SECRET_FIELDS: readonly string[] = ['agent.apiKey', 'agent.token', 'agent.password'];

/** Имя переменной окружения; значение ключа ему не соответствует. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Описание запуска CLI. Значения по умолчанию — интерфейс Qwen Code, который
 * наследует GigaCode CLI; расхождение сборки правится здесь, а не в коде.
 */
const launchSchema = z
  .object({
    /**
     * Шаблон аргументов. `{name}` подставляется значением; если значение не
     * задано, выпадает и сам шаблон, и предшествующий ему флаг.
     */
    args: z
      .array(z.string())
      .default([
        '{prompt}',
        '--output-format',
        '{format}',
        '--approval-mode',
        '{approvalMode}',
        '--max-wall-time',
        '{maxWallTime}',
        '--max-tool-calls',
        '{maxToolCalls}',
        '--model',
        '{model}',
        '{extraArgs}',
      ]),
    streamFormat: z.string().default('stream-json'),
    oneShotFormat: z.string().default('json'),
    /** Код выхода, которым CLI сообщает о превышении бюджета. */
    budgetExitCode: z.number().int().default(55),
    versionArgs: z.array(z.string()).default(['--version']),
    helpArgs: z.array(z.string()).default(['--help']),
  })
  .default({});

const agentSchema = z
  .object({
    command: z.string().default('gigacode'),
    model: z.string().nullable().default(null),
    // Режим по умолчанию не даёт агенту менять файлы без подтверждения.
    approvalMode: z
      .enum(['plan', 'default', 'auto-edit', 'auto', 'yolo'])
      .default('default'),
    maxWallTime: z
      .string()
      .regex(/^\d+(\.\d+)?(s|m|h)?$/, 'ожидается длительность вида 90, 30s, 15m или 1.5h')
      .default('15m'),
    maxToolCalls: z.number().int().positive().default(120),
    /** `null` — CLI авторизован сам, переменная не требуется. */
    credentialsEnv: z
      .string()
      .regex(ENV_NAME, 'ожидается имя переменной окружения')
      .nullable()
      .default('GIGACODE_API_KEY'),
    /** Прочие переменные, значения которых вырезаются из журнала запусков. */
    secretEnvs: z.array(z.string().regex(ENV_NAME)).default([]),
    /** Дополнительные несекретные аргументы: адрес шлюза, тип авторизации. */
    extraArgs: z.array(z.string()).default([]),
    launch: launchSchema,
  })
  .default({});

const configSchema = z
  .object({
    version: z.literal(1).default(1),
    agent: agentSchema,
  })
  .default({});

/** Разобранная конфигурация IDE со значениями по умолчанию. */
export type IdeConfig = z.infer<typeof configSchema>;

/** Итог чтения конфигурации. */
export interface ConfigLoad {
  readonly config: IdeConfig;
  /** Поля файла, неизвестные текущей версии: сохраняются при перезаписи. */
  readonly unknownFields: readonly string[];
  /** Файла не было — применены значения по умолчанию. */
  readonly usedDefaults: boolean;
  /** Файл существует, но не разбирается; текст ошибки для показа. */
  readonly parseError: string | null;
}

/** Попытка записать в файл значение поля, помеченного как секрет. */
export class SecretInConfigError extends Error {
  constructor(
    readonly field: string,
    reason = `Поле «${field}» помечено как секрет и не сохраняется в файл конфигурации.`,
  ) {
    super(`${reason} Задайте значение переменной окружения, а в настройках укажите её имя.`);
    this.name = 'SecretInConfigError';
  }
}

function configPath(root: string): string {
  return join(root, IDE_DIR, CONFIG_FILE);
}

/** Читает конфигурацию, применяя значения по умолчанию к отсутствующим полям. */
export async function loadConfig(root: string): Promise<ConfigLoad> {
  let text: string;
  try {
    text = await readFile(configPath(root), 'utf8');
  } catch {
    return {
      config: configSchema.parse({}),
      unknownFields: [],
      usedDefaults: true,
      parseError: null,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      config: configSchema.parse({}),
      unknownFields: [],
      usedDefaults: false,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = configSchema.safeParse(raw);
  return {
    config: parsed.success ? parsed.data : configSchema.parse({}),
    unknownFields: collectUnknownFields(raw),
    usedDefaults: false,
    parseError: parsed.success
      ? null
      : parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<корень>'}: ${issue.message}`)
          .join('; '),
  };
}

/**
 * Записывает конфигурацию, сохраняя поля, неизвестные текущей версии.
 *
 * Незнакомое поле — это, как правило, настройка более новой версии IDE;
 * молча стереть её значило бы ломать проект при откате версии.
 */
export async function saveConfig(root: string, next: unknown): Promise<IdeConfig> {
  rejectSecrets(next);

  const parsed = configSchema.parse(next);

  let existing: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(await readFile(configPath(root), 'utf8'));
    if (isRecord(raw)) existing = raw;
  } catch {
    // Файла нет или он не разбирается — сохраняем то, что пришло.
  }

  const merged = mergePreservingUnknown(existing, parsed as unknown as Record<string, unknown>);
  const target = configPath(root);
  await mkdir(dirname(target), { recursive: true });

  // Пишем во временный файл и переименовываем: при сбое исходный файл
  // остаётся целым, а не обрезанным наполовину.
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await rename(temporary, target);

  return parsed;
}

/** Бросает исключение, если в данных есть непустое значение секретного поля. */
export function rejectSecrets(value: unknown): void {
  for (const field of SECRET_FIELDS) {
    const found = readPath(value, field.split('.'));
    if (typeof found === 'string' && found.trim() !== '') {
      throw new SecretInConfigError(field);
    }
  }
  // В поле имени переменной вставили сам ключ — сохранять нельзя: это
  // значение попало бы в файл и в интерфейс.
  const env = readPath(value, ['agent', 'credentialsEnv']);
  if (typeof env === 'string' && env !== '' && !ENV_NAME.test(env)) {
    throw new SecretInConfigError(
      'agent.credentialsEnv',
      'В поле имени переменной окружения похоже на значение ключа — IDE его не сохраняет.',
    );
  }
  for (const [index, arg] of (asArray(readPath(value, ['agent', 'extraArgs'])) ?? []).entries()) {
    // Флаг вида `--openai-api-key` несёт значение ключа следующим аргументом.
    if (typeof arg === 'string' && /(api[-_]?key|token|password|secret)/i.test(arg) && /^-|=/.test(arg)) {
      throw new SecretInConfigError(
        `agent.extraArgs[${index}]`,
        `Аргумент «${arg.split('=')[0]}» передаёт секрет в командной строке — его значение попало бы в файл конфигурации.`,
      );
    }
  }
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function collectUnknownFields(raw: unknown, prefix = ''): string[] {
  if (!isRecord(raw)) return [];
  const known = new Set(['version', 'agent']);
  const knownAgent = new Set([
    'command',
    'model',
    'approvalMode',
    'maxWallTime',
    'maxToolCalls',
    'credentialsEnv',
    'secretEnvs',
    'extraArgs',
    'launch',
  ]);

  const unknown: string[] = [];
  for (const key of Object.keys(raw)) {
    if (prefix === '' && !known.has(key)) unknown.push(key);
  }
  const agent = raw['agent'];
  if (isRecord(agent)) {
    for (const key of Object.keys(agent)) {
      if (!knownAgent.has(key)) unknown.push(`agent.${key}`);
    }
  }
  return unknown;
}

function mergePreservingUnknown(
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(next)) {
    const previous = merged[key];
    merged[key] =
      isRecord(previous) && isRecord(value) ? mergePreservingUnknown(previous, value) : value;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
