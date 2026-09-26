import type { TreeArtifact, TreeCapability, TreeChange, TreeSchema, WorkspaceTree } from '@openspec-ide/core';

/**
 * Модель узлов дерева VS Code, построенная по дереву рабочего пространства.
 *
 * Модуль не зависит от `vscode`: узлы описываются данными, а превращает их в
 * `TreeItem` тонкий провайдер. Так содержимое дерева проверяется тестами без
 * редактора.
 */

/** Иконка узла — имя codicon и, при необходимости, цвет темы. */
export interface NodeIcon {
  readonly id: string;
  readonly color?: string;
}

/** Действие по выбору узла. */
export type NodeAction =
  | { readonly kind: 'open'; readonly path: string }
  | {
      readonly kind: 'create-artifact';
      readonly change: string;
      readonly artifact: string;
      /** Артефакт порождает файл на каждую capability — нужен её путь. */
      readonly perCapability: boolean;
    }
  | { readonly kind: 'open-archived'; readonly name: string };

/** Узел дерева. */
export interface TreeNode {
  /** Уникальный и устойчивый между обновлениями идентификатор. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** Значение `viewItem` для меню. */
  readonly contextValue: string;
  readonly icon: NodeIcon;
  readonly expanded: boolean;
  readonly action?: NodeAction;
  /** Имя change, к которому относится узел, — для команд из контекстного меню. */
  readonly change?: string;
  /** Путь capability — для раздела дельт. */
  readonly capability?: string;
  readonly children: readonly TreeNode[];
}

/** Состояние, в котором дерево отдал бэкенд. */
export type WorkspaceState =
  | { readonly state: 'not-initialized' }
  | {
      readonly state: 'cli-missing';
      /** Есть у ответа бэкенда; в тестах и старых ответах может не быть. */
      readonly notice?: { readonly title: string; readonly hint: string; readonly configured: string | null };
    }
  | {
      readonly state: 'ready';
      readonly root: string;
      readonly tree: WorkspaceTree;
      readonly errors: readonly string[];
    };

const ARTIFACT_ICON: Record<TreeArtifact['state'], NodeIcon> = {
  done: { id: 'pass', color: 'testing.iconPassed' },
  draft: { id: 'circle-large-outline' },
  missing: { id: 'circle-dashed', color: 'disabledForeground' },
  invalid: { id: 'error', color: 'errorForeground' },
};

const ARTIFACT_STATE_LABEL: Record<TreeArtifact['state'], string> = {
  done: 'готов',
  draft: 'черновик',
  missing: 'отсутствует',
  invalid: 'есть ошибки',
};

function progressLabel(progress: { complete: number; total: number } | null): string | null {
  if (progress === null || progress.total === 0) return null;
  return `${progress.complete}/${progress.total}`;
}

function errorsLabel(count: number): string {
  return `${count} ош.`;
}

/** Путь файла артефакта относительно корня рабочего пространства. */
export function artifactPath(change: string, file: string): string {
  return `openspec/changes/${change}/${file}`;
}

function artifactNode(change: TreeChange, artifact: TreeArtifact): TreeNode {
  const file = artifact.files[0];
  const extra = artifact.files.length > 1 ? ` · файлов: ${artifact.files.length}` : '';
  const details = [
    artifact.errorCount > 0 ? errorsLabel(artifact.errorCount) : null,
    progressLabel(artifact.progress),
  ].filter((part): part is string => part !== null);

  const children =
    artifact.files.length > 1
      ? artifact.files.map(
          (path): TreeNode => ({
            id: `file:${change.name}/${path}`,
            label: path,
            contextValue: 'artifact-file',
            icon: { id: 'markdown' },
            expanded: false,
            action: { kind: 'open', path: artifactPath(change.name, path) },
            change: change.name,
            children: [],
          }),
        )
      : [];

  return {
    id: `artifact:${change.name}/${artifact.id}`,
    label: artifact.id,
    ...(details.length === 0 ? {} : { description: details.join(' · ') }),
    tooltip: `${artifact.outputPath} — ${ARTIFACT_STATE_LABEL[artifact.state]}${extra}`,
    contextValue: file === undefined ? 'artifact-missing' : 'artifact',
    icon: ARTIFACT_ICON[artifact.state],
    expanded: false,
    action:
      file === undefined
        ? {
            kind: 'create-artifact',
            change: change.name,
            artifact: artifact.id,
            perCapability: artifact.outputPath.includes('*'),
          }
        : { kind: 'open', path: artifactPath(change.name, file) },
    change: change.name,
    children,
  };
}

function changeNode(change: TreeChange): TreeNode {
  // Ошибки важнее прогресса: работать с невалидным change нельзя.
  const description =
    change.schemaError !== null
      ? 'схема не разрешается'
      : change.errorCount > 0
        ? errorsLabel(change.errorCount)
        : (progressLabel(change.progress) ?? change.schema);

  return {
    id: `change:${change.name}`,
    label: change.name,
    description,
    tooltip: [
      `Схема: ${change.schema}`,
      change.schemaError,
      change.lastModified === null ? null : `Изменён: ${change.lastModified}`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
    contextValue: 'change',
    icon:
      change.errorCount > 0 || change.schemaError !== null
        ? { id: 'git-pull-request', color: 'errorForeground' }
        : { id: 'git-pull-request' },
    expanded: true,
    change: change.name,
    children: change.artifacts.map((artifact) => artifactNode(change, artifact)),
  };
}

function capabilityNode(capability: TreeCapability): TreeNode {
  return {
    id: `capability:${capability.path}`,
    label: capability.segment,
    ...(capability.isSpec && capability.requirementCount !== null
      ? { description: `требований: ${capability.requirementCount}` }
      : {}),
    tooltip: capability.path,
    contextValue: capability.isSpec ? 'capability' : 'capability-segment',
    icon: capability.isSpec ? { id: 'book' } : { id: 'folder' },
    expanded: !capability.isSpec,
    ...(capability.isSpec
      ? { action: { kind: 'open', path: `openspec/specs/${capability.path}/spec.md` } as const }
      : {}),
    capability: capability.path,
    children: capability.children.map(capabilityNode),
  };
}

function schemaNode(schema: TreeSchema): TreeNode {
  const project = schema.source === 'project';
  return {
    id: `schema:${schema.name}`,
    label: schema.name,
    description: [schema.source, schema.isDefault ? 'по умолчанию' : null]
      .filter((part): part is string => part !== null)
      .join(' · '),
    tooltip: [schema.description, `Артефакты: ${schema.artifacts.join(' → ')}`]
      .filter((line): line is string => line !== null && line !== '')
      .join('\n'),
    contextValue: 'schema',
    icon: { id: 'type-hierarchy' },
    expanded: false,
    // Файл есть только у проектной схемы: встроенная и пользовательская лежат
    // вне рабочего пространства.
    ...(project
      ? { action: { kind: 'open', path: `openspec/schemas/${schema.name}/schema.yaml` } as const }
      : {}),
    children: [],
  };
}

function group(id: string, label: string, icon: string, children: readonly TreeNode[], empty: string): TreeNode {
  return {
    id: `group:${id}`,
    label,
    description: children.length === 0 ? empty : String(children.length),
    contextValue: `group-${id}`,
    icon: { id: icon },
    expanded: id !== 'archive',
    children,
  };
}

/** Узлы верхнего уровня дерева. */
export function buildTreeNodes(workspace: WorkspaceState): readonly TreeNode[] {
  if (workspace.state !== 'ready') return [];
  const { tree, errors } = workspace;

  const problems = errors.map(
    (error, index): TreeNode => ({
      id: `error:${index}`,
      label: error,
      tooltip: error,
      contextValue: 'workspace-error',
      icon: { id: 'warning', color: 'problemsWarningIcon.foreground' },
      expanded: false,
      children: [],
    }),
  );

  return [
    ...problems,
    group('changes', 'Изменения', 'git-pull-request', tree.changes.map(changeNode), 'нет активных'),
    group('specs', 'Спеки', 'library', tree.capabilities.map(capabilityNode), 'пусто'),
    group('schemas', 'Процессы', 'type-hierarchy', tree.schemas.map(schemaNode), 'пусто'),
    group(
      'archive',
      'Архив',
      'archive',
      tree.archived.map(
        (name): TreeNode => ({
          id: `archived:${name}`,
          label: name,
          contextValue: 'archived',
          icon: { id: 'archive' },
          expanded: false,
          action: { kind: 'open-archived', name },
          children: [],
        }),
      ),
      'пусто',
    ),
  ];
}

/** Текст строки состояния. */
export function statusText(workspace: WorkspaceState | null): { readonly text: string; readonly tooltip: string } {
  if (workspace === null) return { text: '$(sync~spin) OpenSpec', tooltip: 'OpenSpec: загрузка' };
  switch (workspace.state) {
    case 'not-initialized':
      return { text: '$(circle-slash) OpenSpec', tooltip: 'OpenSpec: проект не инициализирован' };
    case 'cli-missing':
      return {
        text: '$(warning) OpenSpec: нет CLI',
        tooltip: workspace.notice === undefined ? 'Не найден CLI OpenSpec' : `${workspace.notice.title}\n${workspace.notice.hint}`,
      };
    case 'ready':
      return {
        text: `$(git-pull-request) ${workspace.tree.changes.length} · $(book) ${countSpecs(workspace.tree.capabilities)}`,
        tooltip: `OpenSpec: ${workspace.root}\nИзменений: ${workspace.tree.changes.length}, спеков: ${countSpecs(
          workspace.tree.capabilities,
        )}\nЩелчок — доска`,
      };
  }
}

function countSpecs(capabilities: readonly TreeCapability[]): number {
  return capabilities.reduce(
    (total, capability) => total + (capability.isSpec ? 1 : 0) + countSpecs(capability.children),
    0,
  );
}
