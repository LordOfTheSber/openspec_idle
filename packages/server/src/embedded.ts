import { type ApiMethod, isPanelApiPath } from '@openspec-ide/core';
import type { EventListener } from './events.js';
import { SESSION_HEADER } from './http/session.js';
import { createApp } from './server.js';

/** Настройки бэкенда, встроенного в процесс расширения. */
export interface EmbeddedBackendOptions {
  /** Корень рабочего пространства — каталог, содержащий `openspec/`. */
  readonly root: string | null;
  /** Не поднимать наблюдатель за файлами — нужно тестам. */
  readonly watch?: boolean;
  /** Окно объединения событий наблюдателя, мс. */
  readonly debounceMs?: number;
  /** Путь к CLI OpenSpec из настроек расширения. */
  readonly cliPath?: string | null;
}

/** Ответ бэкенда — те же код и тело, что и в HTTP-режиме. */
export interface ApiReply {
  readonly status: number;
  readonly body: unknown;
}

/** Бэкенд IDE без сокета. */
export interface EmbeddedBackend {
  readonly root: string | null;
  /** Выполняет запрос к маршруту `/api/`. */
  request(method: ApiMethod, path: string, body?: unknown): Promise<ApiReply>;
  /** Подписка на события бэкенда: изменения файлов, ход запуска агента. */
  subscribe(listener: EventListener): () => void;
  close(): Promise<void>;
}

/**
 * Поднимает бэкенд IDE внутри текущего процесса, не открывая порт.
 *
 * Запросы проходят через `inject()` Fastify — те же маршруты, хуки и
 * обработчик ошибок, что и в HTTP-режиме, поэтому коды и тела ответов не
 * зависят от транспорта. Поток событий через `inject()` не идёт: подписчики
 * получают события напрямую из шины.
 */
export async function createEmbeddedBackend(options: EmbeddedBackendOptions): Promise<EmbeddedBackend> {
  const { app, token, events, watcher } = createApp({
    root: options.root,
    port: null,
    dev: false,
    serveUi: false,
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    cliPath: options.cliPath ?? null,
  });

  await app.ready();
  await watcher?.start();

  let closed = false;
  const listeners = new Set<() => void>();

  return {
    root: options.root,

    async request(method, path, body) {
      if (closed) return { status: 503, body: { error: 'Бэкенд IDE остановлен' } };
      if (!isPanelApiPath(path)) {
        return { status: 404, body: { error: `Путь «${path}» недоступен` } };
      }

      const withBody = body !== undefined && method !== 'GET';
      const response = await app.inject({
        method,
        url: path,
        headers: {
          [SESSION_HEADER]: token.value,
          ...(withBody ? { 'content-type': 'application/json' } : {}),
        },
        ...(withBody ? { payload: JSON.stringify(body) } : {}),
      });

      return { status: response.statusCode, body: parseBody(response.payload, response.headers['content-type']) };
    },

    subscribe(listener) {
      if (closed) return () => undefined;
      const unsubscribe = events.subscribe(listener);
      listeners.add(unsubscribe);
      return () => {
        listeners.delete(unsubscribe);
        unsubscribe();
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const unsubscribe of listeners) unsubscribe();
      listeners.clear();
      await watcher?.stop();
      await app.close();
    },
  };
}

function parseBody(payload: string, contentType: string | string[] | number | undefined): unknown {
  if (payload === '') return null;
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  if (typeof type === 'string' && type.includes('application/json')) {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }
  return payload;
}
