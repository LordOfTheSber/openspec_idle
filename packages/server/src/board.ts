import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENSPEC_DIR,
  type Board,
  type BoardChange,
  type BoardSchema,
  buildBoard,
  parseTrackedDocument,
  toggleTrackedItem,
} from '@openspec-ide/core';
import { saveArtifactFile } from './files.js';
import type { OpenspecClient } from './openspec/client.js';
import { runCli } from './openspec/exec.js';
import type { SchemaReader } from './schemaDefinition.js';
import type { WorkspaceReader } from './workspace.js';

/** Операция над change не удалась; текст предназначен пользователю. */
export class ChangeOperationError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = 'ChangeOperationError';
  }
}

/** Пункты отслеживаемого артефакта change. */
export interface TrackedItemsView {
  readonly change: string;
  /** Путь отслеживаемого артефакта относительно корня; `null`, если схема его не объявила. */
  readonly path: string | null;
  readonly items: readonly {
    readonly line: number;
    readonly text: string;
    readonly declaredNumber: string | null;
    readonly group: number;
    /** Порядковый номер пункта внутри группы. */
    readonly index: number;
    readonly done: boolean;
  }[];
  /** Заголовки групп пунктов (`## 1. …`) — чтобы показать пункты по группам. */
  readonly groups: readonly { readonly number: number; readonly title: string }[];
  readonly complete: number;
  readonly total: number;
}

/** Собирает доску и выполняет операции над changes. */
export class BoardService {
  readonly #client: OpenspecClient;
  readonly #workspace: WorkspaceReader;
  readonly #schemas: SchemaReader;
  readonly #bin: string;

  constructor(
    client: OpenspecClient,
    workspace: WorkspaceReader,
    schemas: SchemaReader,
    bin: string,
  ) {
    this.#client = client;
    this.#workspace = workspace;
    this.#schemas = schemas;
    this.#bin = bin;
  }

  async readBoard(): Promise<Board> {
    const { tree } = await this.#workspace.readTree();

    const schemaNames = [...new Set(tree.changes.map((change) => change.schema))];
    const definitions = await Promise.all(schemaNames.map((name) => this.#schemas.read(name)));

    const schemas: BoardSchema[] = [];
    for (const definition of definitions) {
      if (definition === null) continue;
      schemas.push({
        name: definition.name,
        artifacts: definition.artifacts.map((artifact) => ({
          id: artifact.id,
          requires: artifact.requires,
        })),
        trackedArtifactId: trackedArtifactId(definition.tracks, definition.artifacts),
        waivers: definition.waivers,
      });
    }

    const changes: BoardChange[] = tree.changes.map((change) => ({
      name: change.name,
      schema: change.schema,
      artifacts: change.artifacts.map((artifact) => ({
        id: artifact.id,
        done: artifact.state === 'done' || artifact.state === 'draft',
        path:
          artifact.files[0] === undefined
            ? null
            : `${OPENSPEC_DIR}/changes/${change.name}/${artifact.files[0]}`,
      })),
      progress: change.progress,
      errorCount: change.errorCount,
      // Валидация не выполнялась, если у change ещё нет ни одного артефакта:
      // проверять в нём нечего.
      validationUnknown: change.artifacts.every((artifact) => artifact.state === 'missing'),
      lastModified: change.lastModified,
    }));

    return buildBoard(schemas, changes);
  }

  /** Создаёт change выбранной схемой. */
  async createChange(name: string, schema?: string): Promise<void> {
    const args = ['new', 'change', name, ...(schema === undefined ? [] : ['--schema', schema])];
    const result = await runCli({ bin: this.#bin, cwd: this.#client.root }, args);

    if (result.code !== 0) {
      throw new ChangeOperationError(
        `Не удалось создать изменение «${name}»`,
        `${result.stdout}\n${result.stderr}`.trim(),
      );
    }
    this.#client.invalidate();
  }

  /** Архивирует change. */
  async archiveChange(name: string): Promise<void> {
    const result = await runCli({ bin: this.#bin, cwd: this.#client.root }, [
      'archive',
      name,
      '--yes',
    ]);

    if (result.code !== 0) {
      throw new ChangeOperationError(
        `Не удалось архивировать изменение «${name}»`,
        `${result.stdout}\n${result.stderr}`.trim(),
      );
    }
    this.#client.invalidate();
  }

  /** Читает пункты отслеживаемого артефакта change. */
  async readTrackedItems(change: string): Promise<TrackedItemsView> {
    const location = await this.#trackedPath(change);
    if (location === null) {
      return { change, path: null, items: [], groups: [], complete: 0, total: 0 };
    }

    let text: string;
    try {
      text = await readFile(location.absolute, 'utf8');
    } catch {
      return { change, path: location.relative, items: [], groups: [], complete: 0, total: 0 };
    }

    const parsed = parseTrackedDocument(text);
    return {
      change,
      path: location.relative,
      items: parsed.items.map((item) => ({
        line: item.line,
        text: item.text,
        declaredNumber: item.declaredNumber,
        group: item.group,
        index: item.index,
        done: item.done,
      })),
      groups: parsed.groups.map((group) => ({ number: group.number, title: group.title })),
      complete: parsed.complete,
      total: parsed.total,
    };
  }

  /** Переключает отметку пункта, меняя только скобки чекбокса. */
  async toggleItem(change: string, line: number, done: boolean): Promise<TrackedItemsView> {
    const location = await this.#trackedPath(change);
    if (location === null) {
      throw new ChangeOperationError(
        `Схема изменения «${change}» не объявила отслеживаемый артефакт`,
        '',
      );
    }

    const text = await readFile(location.absolute, 'utf8');
    const next = toggleTrackedItem(text, line, done);
    await saveArtifactFile(this.#client.root, location.relative, next, null);
    this.#client.invalidate();

    return this.readTrackedItems(change);
  }

  async #trackedPath(
    change: string,
  ): Promise<{ absolute: string; relative: string } | null> {
    const status = await this.#client.status(change);
    if (!status.ok) return null;

    const definition = await this.#schemas.read(status.data.schemaName);
    const tracks = definition?.tracks;
    if (tracks === undefined || tracks === null) return null;

    const absolute = join(status.data.changeRoot, tracks);
    const relative = absolute.startsWith(this.#client.root)
      ? absolute.slice(this.#client.root.length + 1)
      : absolute;
    return { absolute, relative };
  }
}

/** Сопоставляет путь из `apply.tracks` с идентификатором артефакта схемы. */
function trackedArtifactId(
  tracks: string | null,
  artifacts: readonly { readonly id: string; readonly generates: string }[],
): string | null {
  if (tracks === null) return null;
  return artifacts.find((artifact) => artifact.generates === tracks)?.id ?? null;
}
