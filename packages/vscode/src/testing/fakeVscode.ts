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
  private constructor(
    readonly fsPath: string,
    readonly scheme: string = 'file',
    readonly path: string = fsPath,
    readonly query: string = '',
  ) {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static from(parts: { scheme: string; path: string; query?: string }): Uri {
    return new Uri(parts.path, parts.scheme, parts.path, parts.query ?? '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(join(base.fsPath, ...segments));
  }

  toString(): string {
    if (this.scheme !== 'file') return `${this.scheme}:${this.path}${this.query === '' ? '' : `?${this.query}`}`;
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

export enum CompletionItemKind {
  Method = 1,
  Class = 6,
  Module = 8,
  Snippet = 14,
  Reference = 17,
}

export class SnippetString {
  constructor(readonly value: string) {}
}

export class MarkdownString {
  constructor(readonly value: string) {}
}

export class CompletionItem {
  insertText?: string | SnippetString;
  filterText?: string;
  detail?: string;
  documentation?: MarkdownString;
  range?: Range;

  constructor(
    readonly label: string,
    readonly kind: CompletionItemKind,
  ) {}
}

export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind('quickfix');
  constructor(readonly value: string) {}
}

export class WorkspaceEdit {
  readonly replacements: { uri: Uri; range: Range; newText: string }[] = [];
  replace(uri: Uri, range: Range, newText: string): void {
    this.replacements.push({ uri, range, newText });
  }
}

export class CodeAction {
  edit?: WorkspaceEdit;
  isPreferred?: boolean;
  diagnostics?: Diagnostic[];
  constructor(
    readonly title: string,
    readonly kind: CodeActionKind,
  ) {}
}

export class Hover {
  constructor(readonly contents: MarkdownString) {}
}

export class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Position | Range,
  ) {}
}

export enum SymbolKind {
  Namespace = 2,
  Class = 4,
  Method = 5,
  Event = 23,
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  constructor(
    readonly name: string,
    readonly detail: string,
    readonly kind: SymbolKind,
    readonly range: Range,
    readonly selectionRange: Range,
  ) {}
}

export class SymbolInformation {
  constructor(
    readonly name: string,
    readonly kind: SymbolKind,
    readonly containerName: string,
    readonly location: Location,
  ) {}
}

export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: { title: string; command: string; arguments?: unknown[] },
  ) {}
}

/** Документ редактора: текст задаёт тест. */
export class FakeTextDocument {
  isDirty = false;
  constructor(
    readonly uri: Uri,
    public text: string,
  ) {}

  getText(): string {
    return this.text;
  }

  get lineCount(): number {
    return this.text.split('\n').length;
  }

  lineAt(line: number): { text: string } {
    return { text: this.text.split('\n')[line] ?? '' };
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
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
  readonly messages: { level: 'info' | 'warning' | 'error'; text: string; detail?: string; buttons: string[] }[];
  /** Открытые сравнения `vscode.diff`: левая и правая стороны и заголовок. */
  readonly diffs: { left: Uri; right: Uri; title: string }[];
  /** Наблюдатели за файлами рабочей области: тест сообщает о создании и удалении. */
  readonly fileWatchers: { created: EventEmitter<Uri>; deleted: EventEmitter<Uri> }[];
  /** Провайдеры виртуальных документов по схеме. */
  readonly contentProviders: Map<string, { provideTextDocumentContent(uri: Uri): string }>;
  readonly diagnostics: Map<string, Diagnostic[]>;
  /** Языковые провайдеры по виду: `completion`, `codeAction`, `hover`, `definition`, `codeLens`, `documentSymbol`, `workspaceSymbol`. */
  readonly providers: Map<string, unknown[]>;
  /** Открытые документы редактора. */
  readonly textDocuments: FakeTextDocument[];
  /** Сообщает расширению о правке документа, как VS Code. */
  changeDocument(document: FakeTextDocument, text: string): void;
  readonly statusBar: { text: string; tooltip?: string; command?: string };
  /** Очередь ответов на showInputBox / showQuickPick / модальные вопросы. */
  readonly answers: unknown[];
  workspaceFolders: { uri: Uri }[];
  /** Настройки пользователя по полному ключу (`openspec.cliPath`). */
  readonly settings: Map<string, unknown>;
  /** Меняет настройку и сообщает об этом, как VS Code. */
  setSetting(key: string, value: unknown): void;
}

export function createFakeVscode(folders: readonly string[]): { module: Record<string, unknown>; state: FakeState } {
  const state: FakeState = {
    commands: new Map(),
    context: new Map(),
    treeViews: new Map(),
    panels: [],
    shownDocuments: [],
    messages: [],
    diffs: [],
    fileWatchers: [],
    contentProviders: new Map(),
    diagnostics: new Map(),
    providers: new Map(),
    textDocuments: [],
    changeDocument: (document, text) => {
      document.text = text;
      document.isDirty = true;
      documentEvents.fire({ document });
    },
    statusBar: { text: '' },
    answers: [],
    workspaceFolders: folders.map((folder) => ({ uri: Uri.file(folder) })),
    settings: new Map(),
    setSetting: (key, value) => {
      state.settings.set(key, value);
      configurationEvents.fire({ affectsConfiguration: (section: string) => key === section || key.startsWith(`${section}.`) });
    },
  };
  const configurationEvents = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
  const documentEvents = new EventEmitter<{ document: FakeTextDocument }>();
  const collections = new Set<Map<string, Diagnostic[]>>();
  const provider =
    (kind: string) =>
    (...args: unknown[]) => {
      const found = args.find((arg) => typeof arg === 'object' && arg !== null && !Array.isArray(arg) && Object.values(arg).some((value) => typeof value === 'function'));
      state.providers.set(kind, [...(state.providers.get(kind) ?? []), found]);
      return { dispose: () => undefined };
    };
  const folderEvents = new EventEmitter<void>();
  const disposable = { dispose: () => undefined };

  const answer = async (): Promise<unknown> => state.answers.shift();

  const message =
    (level: 'info' | 'warning' | 'error') =>
    async (text: string, ...rest: unknown[]): Promise<unknown> => {
      const options = typeof rest[0] === 'object' && rest[0] !== null ? (rest[0] as { modal?: boolean; detail?: string }) : null;
      const buttons = rest.filter((item): item is string => typeof item === 'string');
      state.messages.push({ level, text, ...(options?.detail === undefined ? {} : { detail: options.detail }), buttons });
      const modal = options?.modal;
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
    CompletionItem,
    CompletionItemKind,
    SnippetString,
    MarkdownString,
    CodeAction,
    CodeActionKind,
    WorkspaceEdit,
    Hover,
    Location,
    SymbolKind,
    DocumentSymbol,
    SymbolInformation,
    CodeLens,
    StatusBarAlignment,
    ViewColumn,
    ProgressLocation,
    window: {
      withProgress: async (_options: unknown, task: (progress: { report(): void }) => Promise<unknown>) =>
        task({ report: () => undefined }),
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
      onDidChangeConfiguration: configurationEvents.event,
      getConfiguration: (section?: string) => ({
        get: <T>(key: string, fallback?: T): T | undefined => {
          const full = section === undefined || section === '' ? key : `${section}.${key}`;
          return state.settings.has(full) ? (state.settings.get(full) as T) : fallback;
        },
      }),
      openTextDocument: async (uri: Uri) => ({ uri }),
      get textDocuments() {
        return state.textDocuments;
      },
      onDidChangeTextDocument: documentEvents.event,
      createFileSystemWatcher: () => {
        const created = new EventEmitter<Uri>();
        const deleted = new EventEmitter<Uri>();
        state.fileWatchers.push({ created, deleted });
        return { onDidCreate: created.event, onDidDelete: deleted.event, onDidChange: new EventEmitter<Uri>().event, dispose: () => undefined };
      },
            registerTextDocumentContentProvider: (
        scheme: string,
        provider: { provideTextDocumentContent(uri: Uri): string },
      ) => {
        state.contentProviders.set(scheme, provider);
        return { dispose: () => state.contentProviders.delete(scheme) };
      },
    },
    languages: {
      registerCompletionItemProvider: provider('completion'),
      registerCodeActionsProvider: provider('codeAction'),
      registerHoverProvider: provider('hover'),
      registerDefinitionProvider: provider('definition'),
      registerCodeLensProvider: provider('codeLens'),
      registerDocumentSymbolProvider: provider('documentSymbol'),
      registerWorkspaceSymbolProvider: provider('workspaceSymbol'),
      // У каждой коллекции свои замечания; общая таблица — их объединение по
      // файлу, как панель «Проблемы».
      createDiagnosticCollection: () => {
        const own = new Map<string, Diagnostic[]>();
        collections.add(own);
        const merge = (path: string): void => {
          const all = [...collections].flatMap((collection) => collection.get(path) ?? []);
          if (all.length === 0) state.diagnostics.delete(path);
          else state.diagnostics.set(path, all);
        };
        const clear = (): void => {
          const paths = [...own.keys()];
          own.clear();
          for (const path of paths) merge(path);
        };
        return {
          set: (uri: Uri, list: Diagnostic[]) => {
            own.set(uri.fsPath, list);
            merge(uri.fsPath);
          },
          delete: (uri: Uri) => {
            own.delete(uri.fsPath);
            merge(uri.fsPath);
          },
          clear,
          dispose: () => {
            clear();
            collections.delete(own);
          },
        };
      },
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
        if (id === 'vscode.diff') {
          state.diffs.push({ left: args[0] as Uri, right: args[1] as Uri, title: args[2] as string });
          return undefined;
        }
        return state.commands.get(id)?.(...args);
      },
    },
  };

  return { module, state };
}
