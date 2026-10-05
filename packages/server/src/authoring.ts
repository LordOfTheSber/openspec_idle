import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENSPEC_DIR,
  type AuthoringChange,
  type AuthoringDelta,
  type AuthoringSources,
  type AuthoringSpec,
  type TreeCapability,
} from '@openspec-ide/core';
import { capabilityFromPath } from './deltas.js';
import { readQualityConfig } from './quality.js';
import type { WorkspaceReader } from './workspace.js';

/**
 * Собирает тексты, по которым работают функции редактора, проверки ссылок и
 * качества спеков: основные спеки, дельты и планы активных changes, настройки
 * проверки качества.
 *
 * Какие файлы у change дельты и какой из них план, определяет его схема —
 * через дерево рабочего пространства: дельты — артефакт с шаблоном пути,
 * план — отслеживаемый артефакт.
 */
export class AuthoringService {
  readonly #root: string;
  readonly #workspace: WorkspaceReader;

  constructor(root: string, workspace: WorkspaceReader) {
    this.#root = root;
    this.#workspace = workspace;
  }

  async sources(): Promise<AuthoringSources> {
    const { tree } = await this.#workspace.readTree();

    const capabilities: string[] = [];
    const collect = (nodes: readonly TreeCapability[]): void => {
      for (const node of nodes) {
        if (node.isSpec) capabilities.push(node.path);
        collect(node.children);
      }
    };
    collect(tree.capabilities);

    const mainSpecs: AuthoringSpec[] = [];
    for (const capability of capabilities) {
      const path = `${OPENSPEC_DIR}/specs/${capability}/spec.md`;
      const text = await this.#read(path);
      if (text !== null) mainSpecs.push({ capability, path, text });
    }

    const changes: AuthoringChange[] = [];
    for (const change of tree.changes) {
      const base = `${OPENSPEC_DIR}/changes/${change.name}`;
      const deltas: AuthoringDelta[] = [];
      let plan: AuthoringChange['plan'] = null;
      for (const artifact of change.artifacts) {
        if (artifact.outputPath.includes('*')) {
          for (const file of artifact.files) {
            const path = `${base}/${file.replaceAll('\\', '/')}`;
            const text = await this.#read(path);
            if (text !== null) deltas.push({ capability: capabilityFromPath(path), path, text });
          }
        }
        if (artifact.progress !== null && artifact.files[0] !== undefined) {
          const path = `${base}/${artifact.files[0].replaceAll('\\', '/')}`;
          const text = await this.#read(path);
          if (text !== null) plan = { path, text };
        }
      }
      changes.push({ name: change.name, deltas, plan });
    }

    return { mainSpecs, changes, quality: await readQualityConfig(this.#root) };
  }

  async #read(relative: string): Promise<string | null> {
    try {
      return await readFile(join(this.#root, relative), 'utf8');
    } catch {
      return null;
    }
  }
}
