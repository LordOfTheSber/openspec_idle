/**
 * Модель схемы workflow для конструктора процессов.
 *
 * Модель работает с уже разобранным объектом, а не с текстом YAML: разбор
 * живёт там, где есть библиотека YAML, а ядро остаётся без внешних
 * зависимостей. Ключи, которых модель не знает, сохраняются как есть —
 * конструктор не должен молча выбрасывать то, что добавил человек или новая
 * версия OpenSpec.
 */

/** Артефакт схемы. */
export interface SchemaArtifactDoc {
  readonly id: string;
  readonly generates: string;
  readonly description: string | null;
  readonly template: string | null;
  readonly instruction: string | null;
  readonly requires: readonly string[];
  /** Ключи артефакта, неизвестные модели. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Адресный отказ от правила SDD. */
export interface SchemaWaiver {
  readonly rule: string;
  /** `null` — причина не указана, и такой отказ не применяется. */
  readonly reason: string | null;
}

/** Схема целиком. */
export interface SchemaDocument {
  readonly name: string;
  readonly version: number | null;
  readonly description: string | null;
  readonly artifacts: readonly SchemaArtifactDoc[];
  readonly apply: {
    readonly requires: readonly string[];
    /** Путь файла, по которому измеряется прогресс. */
    readonly tracks: string | null;
    readonly instruction: string | null;
  };
  readonly waivers: readonly SchemaWaiver[];
  /** Ключи верхнего уровня, неизвестные модели. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Ключ в schema.yaml, под которым хранятся отказы от правил SDD. */
export const WAIVERS_KEY = 'sdd_waivers';

const KNOWN_TOP = new Set(['name', 'version', 'description', 'artifacts', 'apply', WAIVERS_KEY]);
const KNOWN_ARTIFACT = new Set(['id', 'generates', 'description', 'template', 'instruction', 'requires']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function pickExtra(source: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key)));
}

/** Результат разбора объекта схемы. */
export interface SchemaParse {
  readonly document: SchemaDocument;
  /** Что пришлось поправить или пропустить при разборе. */
  readonly problems: readonly string[];
}

/** Строит модель из разобранного YAML. */
export function schemaFromPlain(value: unknown, fallbackName = 'schema'): SchemaParse {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return { document: emptySchema(fallbackName), problems: ['Корень схемы должен быть объектом'] };
  }

  const artifacts: SchemaArtifactDoc[] = [];
  const rawArtifacts = Array.isArray(value['artifacts']) ? value['artifacts'] : [];
  if (!Array.isArray(value['artifacts'])) problems.push('Поле artifacts должно быть списком');

  rawArtifacts.forEach((raw, position) => {
    if (!isRecord(raw) || typeof raw['id'] !== 'string' || raw['id'].trim() === '') {
      problems.push(`Артефакт №${position + 1} без идентификатора пропущен`);
      return;
    }
    artifacts.push({
      id: raw['id'],
      generates: typeof raw['generates'] === 'string' ? raw['generates'] : '',
      description: text(raw['description']),
      template: text(raw['template']),
      instruction: text(raw['instruction']),
      requires: strings(raw['requires']),
      extra: pickExtra(raw, KNOWN_ARTIFACT),
    });
  });

  const apply = isRecord(value['apply']) ? value['apply'] : {};
  const waivers: SchemaWaiver[] = [];
  const rawWaivers = value[WAIVERS_KEY];
  if (Array.isArray(rawWaivers)) {
    for (const raw of rawWaivers) {
      if (isRecord(raw) && typeof raw['rule'] === 'string') {
        waivers.push({ rule: raw['rule'], reason: text(raw['reason']) });
      }
    }
  }

  return {
    document: {
      name: typeof value['name'] === 'string' ? value['name'] : fallbackName,
      version: typeof value['version'] === 'number' ? value['version'] : null,
      description: text(value['description']),
      artifacts,
      apply: {
        requires: strings(apply['requires']),
        tracks: text(apply['tracks']),
        instruction: text(apply['instruction']),
      },
      waivers,
      extra: pickExtra(value, KNOWN_TOP),
    },
    problems,
  };
}

/**
 * Превращает модель обратно в объект для записи в YAML.
 *
 * Порядок ключей стабилен и совпадает с принятым в OpenSpec, пустые поля не
 * записываются: иначе каждое сохранение давало бы шумный дифф.
 */
export function schemaToPlain(document: SchemaDocument): Record<string, unknown> {
  const plain: Record<string, unknown> = { name: document.name };
  if (document.version !== null) plain['version'] = document.version;
  if (document.description !== null) plain['description'] = document.description;

  plain['artifacts'] = document.artifacts.map((artifact) => {
    const entry: Record<string, unknown> = { id: artifact.id, generates: artifact.generates };
    if (artifact.description !== null) entry['description'] = artifact.description;
    if (artifact.template !== null) entry['template'] = artifact.template;
    if (artifact.instruction !== null) entry['instruction'] = artifact.instruction;
    entry['requires'] = [...artifact.requires];
    return { ...entry, ...artifact.extra };
  });

  const apply: Record<string, unknown> = { requires: [...document.apply.requires] };
  if (document.apply.tracks !== null) apply['tracks'] = document.apply.tracks;
  if (document.apply.instruction !== null) apply['instruction'] = document.apply.instruction;
  plain['apply'] = apply;

  if (document.waivers.length > 0) {
    plain[WAIVERS_KEY] = document.waivers.map((waiver) =>
      waiver.reason === null ? { rule: waiver.rule } : { rule: waiver.rule, reason: waiver.reason },
    );
  }

  return { ...plain, ...document.extra };
}

/** Пустая схема. */
export function emptySchema(name: string): SchemaDocument {
  return {
    name,
    version: 1,
    description: null,
    artifacts: [],
    apply: { requires: [], tracks: null, instruction: null },
    waivers: [],
    extra: {},
  };
}

/** Артефакты, которые зависят от указанного — напрямую. */
export function dependentsOf(document: SchemaDocument, id: string): string[] {
  return document.artifacts.filter((artifact) => artifact.requires.includes(id)).map((a) => a.id);
}

/** Добавляет артефакт. Идентификатор должен быть новым. */
export function addArtifact(
  document: SchemaDocument,
  artifact: { id: string; generates?: string; requires?: readonly string[] },
): SchemaDocument {
  const id = artifact.id.trim();
  if (id === '') throw new Error('У артефакта должен быть идентификатор');
  if (document.artifacts.some((item) => item.id === id)) {
    throw new Error(`Артефакт «${id}» уже есть в схеме`);
  }
  return {
    ...document,
    artifacts: [
      ...document.artifacts,
      {
        id,
        generates: artifact.generates ?? `${id}.md`,
        // Описание обязательно для CLI: без него `openspec schema validate`
        // отвергает схему целиком.
        description: `Артефакт ${id}`,
        template: `${id}.md`,
        instruction: null,
        requires: [...(artifact.requires ?? [])],
        extra: {},
      },
    ],
  };
}

/** Изменяемые поля артефакта. */
export type ArtifactPatch = Partial<
  Pick<SchemaArtifactDoc, 'id' | 'generates' | 'description' | 'template' | 'instruction' | 'requires'>
>;

/**
 * Меняет артефакт. Переименование обновляет все ссылки на него — зависимости
 * других артефактов и список начала работ.
 */
export function updateArtifact(
  document: SchemaDocument,
  id: string,
  patch: ArtifactPatch,
): SchemaDocument {
  const current = document.artifacts.find((artifact) => artifact.id === id);
  if (current === undefined) throw new Error(`Артефакта «${id}» нет в схеме`);

  const nextId = patch.id?.trim() ?? id;
  if (nextId === '') throw new Error('У артефакта должен быть идентификатор');
  if (nextId !== id && document.artifacts.some((artifact) => artifact.id === nextId)) {
    throw new Error(`Артефакт «${nextId}» уже есть в схеме`);
  }

  const rename = (value: string): string => (value === id ? nextId : value);

  return {
    ...document,
    artifacts: document.artifacts.map((artifact) => {
      if (artifact.id === id) {
        return {
          ...artifact,
          ...patch,
          id: nextId,
          description: patch.description === undefined ? artifact.description : text(patch.description),
          instruction: patch.instruction === undefined ? artifact.instruction : text(patch.instruction),
          template: patch.template === undefined ? artifact.template : text(patch.template),
          requires: (patch.requires ?? artifact.requires).filter((dependency) => dependency !== nextId),
        };
      }
      return nextId === id ? artifact : { ...artifact, requires: artifact.requires.map(rename) };
    }),
    apply: { ...document.apply, requires: document.apply.requires.map(rename) },
  };
}

/**
 * Удаляет артефакт и снимает зависимости от него.
 *
 * Список зависящих артефактов показывается до удаления (`dependentsOf`) —
 * здесь удаление уже подтверждено.
 */
export function removeArtifact(document: SchemaDocument, id: string): SchemaDocument {
  return {
    ...document,
    artifacts: document.artifacts
      .filter((artifact) => artifact.id !== id)
      .map((artifact) => ({
        ...artifact,
        requires: artifact.requires.filter((dependency) => dependency !== id),
      })),
    apply: {
      ...document.apply,
      requires: document.apply.requires.filter((dependency) => dependency !== id),
    },
  };
}

/** Меняет правила начала работ. */
export function updateApply(
  document: SchemaDocument,
  patch: Partial<SchemaDocument['apply']>,
): SchemaDocument {
  return {
    ...document,
    apply: {
      requires: patch.requires === undefined ? document.apply.requires : [...patch.requires],
      tracks: patch.tracks === undefined ? document.apply.tracks : text(patch.tracks),
      instruction:
        patch.instruction === undefined ? document.apply.instruction : text(patch.instruction),
    },
  };
}

/** Объявляет или обновляет отказ от правила. */
export function setWaiver(document: SchemaDocument, rule: string, reason: string | null): SchemaDocument {
  const others = document.waivers.filter((waiver) => waiver.rule !== rule);
  return { ...document, waivers: [...others, { rule, reason: text(reason) }] };
}

/** Снимает отказ от правила. */
export function removeWaiver(document: SchemaDocument, rule: string): SchemaDocument {
  return { ...document, waivers: document.waivers.filter((waiver) => waiver.rule !== rule) };
}
