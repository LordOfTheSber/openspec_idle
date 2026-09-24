/**
 * Минимальная подмена модуля `vscode` для дымового теста собранного бандла.
 *
 * Настоящий VS Code в среде сборки недоступен, поэтому тест загружает
 * `dist/extension.cjs` с этим модулем вместо `vscode` и проверяет, что
 * расширение активируется, регистрирует объявленное и отвечает панели.
 * Подмена записывает вызовы, а ответы на диалоги задаются тестом.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

type Listener<T> = (value: T) => unknown;

export class EventEmitter<T> {
  readonly #listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.#listeners]) listener(value);
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export class Uri {
  private constructor(readonly fsPath: string) {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(join(base.fsPath, ...segments));
  }

  toString(): string {
    return pathToFileURL(this.fsPath).href;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState,
  ) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    this.start = typeof a === 'number' ? new Position(a, b as number) : a;
    this.end = typeof a === 'number' ? new Position(c ?? 0, d ?? 0) : (b as Position);
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  source?: string;

  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: DiagnosticSeverity,
  ) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}

/** Webview, в которую тест может «прислать» сообщение от интерфейса. */
export class FakeWebview {
  html = '';
  readonly cspSource = 'vscode-webview://fake';
  readonly posted: unknown[] = [];
  readonly #received = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.#received.event;

  asWebviewUri(uri: Uri): Uri {
    return Uri.file(`/webview${uri.fsPath}`);
  }

  async postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return true;
  }

  /** Имитирует сообщение от интерфейса панели. */
  receive(message: unknown): void {
    this.#received.fire(message);
  }
}

export class FakeWebviewPanel {
  readonly webview = new FakeWebview();
  iconPath?: Uri;
  revealed = 0;
  disposed = false;
  readonly #disposed = new EventEmitter<void>();
  readonly onDidDispose = this.#disposed.event;

  constructor(
    readonly viewType: string,
    public title: string,
    readonly options: unknown,
  ) {}

  reveal(): void {
    this.revealed += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#disposed.fire();
  }
}

/** Записанные действия расширения и ответы на его диалоги. */
export interface FakeState {
  readonly commands: Map<string, (...args: unknown[]) => unknown>;
  readonly context: Map<string, unknown>;
  readonly treeViews: Map<string, { treeDataProvider: unknown }>;
  readonly panels: FakeWebviewPanel[];
  readonly shownDocuments: { path: string; line: number | null }[];
  readonly messages: { level: 'info' | 'warning' | 'error'; text: string }[];
  readonly diagnostics: Map<string, Diagnostic[]>;
  readonly statusBar: { text: string; tooltip?: string; command?: string };
  /** Очередь ответов на showInputBox / showQuickPick / модальные вопросы. */
  readonly answers: unknown[];
  workspaceFolders: { uri: Uri }[];
}

export function createFakeVscode(folders: readonly string[]): { module: Record<string, unknown>; state: FakeState } {
  const state: FakeState = {
    commands: new Map(),
    context: new Map(),
    treeViews: new Map(),
    panels: [],
    shownDocuments: [],
    messages: [],
    diagnostics: new Map(),
    statusBar: { text: '' },
    answers: [],
    workspaceFolders: folders.map((folder) => ({ uri: Uri.file(folder) })),
  };
  const folderEvents = new EventEmitter<void>();
  const disposable = { dispose: () => undefined };

  const answer = async (): Promise<unknown> => state.answers.shift();

  const message =
    (level: 'info' | 'warning' | 'error') =>
    async (text: string, ...rest: unknown[]): Promise<unknown> => {
      state.messages.push({ level, text });
      const modal = typeof rest[0] === 'object' && rest[0] !== null && (rest[0] as { modal?: boolean }).modal;
      return modal === true && rest.length > 1 ? answer() : undefined;
    };

  const module = {
    EventEmitter,
    Uri,
    TreeItem,
    TreeItemCollapsibleState,
    ThemeIcon,
    ThemeColor,
    Position,
    Range,
    Diagnostic,
    DiagnosticSeverity,
    StatusBarAlignment,
    ViewColumn,
    window: {
      createStatusBarItem: () =>
        Object.assign(state.statusBar, { show: () => undefined, dispose: () => undefined }),
      createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
        state.treeViews.set(id, options);
        return disposable;
      },
      createWebviewPanel: (viewType: string, title: string, _column: unknown, options: unknown) => {
        const panel = new FakeWebviewPanel(viewType, title, options);
        state.panels.push(panel);
        return panel;
      },
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      showInputBox: answer,
      showQuickPick: async (items: { label: string }[]) => {
        const wanted = await answer();
        return items.find((item) => item.label === wanted);
      },
      showTextDocument: async (document: { uri: Uri }, options?: { selection?: Range }) => {
        state.shownDocuments.push({
          path: document.uri.fsPath,
          line: options?.selection === undefined ? null : options.selection.start.line + 1,
        });
      },
    },
    workspace: {
      get workspaceFolders() {
        return state.workspaceFolders;
      },
      onDidChangeWorkspaceFolders: folderEvents.event,
      openTextDocument: async (uri: Uri) => ({ uri }),
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri: Uri, list: Diagnostic[]) => state.diagnostics.set(uri.fsPath, list),
        delete: (uri: Uri) => state.diagnostics.delete(uri.fsPath),
        dispose: () => state.diagnostics.clear(),
      }),
    },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        state.commands.set(id, handler);
        return { dispose: () => state.commands.delete(id) };
      },
      executeCommand: async (id: string, ...args: unknown[]) => {
        if (id === 'setContext') {
          state.context.set(args[0] as string, args[1]);
          return undefined;
        }
        return state.commands.get(id)?.(...args);
      },
    },
  };

  return { module, state };
}
