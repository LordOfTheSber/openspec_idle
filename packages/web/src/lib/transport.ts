import type { ApiMethod, ViewMessage } from '@openspec-ide/core';

/** Ответ бэкенда независимо от транспорта. */
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Способ доставить запрос к API.
 *
 * В браузере это HTTP, в панели VS Code — сообщения webview. Разделы
 * интерфейса этой разницы не видят: коды и тела ответов одинаковы.
 */
export interface ApiTransport {
  request(method: ApiMethod, path: string, body?: unknown): Promise<ApiResponse>;
}

/** Транспорт поверх `fetch` к локальному серверу. */
export function fetchTransport(token: () => string): ApiTransport {
  return {
    async request(method, path, body) {
      const withBody = body !== undefined && method !== 'GET';
      const response = await fetch(path, {
        method,
        headers: {
          'x-openspec-ide-token': token(),
          ...(withBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(withBody ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
    },
  };
}

/**
 * Транспорт поверх сообщений webview.
 *
 * Запросы нумеруются, ответ сопоставляется запросу по номеру: сообщения
 * могут приходить в любом порядке, если бэкенд отвечает на медленный запрос
 * позже быстрого.
 */
export class MessageTransport implements ApiTransport {
  readonly #post: (message: ViewMessage) => void;
  readonly #pending = new Map<number, (response: ApiResponse) => void>();
  #nextId = 1;

  constructor(post: (message: ViewMessage) => void) {
    this.#post = post;
  }

  /** Число запросов, ожидающих ответа, — нужно тестам. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  request(method: ApiMethod, path: string, body?: unknown): Promise<ApiResponse> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<ApiResponse>((resolve) => {
      this.#pending.set(id, resolve);
      this.#post(body === undefined ? { kind: 'request', id, method, path } : { kind: 'request', id, method, path, body });
    });
  }

  /** Передаёт ответ ожидающему запросу; ответ на неизвестный номер отбрасывается. */
  resolve(id: number, status: number, body: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending({ status, body });
  }
}

let current: ApiTransport | null = null;

/** Устанавливает транспорт, которым пользуются все запросы интерфейса. */
export function setApiTransport(transport: ApiTransport): void {
  current = transport;
}

/** Текущий транспорт; по умолчанию — HTTP с токеном из страницы. */
export function apiTransport(): ApiTransport {
  if (current === null) current = fetchTransport(pageToken);
  return current;
}

const TOKEN_META = 'openspec-ide-token';

/** Токен сессии, встроенный сервером в отданную страницу. */
export function pageToken(): string {
  const meta = document.querySelector(`meta[name="${TOKEN_META}"]`);
  return meta?.getAttribute('content') ?? '';
}
