import { join } from 'node:path';
import {
  type AuthoringSources,
  type QualityIssue,
  authoringIssues,
  codeActions,
  codeLenses,
  completions,
  definition,
  documentKind,
  hover,
  planSymbols,
  specQuality,
  withDocumentText,
  workspaceSymbols,
} from '@openspec-ide/core';
import * as vscode from 'vscode';
import { LENS_COMMANDS, authoringDiagnostics, lensCommand, qualityDiagnostics, relativeToRoot } from './authoringModel.js';
import { qualityKey } from './treeModel.js';
import type { FileDiagnostic } from './diagnosticsModel.js';

/** Что функциям редактора нужно от контроллера расширения. */
export interface AuthoringHost {
  readonly root: () => string | null;
  /** Запрос к бэкенду; `null` при отказе (о нём уже сообщено или он неважен). */
  readonly request: (method: 'GET' | 'POST', path: string, body?: unknown, quiet?: boolean) => Promise<unknown>;
  readonly openFile: (path: string, line: number | null) => Promise<void>;
  /** Ошибки и предупреждения качества по узлам дерева (`change:<имя>`, `spec:<capability>`). */
  readonly onQuality?: (counts: ReadonlyMap<string, number>) => void;
}

/** Задержка пересчёта замечаний при наборе, мс. */
const TYPING_DELAY_MS = 300;

const SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'markdown', pattern: '**/openspec/**/*.md' },
];

/**
 * Языковые функции для спеков, дельт и плана: дополнения, исправления,
 * наведение, переход, подсказки над строками, структура плана, поиск
 * символов и проверки ссылок.
 *
 * Ответы считает `core` по источникам из бэкенда; текст открытого документа
 * берётся из редактора, чтобы работали несохранённые правки.
 */
export class AuthoringFeatures implements vscode.Disposable {
  readonly #host: AuthoringHost;
  readonly #issues = vscode.languages.createDiagnosticCollection('openspec-authoring');
  /** Замечания качества спеков — отдельно, чтобы их было видно и фильтровать по источнику. */
  readonly #quality = vscode.languages.createDiagnosticCollection('openspec-quality');
  readonly #lensesChanged = new vscode.EventEmitter<void>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** Файлы, на которые легли замечания, — чтобы снимать устаревшие. */
  #diagnosed = new Set<string>();
  #qualityDiagnosed = new Set<string>();
  #sources: AuthoringSources = { mainSpecs: [], changes: [] };
  #projectIssues: readonly QualityIssue[] = [];
  #loading: Promise<void> | null = null;
  #again = false;

  constructor(host: AuthoringHost) {
    this.#host = host;
  }

  register(): vscode.Disposable[] {
    return [
      this.#issues,
      this.#quality,
      this.#lensesChanged,
      vscode.languages.registerCompletionItemProvider(SELECTOR, { provideCompletionItems: (d, p) => this.#completions(d, p) }, ' ', '#', ':', '`', '/'),
      vscode.languages.registerCodeActionsProvider(
        SELECTOR,
        { provideCodeActions: (d, r, c) => this.#codeActions(d, r, c) },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
      ),
      vscode.languages.registerHoverProvider(SELECTOR, { provideHover: (d, p) => this.#hover(d, p) }),
      vscode.languages.registerDefinitionProvider(SELECTOR, { provideDefinition: (d, p) => this.#definition(d, p) }),
      vscode.languages.registerCodeLensProvider(SELECTOR, {
        onDidChangeCodeLenses: this.#lensesChanged.event,
        provideCodeLenses: (d) => this.#codeLenses(d),
      }),
      vscode.languages.registerDocumentSymbolProvider(SELECTOR, { provideDocumentSymbols: (d) => this.#planSymbols(d) }),
      vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: (query) => this.#workspaceSymbols(query) }),
      vscode.commands.registerCommand(LENS_COMMANDS.openLocation, (path: string, line: number) =>
        this.#host.openFile(path, line),
      ),
      vscode.commands.registerCommand(LENS_COMMANDS.addPlanItem, (change: string, capability: string, requirement: string) =>
        this.#addPlanItem(change, capability, requirement),
      ),
      vscode.workspace.onDidChangeTextDocument((event) => this.#scheduleDocument(event.document)),
      { dispose: () => this.#clearTimers() },
    ];
  }

  dispose(): void {
    this.#clearTimers();
    this.#issues.dispose();
    this.#quality.dispose();
    this.#lensesChanged.dispose();
  }

  /** Источники текущего состояния — нужны тестам. */
  get sources(): AuthoringSources {
    return this.#sources;
  }

  /** Перечитывает источники и пересчитывает все замечания. Запросы во время чтения сливаются. */
  async reload(): Promise<void> {
    if (this.#loading !== null) {
      this.#again = true;
      return this.#loading;
    }
    this.#loading = (async () => {
      do {
        this.#again = false;
        const reply = (await this.#host.request('GET', '/api/authoring', undefined, true)) as AuthoringSources | null;
        this.#sources = reply ?? { mainSpecs: [], changes: [] };
        // Проверки по диску (тесты из плана, код модулей домена) — при перечитывании, а не при наборе.
        const project = (await this.#host.request('GET', '/api/quality/project', undefined, true)) as { issues: QualityIssue[] } | null;
        this.#projectIssues = reply === null ? [] : (project?.issues ?? []);
        this.#publishAll();
      } while (this.#again);
    })().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  /** Снимает всё — бэкенд остановлен или рабочее пространство сменилось. */
  clear(): void {
    this.#sources = { mainSpecs: [], changes: [] };
    this.#projectIssues = [];
    this.#issues.clear();
    this.#diagnosed.clear();
    this.#quality.clear();
    this.#qualityDiagnosed.clear();
    this.#lensesChanged.fire();
  }

  #clearTimers(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Источники с текстами открытых документов вместо дисковых. */
  #liveSources(): AuthoringSources {
    let sources = this.#sources;
    for (const document of vscode.workspace.textDocuments ?? []) {
      if (!document.isDirty) continue;
      const path = this.#path(document);
      if (path !== null && documentKind(sources, path) !== null) sources = withDocumentText(sources, path, document.getText());
    }
    return sources;
  }

  #publishAll(): void {
    const root = this.#host.root();
    const sources = this.#liveSources();
    this.#diagnosed = this.#publishCollection(
      this.#issues,
      this.#diagnosed,
      root === null ? new Map() : authoringDiagnostics(authoringIssues(sources)),
      'openspec-authoring',
    );
    const quality = root === null ? [] : [...specQuality(sources).issues, ...this.#projectIssues];
    this.#qualityDiagnosed = this.#publishCollection(this.#quality, this.#qualityDiagnosed, qualityDiagnostics(quality), 'openspec-quality');
    const counts = new Map<string, number>();
    for (const issue of quality) {
      const key = issue.level === 'info' ? null : qualityKey(issue.path);
      if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    this.#host.onQuality?.(counts);
    this.#lensesChanged.fire();
  }

  /** Публикует замечания по файлам и снимает их с файлов, где их больше нет. */
  #publishCollection(
    collection: vscode.DiagnosticCollection,
    previous: ReadonlySet<string>,
    byFile: ReadonlyMap<string, FileDiagnostic[]>,
    source: string,
  ): Set<string> {
    const next = new Set<string>();
    for (const [path, list] of byFile) {
      const uri = vscode.Uri.file(join(this.#host.root() ?? '', path));
      collection.set(uri, list.map((item) => toDiagnostic(item, source)));
      next.add(uri.fsPath);
    }
    for (const path of previous) {
      if (!next.has(path)) collection.delete(vscode.Uri.file(path));
    }
    return next;
  }

  #scheduleDocument(document: vscode.TextDocument): void {
    const path = this.#path(document);
    if (path === null || documentKind(this.#sources, path) === null) return;
    const key = document.uri.fsPath;
    const pending = this.#timers.get(key);
    if (pending !== undefined) clearTimeout(pending);
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        this.#publishDocument(document, path);
      }, TYPING_DELAY_MS),
    );
  }

  #publishDocument(document: vscode.TextDocument, path: string): void {
    const sources = withDocumentText(this.#sources, path, document.getText());
    const publish = (collection: vscode.DiagnosticCollection, diagnosed: Set<string>, list: readonly FileDiagnostic[], source: string): void => {
      if (list.length === 0) {
        collection.delete(document.uri);
        diagnosed.delete(document.uri.fsPath);
      } else {
        collection.set(document.uri, list.map((item) => toDiagnostic(item, source)));
        diagnosed.add(document.uri.fsPath);
      }
    };
    publish(this.#issues, this.#diagnosed, authoringDiagnostics(authoringIssues(sources, path)).get(path) ?? [], 'openspec-authoring');
    publish(this.#quality, this.#qualityDiagnosed, qualityDiagnostics([...specQuality(sources, path).issues, ...this.#projectIssues.filter((issue) => issue.path === path)]).get(path) ?? [], 'openspec-quality');
  }

  #path(document: vscode.TextDocument): string | null {
    return relativeToRoot(this.#host.root(), document.uri.fsPath);
  }

  #uri(path: string): vscode.Uri {
    return vscode.Uri.file(join(this.#host.root() ?? '', path));
  }

  #completions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const path = this.#path(document);
    if (path === null) return [];
    return completions(this.#sources, path, document.getText(), position.line + 1, position.character).map((entry) => {
      const item = new vscode.CompletionItem(
        entry.label,
        entry.kind === 'section'
          ? vscode.CompletionItemKind.Module
          : entry.kind === 'template'
            ? vscode.CompletionItemKind.Snippet
            : entry.kind === 'requirement'
              ? vscode.CompletionItemKind.Class
              : vscode.CompletionItemKind.Reference,
      );
      item.insertText = entry.snippet ? new vscode.SnippetString(entry.insertText) : entry.insertText;
      item.filterText = entry.filterText;
      item.detail = entry.detail;
      if (entry.documentation !== null) item.documentation = new vscode.MarkdownString(entry.documentation);
      item.range = new vscode.Range(position.line, entry.replaceFrom, position.line, position.character);
      return item;
    });
  }

  #codeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const path = this.#path(document);
    if (path === null) return [];
    return codeActions(this.#sources, path, document.getText(), range.start.line + 1).map((entry) => {
      const action = new vscode.CodeAction(entry.title, vscode.CodeActionKind.QuickFix);
      const edit = new vscode.WorkspaceEdit();
      for (const change of entry.edits) {
        edit.replace(
          this.#uri(change.path),
          new vscode.Range(change.range.startLine - 1, change.range.startCharacter, change.range.endLine - 1, change.range.endCharacter),
          change.newText,
        );
      }
      action.edit = edit;
      action.isPreferred = entry.preferred;
      action.diagnostics = context.diagnostics.filter(
        (diagnostic) => diagnostic.source === 'openspec-authoring' && diagnostic.range.start.line === range.start.line,
      );
      return action;
    });
  }

  #hover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
    const path = this.#path(document);
    if (path === null) return null;
    const text = hover(this.#sources, path, document.getText(), position.line + 1);
    return text === null ? null : new vscode.Hover(new vscode.MarkdownString(text));
  }

  #definition(document: vscode.TextDocument, position: vscode.Position): vscode.Location[] {
    const path = this.#path(document);
    if (path === null) return [];
    return definition(this.#sources, path, document.getText(), position.line + 1).map(
      (location) => new vscode.Location(this.#uri(location.path), new vscode.Position(location.line - 1, 0)),
    );
  }

  #codeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const path = this.#path(document);
    if (path === null) return [];
    return codeLenses(this.#sources, path, document.getText()).map((lens) => {
      const command = lensCommand(lens.action);
      return new vscode.CodeLens(new vscode.Range(lens.line - 1, 0, lens.line - 1, 0), {
        title: lens.title,
        command: command?.command ?? '',
        arguments: command?.arguments ?? [],
      });
    });
  }

  #planSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const path = this.#path(document);
    if (path === null || documentKind(this.#sources, path)?.kind !== 'plan') return [];
    const lineLength = (line: number): number => document.lineAt(Math.min(line, document.lineCount) - 1).text.length;
    const convert = (symbol: ReturnType<typeof planSymbols>[number]): vscode.DocumentSymbol => {
      const end = Math.max(symbol.line, Math.min(symbol.endLine, document.lineCount));
      const result = new vscode.DocumentSymbol(
        symbol.name,
        symbol.detail,
        symbol.kind === 'group' ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Event,
        new vscode.Range(symbol.line - 1, 0, end - 1, lineLength(end)),
        new vscode.Range(symbol.line - 1, 0, symbol.line - 1, lineLength(symbol.line)),
      );
      result.children = symbol.children.map(convert);
      return result;
    };
    return planSymbols(document.getText()).map(convert);
  }

  #workspaceSymbols(query: string): vscode.SymbolInformation[] {
    return workspaceSymbols(this.#liveSources(), query).map(
      (entry) =>
        new vscode.SymbolInformation(
          entry.name,
          entry.kind === 'requirement' ? vscode.SymbolKind.Class : vscode.SymbolKind.Method,
          entry.container,
          new vscode.Location(this.#uri(entry.location.path), new vscode.Position(entry.location.line - 1, 0)),
        ),
    );
  }

  async #addPlanItem(change: string, capability: string, requirement: string): Promise<void> {
    const reply = (await this.#host.request('POST', '/api/trace/item', { change, capability, requirement })) as {
      planPath: string | null;
    } | null;
    if (reply === null) return;
    void vscode.window.showInformationMessage(`В план «${change}» добавлен пункт со ссылкой на «${requirement}».`);
    await this.reload();
    if (reply.planPath !== null) await this.#host.openFile(reply.planPath, null);
  }
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
} as const;

function toDiagnostic(item: FileDiagnostic, source: string): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(item.line, 0, item.line, Number.MAX_SAFE_INTEGER),
    item.message,
    SEVERITY[item.level],
  );
  diagnostic.source = source;
  if (item.code !== undefined) diagnostic.code = item.code;
  return diagnostic;
}
