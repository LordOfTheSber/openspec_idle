import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PanelSection, PanelSelection } from '@openspec-ide/core';
import {
  type ArchivePreview,
  type EmbeddedBackend,
  type SpecPreview,
  type ValidationRun,
  createEmbeddedBackend,
} from '@openspec-ide/server';
import * as vscode from 'vscode';
import { archiveSummary, specLine } from './archiveSummary.js';
import { resolvePanelPath } from './bridge.js';
import { changesTouched, diagnosticsByFile } from './diagnosticsModel.js';
import { SectionPanel } from './panel.js';
import { PREVIEW_SCHEME, PreviewDocuments } from './previewDocuments.js';
import { pickWorkspaceRoot } from './root.js';
import { type TreeNode, type WorkspaceState, buildTreeNodes, statusText } from './treeModel.js';
import { OPEN_NODE_COMMAND, WorkspaceTreeProvider } from './treeProvider.js';

/** Команды расширения — те же, что объявлены в манифесте. */
export const COMMANDS = {
  refresh: 'openspec.refresh',
  newChange: 'openspec.newChange',
  validateChange: 'openspec.validateChange',
  archiveChange: 'openspec.archiveChange',
  previewArchive: 'openspec.previewArchive',
  openBoard: 'openspec.openBoard',
  openDeltas: 'openspec.openDeltas',
  openMetrics: 'openspec.openMetrics',
  openAgent: 'openspec.openAgent',
  openProcesses: 'openspec.openProcesses',
  openSettings: 'openspec.openSettings',
  openSearch: 'openspec.openSearch',
  openNode: OPEN_NODE_COMMAND,
} as const;

const SECTION_COMMANDS: readonly (readonly [string, PanelSection])[] = [
  [COMMANDS.openBoard, 'board'],
  [COMMANDS.openDeltas, 'deltas'],
  [COMMANDS.openMetrics, 'metrics'],
  [COMMANDS.openAgent, 'agent'],
  [COMMANDS.openProcesses, 'processes'],
  [COMMANDS.openSettings, 'settings'],
  [COMMANDS.openSearch, 'search'],
];

/** Разделы, которые показывают данные одного change. */
const CHANGE_SECTIONS: ReadonlySet<PanelSection> = new Set(['metrics', 'agent']);

/**
 * Состояние расширения в одном окне VS Code: бэкенд, дерево, диагностика,
 * панель разделов и строка состояния.
 */
class OpenspecController implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #tree = new WorkspaceTreeProvider();
  readonly #diagnostics = vscode.languages.createDiagnosticCollection('openspec');
  readonly #status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  readonly #panel: SectionPanel;
  readonly #previews = new PreviewDocuments();
  /** Файлы, на которые легли диагностики каждого change, — чтобы снимать устаревшие. */
  readonly #diagnosed = new Map<string, vscode.Uri[]>();

  #backend: EmbeddedBackend | null = null;
  #unsubscribe: (() => void) | null = null;
  #workspace: WorkspaceState | null = null;
  #refreshing: Promise<void> | null = null;
  #refreshAgain = false;
  #disposed = false;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
    this.#panel = new SectionPanel({
      extensionUri: context.extensionUri,
      backend: () => this.#backend,
      openFile: (path, line, fromPanel) => this.openFile(path, line, fromPanel),
      previewArchive: (change, capability) => this.previewArchive(change, capability),
    });
    this.#status.command = COMMANDS.openBoard;
  }

  get root(): string | null {
    return this.#backend?.root ?? null;
  }

  async start(): Promise<void> {
    const context = this.#context;
    context.subscriptions.push(
      vscode.window.createTreeView('openspec.workspace', {
        treeDataProvider: this.#tree,
        showCollapseAll: true,
      }),
      vscode.commands.registerCommand(COMMANDS.refresh, () => this.refresh()),
      vscode.commands.registerCommand(COMMANDS.openNode, (node: TreeNode) => this.openNode(node)),
      vscode.commands.registerCommand(COMMANDS.newChange, () => this.newChange()),
      vscode.commands.registerCommand(COMMANDS.validateChange, (node?: TreeNode) => this.validateCommand(node)),
      vscode.commands.registerCommand(COMMANDS.archiveChange, (node?: TreeNode) => this.archiveChange(node)),
      vscode.commands.registerCommand(COMMANDS.previewArchive, (node?: TreeNode) => this.previewArchiveCommand(node)),
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this.#previews),
      ...SECTION_COMMANDS.map(([command, section]) =>
        vscode.commands.registerCommand(command, (node?: TreeNode) => this.openSection(section, node)),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.#restart()),
    );

    this.#status.show();
    await this.#restart();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#panel.dispose();
    this.#previews.dispose();
    this.#tree.dispose();
    this.#diagnostics.dispose();
    this.#status.dispose();
    await this.#stopBackend();
  }

  /** Перечитывает дерево. Запросы, пришедшие во время чтения, сливаются в одно повторное. */
  async refresh(): Promise<void> {
    if (this.#refreshing !== null) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      do {
        this.#refreshAgain = false;
        await this.#readWorkspace();
      } while (this.#refreshAgain);
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /** Открывает файл рабочего пространства в редакторе VS Code. */
  async openFile(path: string, line: number | null, fromPanel = false): Promise<void> {
    const absolute = resolvePanelPath(this.root, path);
    if (absolute === null) {
      void vscode.window.showWarningMessage(`Путь «${path}» находится вне рабочего пространства OpenSpec.`);
      return;
    }
    if (!existsSync(absolute)) {
      void vscode.window.showWarningMessage(`Файл «${path}» не найден.`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
    const position = line === null ? null : new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(document, {
      preview: true,
      // Из панели файл открывается рядом, чтобы не закрывать саму панель.
      ...(fromPanel ? { viewColumn: vscode.ViewColumn.Beside } : {}),
      ...(position === null ? {} : { selection: new vscode.Range(position, position) }),
    });
  }

  async openNode(node: TreeNode): Promise<void> {
    const action = node.action;
    if (action === undefined) return;
    switch (action.kind) {
      case 'open':
        await this.openFile(action.path, null);
        return;
      case 'open-archived': {
        const proposal = `openspec/changes/archive/${action.name}/proposal.md`;
        const absolute = resolvePanelPath(this.root, proposal);
        if (absolute !== null && existsSync(absolute)) {
          await this.openFile(proposal, null);
        } else if (this.root !== null) {
          await vscode.commands.executeCommand(
            'revealInExplorer',
            vscode.Uri.file(join(this.root, 'openspec', 'changes', 'archive', action.name)),
          );
        }
        return;
      }
      case 'create-artifact':
        await this.createArtifact(action.change, action.artifact, action.perCapability);
        return;
    }
  }

  async createArtifact(change: string, artifact: string, perCapability: boolean): Promise<void> {
    const generate = 'Сгенерировать агентом';
    const template = 'Пустой по шаблону';
    const generable = await this.#generable(change);
    const answer = generable.has(artifact)
      ? await vscode.window.showInformationMessage(
          `Артефакт «${artifact}» change «${change}» ещё не создан. Как его создать?`,
          {
            modal: true,
            detail:
              'Агент GigaCode CLI напишет его по инструкции схемы и вашему замыслу — запуск нужно будет подтвердить в разделе «Агент». По шаблону — файл с заголовками и заглушками.',
          },
          generate,
          template,
        )
      : await vscode.window.showInformationMessage(
          `Артефакт «${artifact}» change «${change}» ещё не создан. Создать его по шаблону схемы?`,
          { modal: true },
          template,
        );
    if (answer === generate) {
      await this.#generate(change, artifact);
      return;
    }
    if (answer !== template) return;

    let capabilityPath: string | undefined;
    if (perCapability) {
      capabilityPath = await vscode.window.showInputBox({
        title: `Путь capability для артефакта «${artifact}»`,
        prompt: 'Путь относительно specs/, например identity/user-auth',
        validateInput: (value) => (value.trim() === '' ? 'Укажите путь capability' : null),
      });
      if (capabilityPath === undefined) return;
    }

    const reply = await this.#request('POST', '/api/artifact', {
      change,
      artifact,
      ...(capabilityPath === undefined ? {} : { capabilityPath: capabilityPath.trim() }),
    });
    if (reply === null) return;
    await this.refresh();
    await this.openFile((reply as { path: string }).path, null);
  }

  async newChange(): Promise<void> {
    if (!this.#requireReady()) return;
    const name = await vscode.window.showInputBox({
      title: 'Новый change',
      prompt: 'Имя в kebab-case, например add-data-export',
      validateInput: (value) =>
        /^[a-z0-9][a-z0-9-]*$/.test(value.trim()) ? null : 'Только строчные латинские буквы, цифры и дефисы',
    });
    if (name === undefined) return;

    const schemas = (await this.#request('GET', '/api/schemas')) as {
      schemas: { name: string; source: string }[];
      default: string | null;
    } | null;
    if (schemas === null) return;

    const items = [...schemas.schemas]
      .sort((a, b) => Number(b.name === schemas.default) - Number(a.name === schemas.default))
      .map((schema) => ({
        label: schema.name,
        description: [schema.source, schema.name === schemas.default ? 'по умолчанию' : null]
          .filter((part): part is string => part !== null)
          .join(' · '),
      }));
    const picked = await vscode.window.showQuickPick(items, { title: `Схема процесса для «${name.trim()}»` });
    if (picked === undefined) return;

    const created = await this.#request('POST', '/api/change', { name: name.trim(), schema: picked.label });
    if (created === null) return;
    void vscode.window.showInformationMessage(`Change «${name.trim()}» создан по схеме «${picked.label}».`);
    await this.refresh();

    // Замысел — по нему агент сразу напишет первый артефакт схемы, чтобы
    // change не начинался с пустого файла.
    const change = this.#workspace?.state === 'ready'
      ? this.#workspace.tree.changes.find((item) => item.name === name.trim())
      : undefined;
    const first = change?.artifacts[0]?.id;
    if (first === undefined || !(await this.#generable(name.trim())).has(first)) return;
    const brief = await vscode.window.showInputBox({
      title: `Замысел для «${name.trim()}»`,
      prompt: `Что и зачем меняем — агент напишет по этому «${first}». Пусто или Esc — пропустить.`,
      placeHolder: 'Например: выгрузка данных пользователя в CSV с ограничением объёма',
    });
    if (brief === undefined || brief.trim() === '') return;
    await this.#panel.show('agent', { kind: 'change', id: name.trim() }, { artifact: first, brief: brief.trim() });
  }

  /** Открывает раздел «Агент» с запуском по артефакту, спросив замысел. */
  async #generate(change: string, artifact: string): Promise<void> {
    const brief = await vscode.window.showInputBox({
      title: `Замысел для «${artifact}» change «${change}»`,
      prompt: 'Что должно получиться (необязательно). Промпт и режим вы увидите перед запуском.',
    });
    if (brief === undefined) return;
    await this.#panel.show(
      'agent',
      { kind: 'change', id: change },
      { artifact, brief: brief.trim() === '' ? null : brief.trim() },
    );
  }

  /** Артефакты change, у которых в схеме есть инструкция для агента. */
  async #generable(change: string): Promise<ReadonlySet<string>> {
    const targets = (await this.#request('GET', `/api/agent/targets?change=${encodeURIComponent(change)}`, undefined, {
      quiet: true,
    })) as { artifacts?: { id: string; available: boolean }[] } | null;
    return new Set((targets?.artifacts ?? []).filter((item) => item.available).map((item) => item.id));
  }

  async validateCommand(node?: TreeNode): Promise<void> {
    const change = node?.change ?? (await this.#pickChange('Проверить change'));
    if (change === undefined) return;
    const run = await this.validate(change);
    if (run === null || run.superseded) return;
    const errors = run.entries.filter((entry) => entry.level === 'ERROR').length;
    const warnings = run.entries.filter((entry) => entry.level === 'WARNING').length;
    if (run.error !== null) {
      void vscode.window.showErrorMessage(`Проверка «${change}» не выполнилась: ${run.error}`);
    } else if (errors === 0 && warnings === 0) {
      void vscode.window.showInformationMessage(`Change «${change}» проходит openspec validate --strict.`);
    } else {
      void vscode.window.showWarningMessage(
        `Change «${change}»: ошибок ${errors}, предупреждений ${warnings}. Подробности — в панели «Проблемы».`,
      );
    }
  }

  /** Проверяет change и раскладывает замечания в панель «Проблемы». */
  async validate(change: string): Promise<ValidationRun | null> {
    const run = (await this.#request('GET', `/api/validate?change=${encodeURIComponent(change)}`, undefined, {
      quiet: true,
    })) as ValidationRun | null;
    if (run === null || run.superseded || run.error !== null) return run;

    const root = this.root;
    if (root === null) return run;
    for (const uri of this.#diagnosed.get(change) ?? []) this.#diagnostics.delete(uri);

    const byFile = diagnosticsByFile(change, run.entries, (path) => existsSync(join(root, path)));
    const uris: vscode.Uri[] = [];
    for (const [path, list] of byFile) {
      const uri = vscode.Uri.file(join(root, path));
      uris.push(uri);
      this.#diagnostics.set(
        uri,
        list.map((item) => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(item.line, 0, item.line, Number.MAX_SAFE_INTEGER),
            item.message,
            item.level === 'error'
              ? vscode.DiagnosticSeverity.Error
              : item.level === 'warning'
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information,
          );
          diagnostic.source = 'openspec';
          return diagnostic;
        }),
      );
    }
    this.#diagnosed.set(change, uris);
    return run;
  }

  async archiveChange(node?: TreeNode): Promise<void> {
    const change = node?.change ?? (await this.#pickChange('Архивировать change'));
    if (change === undefined) return;

    // Сначала — что станет со спеками: архивацию, которую CLI отклонит, не
    // предлагаем вовсе, а согласие даётся уже на известный результат.
    const preview = await this.#fetchPreview(change);
    if (preview === null) return;
    const summary = archiveSummary(preview, this.#unfinished(change));
    const compare = 'Показать изменения спеков';

    if (!summary.archivable) {
      const answer = await vscode.window.showErrorMessage(
        summary.message,
        { modal: true, detail: summary.detail },
        ...(preview.specs.length > 0 ? [compare] : []),
      );
      if (answer === compare) await this.#openDiffs(preview, preview.specs);
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      summary.message,
      { modal: true, detail: summary.detail },
      'Архивировать',
      ...(preview.specs.length > 0 ? [compare] : []),
    );
    if (answer === compare) {
      await this.#openDiffs(preview, preview.specs);
      return;
    }
    if (answer !== 'Архивировать') return;
    const archived = await this.#request('POST', '/api/archive', { name: change });
    if (archived === null) return;
    this.#forgetDiagnostics(change);
    void vscode.window.showInformationMessage(`Change «${change}» архивирован.`);
    await this.refresh();
  }

  async previewArchiveCommand(node?: TreeNode): Promise<void> {
    const change = node?.change ?? (await this.#pickChange('Предпросмотр архивации'));
    if (change === undefined) return;
    await this.previewArchive(change, null);
  }

  /**
   * Открывает предпросмотр архивации в редакторе сравнения: слева текущий
   * спек, справа — спек после архивации. Без capability предлагает выбрать
   * одну или все.
   */
  async previewArchive(change: string, capability: string | null): Promise<void> {
    const preview = await this.#fetchPreview(change);
    if (preview === null) return;

    if (preview.outcome === 'refused') {
      const summary = archiveSummary(preview);
      void vscode.window.showErrorMessage(summary.message, { modal: true, detail: summary.detail });
      return;
    }
    if (preview.specs.length === 0) {
      void vscode.window.showInformationMessage(`Архивация «${change}» не изменит основные спеки.`);
      return;
    }
    if (preview.outcome === 'validation-failed') {
      void vscode.window.showWarningMessage(
        `Архивацию «${change}» сейчас остановит проверка. В сравнении — спеки после исправления ошибок.`,
      );
    }

    let specs: readonly SpecPreview[] = preview.specs;
    if (capability !== null) {
      specs = preview.specs.filter((spec) => spec.capability === capability);
    } else if (preview.specs.length > 1) {
      const all = 'Все capability';
      const picked = await vscode.window.showQuickPick(
        [
          { label: all, description: `${preview.specs.length} шт.` },
          ...preview.specs.map((spec) => ({ label: spec.capability, description: specLine(spec).split(' — ')[1] ?? '' })),
        ],
        { title: `Что изменит архивация «${change}»` },
      );
      if (picked === undefined) return;
      specs = picked.label === all ? preview.specs : preview.specs.filter((spec) => spec.capability === picked.label);
    }
    await this.#openDiffs(preview, specs);
  }

  async #openDiffs(preview: ArchivePreview, specs: readonly SpecPreview[]): Promise<void> {
    for (const spec of specs) {
      const right = this.#previews.put(preview.change, spec.capability, 'after', spec.after);
      const absolute = spec.before === null ? null : resolvePanelPath(this.root, spec.path);
      const left =
        absolute !== null && existsSync(absolute)
          ? vscode.Uri.file(absolute)
          : this.#previews.put(preview.change, spec.capability, 'before', '');
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${spec.capability}: сейчас ↔ после архивации «${preview.change}»`,
        { preview: specs.length === 1 },
      );
    }
  }

  async #fetchPreview(change: string): Promise<ArchivePreview | null> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Предпросмотр архивации «${change}»: openspec archive на временной копии…`,
      },
      async () =>
        (await this.#request('GET', `/api/archive/preview?change=${encodeURIComponent(change)}`)) as ArchivePreview | null,
    );
  }

  #unfinished(change: string): number {
    if (this.#workspace?.state !== 'ready') return 0;
    const progress = this.#workspace.tree.changes.find((item) => item.name === change)?.progress;
    return progress === null || progress === undefined ? 0 : progress.total - progress.complete;
  }

  #forgetDiagnostics(change: string): void {
    for (const uri of this.#diagnosed.get(change) ?? []) this.#diagnostics.delete(uri);
    this.#diagnosed.delete(change);
  }

  async openSection(section: PanelSection, node?: TreeNode): Promise<void> {
    let selection: PanelSelection | null = null;
    if (node?.change !== undefined) {
      selection = { kind: 'change', id: node.change };
    } else if (node?.capability !== undefined && node.contextValue === 'capability') {
      selection = { kind: 'capability', id: node.capability };
    } else if (node === undefined && CHANGE_SECTIONS.has(section)) {
      // Из палитры: предложить change, но и без выбора открыть раздел.
      const change = await this.#pickChange(`Раздел «${section === 'metrics' ? 'Метрики' : 'Агент'}» — какой change?`);
      if (change !== undefined) selection = { kind: 'change', id: change };
    }
    await this.#panel.show(section, selection);
  }

  async #restart(): Promise<void> {
    await this.#stopBackend();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const picked = pickWorkspaceRoot(folders);
    const root = picked.kind === 'found' ? picked.root : null;

    const backend = await createEmbeddedBackend({ root });
    this.#backend = backend;
    this.#unsubscribe = backend.subscribe((event) => {
      this.#panel.postEvent({ type: event.type, payload: event.payload ?? null });
      if (event.type === 'workspace-changed') {
        void this.refresh();
        const paths = (event.payload as { paths?: readonly string[] } | undefined)?.paths ?? [];
        for (const change of changesTouched(paths)) void this.validate(change);
      }
      if (event.type === 'agent-finished') void this.refresh();
    });

    await this.refresh();
    // Замечания всех активных changes видны сразу, а не после первой правки.
    if (this.#workspace?.state === 'ready') {
      for (const change of this.#workspace.tree.changes) void this.validate(change.name);
    }
  }

  async #stopBackend(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    const backend = this.#backend;
    this.#backend = null;
    await backend?.close();
  }

  async #readWorkspace(): Promise<void> {
    const reply = await this.#request('GET', '/api/workspace', undefined, { quiet: true });
    const workspace = (reply ?? { state: 'not-initialized' }) as WorkspaceState;
    this.#workspace = workspace;
    // Change, архивированный с доски или из терминала, уносит свои замечания.
    if (workspace.state === 'ready') {
      const active = new Set(workspace.tree.changes.map((change) => change.name));
      for (const change of [...this.#diagnosed.keys()]) {
        if (!active.has(change)) this.#forgetDiagnostics(change);
      }
    }
    await vscode.commands.executeCommand('setContext', 'openspec.state', workspace.state);
    this.#tree.set(buildTreeNodes(workspace));
    const status = statusText(workspace);
    this.#status.text = status.text;
    this.#status.tooltip = status.tooltip;
  }

  #requireReady(): boolean {
    if (this.#workspace?.state === 'ready') return true;
    void vscode.window.showWarningMessage(
      this.#workspace?.state === 'cli-missing'
        ? 'Не найден CLI OpenSpec. Установите его: npm install -D @fission-ai/openspec'
        : 'Проект OpenSpec не инициализирован. Выполните в терминале: openspec init',
    );
    return false;
  }

  async #pickChange(title: string): Promise<string | undefined> {
    if (!this.#requireReady() || this.#workspace?.state !== 'ready') return undefined;
    const changes = this.#workspace.tree.changes;
    if (changes.length === 0) {
      void vscode.window.showInformationMessage('Активных changes нет.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      changes.map(
        (change): vscode.QuickPickItem => ({
          label: change.name,
          description: change.schema,
          ...(change.progress === null || change.progress.total === 0
            ? {}
            : { detail: `выполнено ${change.progress.complete} из ${change.progress.total}` }),
        }),
      ),
      { title },
    );
    return picked?.label;
  }

  /**
   * Запрос к бэкенду. Отказ показывается пользователю с пояснениями CLI и
   * превращается в `null`.
   */
  async #request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    options: { quiet?: boolean } = {},
  ): Promise<unknown> {
    const backend = this.#backend;
    if (backend === null) return null;
    const reply = await backend.request(method, path, body);
    if (reply.status >= 200 && reply.status < 300) return reply.body;

    const payload = (reply.body ?? {}) as { error?: string; details?: string[]; output?: string };
    if (!options.quiet) {
      const details = [...(payload.details ?? []), payload.output ?? ''].filter((line) => line.trim() !== '');
      const message = payload.error ?? `Запрос ${path} завершился с кодом ${reply.status}`;
      void (details.length === 0
        ? vscode.window.showErrorMessage(message)
        : vscode.window.showErrorMessage(message, { modal: true, detail: details.join('\n') }));
    }
    return null;
  }
}

let controller: OpenspecController | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new OpenspecController(context);
  await controller.start();
}

export async function deactivate(): Promise<void> {
  await controller?.dispose();
  controller = null;
}
