import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { OPENSPEC_DIR } from '@openspec-ide/core';
import type { OpenspecClient } from './openspec/client.js';
import { resolveInsideWorkspace } from './http/paths.js';

/** Создание артефакта не удалось; текст предназначен пользователю. */
export class ArtifactCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactCreationError';
  }
}

/** Что создавать. */
export interface CreateArtifactRequest {
  readonly change: string;
  readonly artifact: string;
  /**
   * Путь capability относительно `specs/` — обязателен для артефакта,
   * порождающего несколько файлов по шаблону пути.
   */
  readonly capabilityPath?: string | undefined;
}

/** Созданный файл артефакта. */
export interface CreatedArtifact {
  /** Путь относительно корня рабочего пространства. */
  readonly path: string;
  readonly content: string;
}

/**
 * Создаёт отсутствующий артефакт из шаблона его схемы.
 *
 * Шаблон берётся у CLI (`openspec templates --schema`), а не из встроенного
 * набора: собственная схема приносит свои шаблоны, и подставлять вместо них
 * чужие значило бы игнорировать процесс команды.
 */
export async function createArtifact(
  client: OpenspecClient,
  request: CreateArtifactRequest,
): Promise<CreatedArtifact> {
  const status = await client.status(request.change);
  if (!status.ok) throw new ArtifactCreationError(status.message);

  const paths = status.data.artifactPaths[request.artifact];
  if (paths === undefined) {
    const known = Object.keys(status.data.artifactPaths).join(', ');
    throw new ArtifactCreationError(
      `Схема «${status.data.schemaName}» не объявляет артефакт «${request.artifact}». ` +
        `Её артефакты: ${known}`,
    );
  }

  const relativePath = resolveArtifactPath(paths.outputPath, request);
  const changeRoot = join(OPENSPEC_DIR, 'changes', request.change);
  const workspacePath = posix.join(changeRoot, relativePath);
  const absolute = resolveInsideWorkspace(client.root, workspacePath);

  if (await exists(absolute)) {
    throw new ArtifactCreationError(`Файл «${workspacePath}» уже существует`);
  }

  const templates = await client.templates(status.data.schemaName);
  if (!templates.ok) throw new ArtifactCreationError(templates.message);

  const template = templates.data[request.artifact];
  if (template === undefined) {
    throw new ArtifactCreationError(
      `Для артефакта «${request.artifact}» схема не объявила шаблон`,
    );
  }

  let content: string;
  try {
    content = await readFile(template.path, 'utf8');
  } catch (error) {
    throw new ArtifactCreationError(
      `Шаблон артефакта «${request.artifact}» объявлен как ${template.path}, ` +
        `но не читается: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');

  return { path: workspacePath, content };
}

/**
 * Превращает объявленный схемой путь в конкретный.
 *
 * Артефакт со звёздочками в пути порождает не один файл, а по файлу на
 * capability, поэтому для него нужен путь capability.
 */
export function resolveArtifactPath(
  outputPath: string,
  request: CreateArtifactRequest,
): string {
  if (!outputPath.includes('*')) return outputPath;

  const capability = request.capabilityPath?.trim();
  if (capability === undefined || capability === '') {
    throw new ArtifactCreationError(
      `Артефакт «${request.artifact}» порождает файлы по шаблону «${outputPath}». ` +
        'Укажите путь capability, для которой создаётся файл.',
    );
  }
  if (capability.includes('..') || capability.startsWith('/')) {
    throw new ArtifactCreationError(`Недопустимый путь capability: «${capability}»`);
  }

  // `specs/**/*.md` → `specs/<capability-path>/spec.md`
  const base = outputPath.split('/')[0] ?? 'specs';
  const extension = outputPath.slice(outputPath.lastIndexOf('.'));
  const fileName = outputPath.includes('/*')
    ? `spec${extension}`
    : `${capability}${extension}`;
  return posix.join(base, capability, fileName);
}

/** Заготовки, которые редактор вставляет в открытый артефакт. */
export const SNIPPETS = {
  requirement: `### Requirement: Название требования

Система ДОЛЖНА (SHALL) описать здесь наблюдаемое поведение.

#### Scenario: Название сценария

- **WHEN** условие
- **THEN** ожидаемый результат
`,
  scenario: `#### Scenario: Название сценария

- **WHEN** условие
- **THEN** ожидаемый результат
`,
} as const;

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
