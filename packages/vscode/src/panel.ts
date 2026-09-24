import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AgentIntent, HostEvent, HostMessage, PanelSection, PanelSelection } from '@openspec-ide/core';
import type { EmbeddedBackend } from '@openspec-ide/server';
import * as vscode from 'vscode';
import { handleViewMessage } from './bridge.js';
import { createNonce, renderPanelHtml } from './panelHtml.js';

export const SECTION_TITLE: Record<PanelSection, string> = {
  board: 'Доска',
  deltas: 'Дельты',
  metrics: 'Метрики',
  agent: 'Агент',
  processes: 'Процессы',
  settings: 'Настройки агента',
  search: 'Поиск',
};

/** Что панели нужно от расширения. */
export interface SectionPanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly backend: () => EmbeddedBackend | null;
  readonly openFile: (path: string, line: number | null, fromPanel: boolean) => Promise<void>;
  readonly previewArchive: (change: string, capability: string | null) => Promise<void>;
}

/**
 * Одна на окно панель webview с разделами интерфейса.
 *
 * Повторный вызов не создаёт вторую панель, а переключает раздел и выбор в
 * существующей. Навигация, пришедшая до загрузки интерфейса, откладывается до
 * его сообщения `ready`.
 */
export class SectionPanel implements vscode.Disposable {
  readonly #deps: SectionPanelDeps;
  #panel: vscode.WebviewPanel | null = null;
  #ready = false;
  #last: HostMessage | null = null;

  constructor(deps: SectionPanelDeps) {
    this.#deps = deps;
  }

  get isOpen(): boolean {
    return this.#panel !== null;
  }

  async show(section: PanelSection, selection: PanelSelection | null, agent: AgentIntent | null = null): Promise<void> {
    const navigate: HostMessage =
      agent === null ? { kind: 'navigate', section, selection } : { kind: 'navigate', section, selection, agent };
    this.#last = navigate;

    if (this.#panel === null) {
      const webRoot = vscode.Uri.joinPath(this.#deps.extensionUri, 'media', 'web');
      const panel = vscode.window.createWebviewPanel(
        'openspec.sections',
        `OpenSpec: ${SECTION_TITLE[section]}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [webRoot] },
      );
      panel.iconPath = vscode.Uri.joinPath(this.#deps.extensionUri, 'media', 'openspec.svg');
      this.#panel = panel;
      this.#ready = false;

      panel.onDidDispose(() => {
        this.#panel = null;
        this.#ready = false;
      });
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.#receive(message);
      });
      panel.webview.html = await this.#html(panel.webview, webRoot);
    } else {
      this.#panel.title = `OpenSpec: ${SECTION_TITLE[section]}`;
      this.#panel.reveal();
      if (this.#ready) await this.#panel.webview.postMessage(navigate);
    }
  }

  /** Пересылает событие бэкенда в панель, если она загружена. */
  postEvent(event: HostEvent): void {
    if (this.#panel === null || !this.#ready) return;
    void this.#panel.webview.postMessage({ kind: 'event', event } satisfies HostMessage);
  }

  dispose(): void {
    this.#panel?.dispose();
    this.#panel = null;
  }

  async #receive(message: unknown): Promise<void> {
    const panel = this.#panel;
    if (panel === null) return;
    const backend = this.#deps.backend();
    await handleViewMessage(message, {
      backend: backend ?? {
        request: async () => ({ status: 503, body: { error: 'Бэкенд OpenSpec IDE не запущен' } }),
      },
      post: (reply) => panel.webview.postMessage(reply),
      openFile: (path, line) => this.#deps.openFile(path, line, true),
      previewArchive: (change, capability) => this.#deps.previewArchive(change, capability),
      onReady: () => {
        this.#ready = true;
        if (this.#last !== null) void panel.webview.postMessage(this.#last);
      },
      warn: (text) => console.error(`[openspec-ide] ${text}`),
    });
  }

  async #html(webview: vscode.Webview, webRoot: vscode.Uri): Promise<string> {
    let built: string;
    try {
      built = await readFile(vscode.Uri.joinPath(webRoot, 'index.html').fsPath, 'utf8');
    } catch {
      return notBuiltPage();
    }
    return renderPanelHtml(built, {
      assetUri: (relative) => webview.asWebviewUri(vscode.Uri.joinPath(webRoot, ...relative.split('/'))).toString(),
      cspSource: webview.cspSource,
      nonce: createNonce((size) => randomBytes(size)),
    });
  }
}

function notBuiltPage(): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px}</style>
</head><body>
<h2>Интерфейс OpenSpec IDE не собран</h2>
<p>В расширении нет каталога <code>media/web</code>. Соберите его в корне репозитория командой
<code>npm run build</code> и перезапустите окно VS Code.</p>
</body></html>`;
}
