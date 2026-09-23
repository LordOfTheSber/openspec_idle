import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type SchemaWaiverNote, checkConformance, schemaFromPlain } from '@openspec-ide/core';
import { parse as parseYaml } from 'yaml';
import type { OpenspecClient } from './openspec/client.js';

/** Артефакт схемы workflow, как он объявлен в schema.yaml. */
export interface SchemaArtifact {
  readonly id: string;
  /** Путь, по которому артефакт порождает файлы. */
  readonly generates: string;
  readonly description: string | null;
  /** Есть ли у артефакта инструкция для агента. */
  readonly hasInstruction: boolean;
  readonly requires: readonly string[];
}

/** Определение схемы workflow. */
export interface SchemaDefinition {
  readonly name: string;
  readonly description: string | null;
  readonly source: string;
  readonly path: string;
  readonly artifacts: readonly SchemaArtifact[];
  /** Артефакты, без которых нельзя начинать работу по коду. */
  readonly applyRequires: readonly string[];
  /** Файл, по которому измеряется прогресс. */
  readonly tracks: string | null;
  /** Действующие отказы от правил SDD: с причиной и по известному правилу. */
  readonly waivers: readonly SchemaWaiverNote[];
}

/**
 * Читает определения схем из их файлов.
 *
 * Состав артефактов и их зависимости CLI в JSON не отдаёт: `status` знает
 * только идентификаторы и пути, а `requires` живёт исключительно в
 * schema.yaml. Путь к файлу берётся у `schema which`, поэтому одинаково
 * работают и встроенные схемы, и проектные.
 */
export class SchemaReader {
  readonly #client: OpenspecClient;
  readonly #cache = new Map<string, SchemaDefinition | null>();

  constructor(client: OpenspecClient) {
    this.#client = client;
  }

  /** Сбрасывает кэш — например, когда схему поправили на диске. */
  invalidate(): void {
    this.#cache.clear();
  }

  async read(name: string): Promise<SchemaDefinition | null> {
    const cached = this.#cache.get(name);
    if (cached !== undefined) return cached;

    const which = await this.#client.schemaWhich(name);
    if (!which.ok) {
      this.#cache.set(name, null);
      return null;
    }

    let text: string;
    try {
      text = await readFile(join(which.data.path, 'schema.yaml'), 'utf8');
    } catch {
      this.#cache.set(name, null);
      return null;
    }

    const definition = parseSchemaYaml(name, which.data.source, which.data.path, text);
    this.#cache.set(name, definition);
    return definition;
  }
}

/** Разбирает schema.yaml в определение схемы. */
export function parseSchemaYaml(
  name: string,
  source: string,
  path: string,
  text: string,
): SchemaDefinition | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const rawArtifacts = Array.isArray(parsed['artifacts']) ? parsed['artifacts'] : [];
  const artifacts: SchemaArtifact[] = [];
  for (const raw of rawArtifacts) {
    if (!isRecord(raw) || typeof raw['id'] !== 'string') continue;
    const requires = Array.isArray(raw['requires'])
      ? raw['requires'].filter((item): item is string => typeof item === 'string')
      : [];
    artifacts.push({
      id: raw['id'],
      generates: typeof raw['generates'] === 'string' ? raw['generates'] : `${raw['id']}.md`,
      description: typeof raw['description'] === 'string' ? raw['description'] : null,
      hasInstruction:
        typeof raw['instruction'] === 'string' && raw['instruction'].trim() !== '',
      requires,
    });
  }

  const apply = isRecord(parsed['apply']) ? parsed['apply'] : {};
  const applyRequires = Array.isArray(apply['requires'])
    ? apply['requires'].filter((item): item is string => typeof item === 'string')
    : [];

  return {
    name,
    description: typeof parsed['description'] === 'string' ? parsed['description'] : null,
    source,
    path,
    artifacts,
    applyRequires,
    tracks: typeof apply['tracks'] === 'string' ? apply['tracks'] : null,
    waivers: checkConformance(schemaFromPlain(parsed, name).document).waived.map((item) => ({
      rule: item.rule.id,
      reason: item.reason,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
