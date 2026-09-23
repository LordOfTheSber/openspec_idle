import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  OPENSPEC_DIR,
  SearchIndex,
  type SearchDocument,
  type TreeInput,
  type WorkspaceTree,
  buildWorkspaceTree,
} from '@openspec-ide/core';
import { parse as parseYaml } from 'yaml';
import type { OpenspecClient } from './openspec/client.js';
import { toPosixPath } from './process/platform.js';

/** Собирает дерево рабочего пространства и поисковый индекс по данным CLI. */
export class WorkspaceReader {
  readonly #client: OpenspecClient;

  constructor(client: OpenspecClient) {
    this.#client = client;
  }

  /** Читает всё, что нужно дереву, одним проходом. */
  async readTree(): Promise<{ tree: WorkspaceTree; errors: readonly string[] }> {
    const errors: string[] = [];
    const [changesResult, specsResult, schemasResult] = await Promise.all([
      this.#client.listChanges(),
      this.#client.listSpecs(),
      this.#client.listSchemas(),
    ]);

    if (!changesResult.ok) errors.push(changesResult.message);
    if (!specsResult.ok) errors.push(specsResult.message);
    if (!schemasResult.ok) errors.push(schemasResult.message);

    const summaries = changesResult.ok ? changesResult.data.changes : [];
    const changes = await Promise.all(
      summaries.map(async (summary) => this.#readChange(summary.name, summary, errors)),
    );

    const input: TreeInput = {
      changes,
      specs: specsResult.ok ? specsResult.data.specs : [],
      schemas: schemasResult.ok ? schemasResult.data : [],
      defaultSchema: await this.#defaultSchema(),
      archived: await this.#archivedChanges(),
    };

    return { tree: buildWorkspaceTree(input), errors };
  }

  /** Строит поисковый индекс по спекам changes и основным спекам. */
  async buildSearchIndex(tree: WorkspaceTree): Promise<SearchIndex> {
    const documents: SearchDocument[] = [];

    for (const change of tree.changes) {
      for (const artifact of change.artifacts) {
        for (const file of artifact.files) {
          const text = await this.#readRelative(
            join(OPENSPEC_DIR, 'changes', change.name, file),
          );
          if (text !== null) {
            documents.push({
              owner: change.name,
              file: join(OPENSPEC_DIR, 'changes', change.name, file),
              text,
            });
          }
        }
      }
    }

    const capabilities: string[] = [];
    const collect = (nodes: WorkspaceTree['capabilities']): void => {
      for (const node of nodes) {
        if (node.isSpec) capabilities.push(node.path);
        collect(node.children);
      }
    };
    collect(tree.capabilities);

    for (const path of capabilities) {
      const file = join(OPENSPEC_DIR, 'specs', path, 'spec.md');
      const text = await this.#readRelative(file);
      if (text !== null) documents.push({ owner: path, file, text });
    }

    return new SearchIndex(
      {
        changes: tree.changes.map((change) => change.name),
        capabilities,
        schemas: tree.schemas.map((schema) => schema.name),
      },
      documents,
    );
  }

  async #readChange(
    name: string,
    summary: { completedTasks: number; totalTasks: number; lastModified?: string | undefined },
    errors: string[],
  ): Promise<TreeInput['changes'][number]> {
    const [statusResult, validateResult] = await Promise.all([
      this.#client.status(name),
      this.#client.validate(name),
    ]);

    const progress =
      summary.totalTasks > 0 || summary.completedTasks > 0
        ? { complete: summary.completedTasks, total: summary.totalTasks }
        : { complete: 0, total: 0 };

    if (!statusResult.ok) {
      errors.push(statusResult.message);
      return {
        name,
        schema: 'неизвестна',
        progress,
        trackedArtifactId: null,
        artifacts: [],
        issues: [],
        lastModified: summary.lastModified,
        schemaError: statusResult.message,
      };
    }

    const status = statusResult.data;
    const trackedArtifactId = await this.#trackedArtifactId(status.schemaName, status.artifactPaths);

    const artifacts = status.artifacts.map((artifact) => {
      const paths = status.artifactPaths[artifact.id];
      const changeRoot = status.changeRoot;
      return {
        id: artifact.id,
        outputPath: paths?.outputPath ?? `${artifact.id}.md`,
        existingOutputPaths: (paths?.existingOutputPaths ?? []).map((path) =>
          toPosixPath(relative(changeRoot, path)),
        ),
        status: artifact.status,
      };
    });

    const issues = validateResult.ok
      ? (validateResult.data.items.find((item) => item.id === name)?.issues ?? [])
      : [];

    return {
      name,
      schema: status.schemaName,
      progress,
      trackedArtifactId,
      artifacts,
      issues,
      lastModified: summary.lastModified,
      schemaError: null,
    };
  }

  /**
   * Определяет, какой артефакт схема объявила отслеживаемым.
   *
   * Поле `apply.tracks` схемы содержит путь файла, а дереву нужен
   * идентификатор артефакта — сопоставляем по порождаемому пути.
   */
  async #trackedArtifactId(
    schemaName: string,
    artifactPaths: Record<string, { outputPath: string }>,
  ): Promise<string | null> {
    const tracks = await this.#schemaTracks(schemaName);
    if (tracks === null) return null;

    for (const [id, paths] of Object.entries(artifactPaths)) {
      if (paths.outputPath === tracks) return id;
    }
    return null;
  }

  async #schemaTracks(schemaName: string): Promise<string | null> {
    const which = await this.#client.schemaWhich(schemaName);
    if (!which.ok) return null;

    try {
      const text = await readFile(join(which.data.path, 'schema.yaml'), 'utf8');
      const parsed: unknown = parseYaml(text);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const apply = (parsed as { apply?: { tracks?: unknown } }).apply;
      return typeof apply?.tracks === 'string' ? apply.tracks : null;
    } catch {
      return null;
    }
  }

  async #defaultSchema(): Promise<string | null> {
    const text = await this.#readRelative(join(OPENSPEC_DIR, 'config.yaml'));
    if (text === null) return null;
    try {
      const parsed: unknown = parseYaml(text);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const schema = (parsed as { schema?: unknown }).schema;
      return typeof schema === 'string' ? schema : null;
    } catch {
      return null;
    }
  }

  async #archivedChanges(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.#client.root, OPENSPEC_DIR, 'changes', 'archive'), {
        withFileTypes: true,
      });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  async #readRelative(path: string): Promise<string | null> {
    try {
      return await readFile(join(this.#client.root, path), 'utf8');
    } catch {
      return null;
    }
  }
}
