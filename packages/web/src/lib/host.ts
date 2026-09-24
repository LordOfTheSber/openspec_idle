import {
  type AgentIntent,
  type HostMessage,
  type PanelSection,
  type PanelSelection,
  type ViewMessage,
  parseHostMessage,
} from '@openspec-ide/core';
import type { StreamTransport } from './connection.js';
import { MessageTransport, setApiTransport } from './transport.js';

/** То, что webview VS Code даёт странице. */
interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

/** Источник сообщений — окно страницы; в тестах подменяется. */
export interface MessageSource {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * Канал сообщений между панелью и расширением.
 *
 * Входящее сообщение, не прошедшее разбор, отбрасывается: в webview сообщение
 * может прийти не только от расширения.
 */
export class HostChannel {
  readonly #post: (message: ViewMessage) => void;
  readonly #handlers = new Set<(message: HostMessage) => void>();
  readonly transport: MessageTransport;

  constructor(post: (message: ViewMessage) => void, source: MessageSource) {
    this.#post = post;
    this.transport = new MessageTransport(post);
    source.addEventListener('message', (event) => {
      const parsed = parseHostMessage(event.data);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (message.kind === 'response') {
        this.transport.resolve(message.id, message.status, message.body);
        return;
      }
      for (const handler of [...this.#handlers]) handler(message);
    });
  }

  post(message: ViewMessage): void {
    this.#post(message);
  }

  subscribe(handler: (message: HostMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }
}

/**
 * Поток событий из сообщений расширения.
 *
 * Канал webview не рвётся, пока панель жива, поэтому соединение объявляется
 * открытым сразу, а ошибок у него нет.
 */
export function messageStreamTransport(channel: HostChannel): StreamTransport {
  let unsubscribe: (() => void) | null = null;
  let eventHandler: ((event: { type: string; payload: unknown }) => void) | null = null;
  return {
    onOpen: (handler) => {
      queueMicrotask(handler);
    },
    onEvent: (handler) => {
      eventHandler = handler;
      unsubscribe = channel.subscribe((message) => {
        if (message.kind === 'event') eventHandler?.(message.event);
      });
    },
    onError: () => undefined,
    close: () => {
      unsubscribe?.();
      unsubscribe = null;
      eventHandler = null;
    },
  };
}

let channel: HostChannel | null | undefined;

/**
 * Канал к VS Code, если страница открыта в его панели; иначе `null`.
 *
 * При первом обращении в панели VS Code запросы API переключаются на
 * сообщения webview.
 */
export function vscodeHost(): HostChannel | null {
  if (channel !== undefined) return channel;
  if (typeof globalThis.acquireVsCodeApi !== 'function') {
    channel = null;
    return channel;
  }
  const api = globalThis.acquireVsCodeApi();
  channel = new HostChannel((message) => api.postMessage(message), window);
  setApiTransport(channel.transport);
  return channel;
}

/** Страница открыта в панели VS Code. */
export function inVsCode(): boolean {
  return vscodeHost() !== null;
}

/**
 * Просит VS Code открыть файл в редакторе.
 *
 * Путь — относительно корня рабочего пространства. Вне VS Code ничего не
 * делает и возвращает `false`: в браузере файл открывает встроенный редактор.
 */
export function openInEditor(path: string, line: number | null = null): boolean {
  const host = vscodeHost();
  if (host === null) return false;
  host.post({ kind: 'open-file', path, line });
  return true;
}

/**
 * Просит VS Code открыть предпросмотр архивации в редакторе сравнения.
 *
 * Передаются только имена: текст спека после архивации расширение получает
 * от бэкенда само. Вне VS Code возвращает `false`.
 */
export function previewArchiveInEditor(change: string, capability: string | null): boolean {
  const host = vscodeHost();
  if (host === null) return false;
  host.post({ kind: 'preview-archive', change, capability });
  return true;
}

/** Подписка на команды навигации от расширения. */
export function onNavigate(
  handler: (section: PanelSection, selection: PanelSelection | null, agent: AgentIntent | null) => void,
): () => void {
  const host = vscodeHost();
  if (host === null) return () => undefined;
  return host.subscribe((message) => {
    if (message.kind === 'navigate') handler(message.section, message.selection, message.agent ?? null);
  });
}
