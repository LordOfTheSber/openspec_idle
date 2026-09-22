import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENSPEC_DIR,
  type CapabilityDelta,
  type CapabilityMap,
  type DeltaView,
  type RequirementComparison,
  buildCapabilityMap,
  buildDeltaView,
  compareRequirement,
  parseSpecMarkdown,
} from '@openspec-ide/core';
import type { OpenspecClient } from './openspec/client.js';
import type { WorkspaceReader } from './workspace.js';

/** Дельты одного change по всем его capability. */
export interface ChangeDeltas {
  readonly change: string;
  readonly views: readonly DeltaView[];
}

/** Читает дельты и строит карту связей. */
export class DeltaReader {
  readonly #client: OpenspecClient;
  readonly #workspace: WorkspaceReader;

  constructor(client: OpenspecClient, workspace: WorkspaceReader) {
    this.#client = client;
    this.#workspace = workspace;
  }

  /** Собирает дельты всех capability указанного change. */
  async readChangeDeltas(change: string): Promise<ChangeDeltas> {
    const status = await this.#client.status(change);
    if (!status.ok) return { change, views: [] };

    const views: DeltaView[] = [];
    for (const [, paths] of Object.entries(status.data.artifactPaths)) {
      // Дельты лежат в артефакте, порождающем несколько файлов по шаблону пути.
      if (!paths.outputPath.includes('*')) continue;

      for (const absolute of paths.existingOutputPaths) {
        const text = await readFileOrNull(absolute);
        if (text === null) continue;
        views.push(buildDeltaView(capabilityFromPath(absolute), text));
      }
    }

    return { change, views };
  }

  /** Читает основной спек capability. */
  async readMainSpec(capability: string): Promise<string | null> {
    return readFileOrNull(join(this.#client.root, OPENSPEC_DIR, 'specs', capability, 'spec.md'));
  }

  /**
   * Собирает структурный вид основного спека capability.
   *
   * Требования и сценарии берутся из разбора файла, а не из
   * `show --type spec --json`: тот не сообщает ни заголовков, ни позиций в
   * файле, а без них нет ни списка, ни перехода к строке. Счётчики сверяются
   * с CLI тестом.
   */
  async readSpec(capability: string): Promise<SpecView | null> {
    const text = await this.readMainSpec(capability);
    if (text === null) return null;

    const parsed = parseSpecMarkdown(text);
    return {
      capability,
      purpose: parsed.purpose,
      purposeIsPlaceholder: parsed.purpose !== null && /\bTBD\b/.test(parsed.purpose),
      requirements: parsed.requirements.map((requirement) => ({
        name: requirement.name,
        line: requirement.line,
        description: requirement.description,
        scenarios: requirement.scenarios.map((scenario) => ({
          name: scenario.name,
          line: scenario.line,
        })),
      })),
      scenarioCount: parsed.requirements.reduce(
        (sum, requirement) => sum + requirement.scenarios.length,
        0,
      ),
    };
  }

  /** Сравнивает требование дельты с его версией в основном спеке. */
  async compare(
    change: string,
    capability: string,
    requirementName: string,
  ): Promise<RequirementComparison | null> {
    const deltas = await this.readChangeDeltas(change);
    const view = deltas.views.find((item) => item.capability === capability);
    if (view === undefined) return null;

    const requirement = view.groups
      .flatMap((group) => group.requirements)
      .find((item) => item.name === requirementName);
    if (requirement === undefined) return null;

    const mainSpec = await this.readMainSpec(capability);
    return compareRequirement(requirement, mainSpec ?? '');
  }

  /** Строит карту связей по всем активным changes. */
  async buildMap(): Promise<CapabilityMap> {
    const { tree } = await this.#workspace.readTree();

    const existing: string[] = [];
    const collect = (nodes: typeof tree.capabilities): void => {
      for (const node of nodes) {
        if (node.isSpec) existing.push(node.path);
        collect(node.children);
      }
    };
    collect(tree.capabilities);

    const deltas: CapabilityDelta[] = [];
    for (const change of tree.changes) {
      const changeDeltas = await this.readChangeDeltas(change.name);
      for (const view of changeDeltas.views) {
        deltas.push({
          change: change.name,
          capability: view.capability,
          requirements: view.groups.flatMap((group) =>
            group.requirements.map((requirement) => requirement.name),
          ),
        });
      }
    }

    return buildCapabilityMap({ existingCapabilities: existing, deltas });
  }
}

/**
 * Достаёт путь capability из пути файла дельты.
 *
 * Путь имеет вид `.../specs/<capability-path>/spec.md`, и вложенность
 * сохраняется целиком: `identity/user-auth` — не то же, что `user-auth`.
 */
export function capabilityFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const marker = '/specs/';
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return normalized;

  const tail = normalized.slice(index + marker.length);
  const parts = tail.split('/');
  parts.pop(); // имя файла
  return parts.join('/');
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Структурный вид основного спека capability. */
export interface SpecView {
  readonly capability: string;
  readonly purpose: string | null;
  /**
   * Назначение осталось заглушкой, которую проставляет архивация: спек создан,
   * но его смысл так и не описан.
   */
  readonly purposeIsPlaceholder: boolean;
  readonly requirements: readonly {
    readonly name: string;
    readonly line: number;
    readonly description: string;
    readonly scenarios: readonly { readonly name: string; readonly line: number }[];
  }[];
  readonly scenarioCount: number;
}
