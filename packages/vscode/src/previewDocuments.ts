import * as vscode from 'vscode';

/** Схема виртуальных документов предпросмотра архивации. */
export const PREVIEW_SCHEME = 'openspec-preview';

/**
 * Виртуальные документы «спек после архивации» для редактора сравнения.
 *
 * Документы провайдера содержимого VS Code открывает только для чтения, так
 * что правка в правой стороне сравнения до файлов проекта не доходит.
 */
export class PreviewDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly #contents = new Map<string, string>();
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#contents.get(uri.toString()) ?? '';
  }

  /** Документ с этим содержимым; уже открытый обновляется. */
  put(change: string, capability: string, side: 'before' | 'after', content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${change}/${capability}/spec.md`, query: side });
    this.#contents.set(uri.toString(), content);
    this.#changed.fire(uri);
    return uri;
  }

  dispose(): void {
    this.#contents.clear();
    this.#changed.dispose();
  }
}
