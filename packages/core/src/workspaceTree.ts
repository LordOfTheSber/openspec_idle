/**
 * Модель дерева рабочего пространства.
 *
 * Состав артефактов change нигде не задан списком: он приходит из данных схемы,
 * поэтому дерево одинаково работает и для встроенной схемы, и для собственной.
 */

/** Состояние артефакта change. */
export type ArtifactState = 'missing' | 'draft' | 'done' | 'invalid';

/** Артефакт change в дереве. */
export interface TreeArtifact {
  readonly id: string;
  readonly outputPath: string;
  readonly state: ArtifactState;
  /** Число ошибок валидации, отнесённых к этому артефакту. */
  readonly errorCount: number;
  /** Прогресс — только у артефакта, который схема объявила отслеживаемым. */
  readonly progress: { readonly complete: number; readonly total: number } | null;
  /** Существующие файлы артефакта; для glob-артефакта их несколько. */
  readonly files: readonly string[];
}

/** Change в дереве. */
export interface TreeChange {
  readonly name: string;
  readonly schema: string;
  readonly artifacts: readonly TreeArtifact[];
  readonly progress: { readonly complete: number; readonly total: number } | null;
  readonly errorCount: number;
  readonly lastModified: string | null;
  /** Схема change не разрешается — работать с ним нельзя. */
  readonly schemaError: string | null;
}

/** Узел дерева capability: сегмент пути или сам спек. */
export interface TreeCapability {
  /** Сегмент пути, например `identity` или `user-auth`. */
  readonly segment: string;
  /** Полный путь capability относительно `openspec/specs/`. */
  readonly path: string;
  /** Есть ли по этому пути сам спек, а не только промежуточный сегмент. */
  readonly isSpec: boolean;
  readonly requirementCount: number | null;
  readonly children: readonly TreeCapability[];
}

/** Схема процесса в дереве. */
export interface TreeSchema {
  readonly name: string;
  readonly description: string | null;
  readonly source: string;
  readonly artifacts: readonly string[];
  readonly isDefault: boolean;
}

/** Всё дерево рабочего пространства. */
export interface WorkspaceTree {
  readonly changes: readonly TreeChange[];
  readonly capabilities: readonly TreeCapability[];
  readonly schemas: readonly TreeSchema[];
  readonly archived: readonly string[];
}

/** Входные данные для сборки дерева — то, что отдал CLI. */
export interface TreeInput {
  readonly changes: readonly {
    readonly name: string;
    readonly schema: string;
    readonly lastModified?: string | undefined;
    readonly progress: { readonly complete: number; readonly total: number } | null;
    readonly trackedArtifactId: string | null;
    readonly artifacts: readonly {
      readonly id: string;
      readonly outputPath: string;
      readonly existingOutputPaths: readonly string[];
      readonly status?: string | undefined;
    }[];
    readonly issues: readonly { readonly level: string; readonly path?: string | undefined }[];
    readonly schemaError?: string | null | undefined;
  }[];
  readonly specs: readonly { readonly id: string; readonly requirementCount?: number | undefined }[];
  readonly schemas: readonly {
    readonly name: string;
    readonly description?: string | undefined;
    readonly source: string;
    readonly artifacts: readonly string[];
  }[];
  readonly defaultSchema: string | null;
  readonly archived: readonly string[];
}

/** Собирает дерево рабочего пространства из данных CLI. */
export function buildWorkspaceTree(input: TreeInput): WorkspaceTree {
  return {
    changes: input.changes.map(buildChange),
    capabilities: buildCapabilityTree(input.specs),
    schemas: input.schemas.map((schema) => ({
      name: schema.name,
      description: schema.description ?? null,
      source: schema.source,
      artifacts: schema.artifacts,
      isDefault: schema.name === input.defaultSchema,
    })),
    archived: [...input.archived].sort(),
  };
}

function buildChange(change: TreeInput['changes'][number]): TreeChange {
  const errors = change.issues.filter((issue) => issue.level.toUpperCase() === 'ERROR');

  const artifacts = change.artifacts.map((artifact): TreeArtifact => {
    const files = artifact.existingOutputPaths;
    const artifactErrors = errors.filter((issue) =>
      issueBelongsToArtifact(issue.path, artifact.outputPath, files),
    ).length;

    const tracked = change.trackedArtifactId === artifact.id;
    return {
      id: artifact.id,
      outputPath: artifact.outputPath,
      state: artifactState(files.length > 0, artifactErrors, artifact.status),
      errorCount: artifactErrors,
      progress: tracked ? change.progress : null,
      files,
    };
  });

  return {
    name: change.name,
    schema: change.schema,
    artifacts,
    progress: change.progress,
    errorCount: errors.length,
    lastModified: change.lastModified ?? null,
    schemaError: change.schemaError ?? null,
  };
}

function artifactState(exists: boolean, errorCount: number, status?: string): ArtifactState {
  if (!exists) return 'missing';
  if (errorCount > 0) return 'invalid';
  if (status === 'done') return 'done';
  return 'draft';
}

/**
 * Относит замечание валидации к артефакту по пути из отчёта.
 *
 * CLI сообщает путь по-разному: то относительный путь файла, то `file` без
 * уточнения. Замечание без узнаваемого пути к артефакту не привязывается —
 * иначе оно осело бы на первом попавшемся.
 */
function issueBelongsToArtifact(
  issuePath: string | undefined,
  outputPath: string,
  files: readonly string[],
): boolean {
  if (issuePath === undefined || issuePath === '' || issuePath === 'file') return false;
  if (files.some((file) => file.endsWith(issuePath) || issuePath.endsWith(file))) return true;
  const globPrefix = outputPath.split('*')[0] ?? outputPath;
  return globPrefix !== '' && issuePath.startsWith(globPrefix);
}

/**
 * Разворачивает пути capability в дерево сегментов.
 *
 * Вложенность обязана сохраняться: `identity/user-auth` и `billing/user-auth` —
 * разные capability, и схлопывать их по последнему сегменту нельзя.
 */
export function buildCapabilityTree(
  specs: readonly { readonly id: string; readonly requirementCount?: number | undefined }[],
): readonly TreeCapability[] {
  interface Node {
    segment: string;
    path: string;
    isSpec: boolean;
    requirementCount: number | null;
    children: Map<string, Node>;
  }

  const roots = new Map<string, Node>();

  for (const spec of [...specs].sort((a, b) => a.id.localeCompare(b.id))) {
    const segments = spec.id.split('/').filter((segment) => segment !== '');
    let level = roots;
    let path = '';

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] ?? '';
      path = path === '' ? segment : `${path}/${segment}`;
      const last = index === segments.length - 1;

      let node = level.get(segment);
      if (node === undefined) {
        node = { segment, path, isSpec: false, requirementCount: null, children: new Map() };
        level.set(segment, node);
      }
      if (last) {
        node.isSpec = true;
        node.requirementCount = spec.requirementCount ?? null;
      }
      level = node.children;
    }
  }

  const toTree = (node: Node): TreeCapability => ({
    segment: node.segment,
    path: node.path,
    isSpec: node.isSpec,
    requirementCount: node.requirementCount,
    children: [...node.children.values()].map(toTree),
  });

  return [...roots.values()].map(toTree);
}
