import * as vscode from 'vscode';
import type { TreeNode } from './treeModel.js';

/** Команда, которую выполняет выбор узла с действием. */
export const OPEN_NODE_COMMAND = 'openspec.openNode';

/** Тонкий провайдер: превращает узлы модели в `TreeItem`. */
export class WorkspaceTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  readonly #changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #nodes: readonly TreeNode[] = [];

  get nodes(): readonly TreeNode[] {
    return this.#nodes;
  }

  set(nodes: readonly TreeNode[]): void {
    this.#nodes = nodes;
    this.#changed.fire(undefined);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return [...(node === undefined ? this.#nodes : node.children)];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const state =
      node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;

    const item = new vscode.TreeItem(node.label, state);
    item.id = node.id;
    if (node.description !== undefined) item.description = node.description;
    if (node.tooltip !== undefined) item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    item.iconPath =
      node.icon.color === undefined
        ? new vscode.ThemeIcon(node.icon.id)
        : new vscode.ThemeIcon(node.icon.id, new vscode.ThemeColor(node.icon.color));
    if (node.action !== undefined) {
      item.command = { command: OPEN_NODE_COMMAND, title: 'Открыть', arguments: [node] };
    }
    return item;
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
