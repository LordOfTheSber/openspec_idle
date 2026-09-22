import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { loadConfig, saveConfig, SecretInConfigError } from './config.js';
import { EventBus, encodeSse } from './events.js';
import { SESSION_HEADER, SESSION_QUERY, SessionToken } from './http/session.js';
import { OutsideWorkspaceError } from './http/paths.js';
import { OpenspecClient } from './openspec/client.js';
import { locateOpenspecCli, missingCliNotice } from './openspec/locate.js';
import { WorkspaceWatcher } from './watcher.js';

/** Адрес, на котором сервер принимает соединения. Только петлевой интерфейс. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Настройки запуска сервера. */
export interface ServerOptions {
  /** Корень рабочего пространства — каталог, содержащий `openspec/`. */
  readonly root: string | null;
  /** Запрошенный порт; `null` — взять свободный. */
  readonly port: number | null;
  /** Режим разработки: страницу отдаёт Vite, сервер отдаёт только API. */
  readonly dev: boolean;
  /** Не поднимать наблюдатель за файлами — нужно тестам. */
  readonly watch?: boolean;
  /** Окно объединения событий наблюдателя, мс. */
  readonly debounceMs?: number;
}

/** Запущенный сервер. */
export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly root: string | null;
  readonly token: string;
  readonly events: EventBus;
  close(): Promise<void>;
}

/** Порт занят другим процессом. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(
      `Порт ${port} уже занят другим процессом. ` +
        'Запустите без опции --port, чтобы взять свободный порт.',
    );
    this.name = 'PortInUseError';
  }
}

interface AppParts {
  readonly app: FastifyInstance;
  readonly token: SessionToken;
  readonly events: EventBus;
  readonly watcher: WorkspaceWatcher | null;
}

/** Собирает приложение, не открывая сокет. */
export function createApp(options: ServerOptions): AppParts {
  const app = Fastify({ logger: false });
  const token = SessionToken.create();
  const events = new EventBus();
  const { root } = options;

  const location = root === null ? null : locateOpenspecCli(root);
  const client =
    root !== null && location?.kind === 'found'
      ? new OpenspecClient({ root, bin: location.bin })
      : null;

  // Проверка токена на каждом обращении к API. Loopback сам по себе не
  // защищает: обратиться к localhost может любой процесс на машине, включая
  // код в открытой вкладке браузера.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.url.startsWith('/api/session')) return;

    const header = request.headers[SESSION_HEADER];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const fromQuery = (request.query as Record<string, string> | undefined)?.[SESSION_QUERY];

    if (!token.matches(fromHeader) && !token.matches(fromQuery)) {
      await reply.code(401).send({ error: 'Требуется токен сессии' });
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof OutsideWorkspaceError) {
      await reply.code(403).send({ error: error.message });
      return;
    }
    if (error instanceof SecretInConfigError) {
      await reply.code(400).send({ error: error.message, field: error.field });
      return;
    }
    await reply.code(500).send({
      error: error instanceof Error ? error.message : String(error),
    });
  });

  app.get('/api/health', async () => ({
    status: 'ok' as const,
    root,
    dev: options.dev,
  }));

  app.get('/api/workspace', async () => {
    if (root === null) {
      return { state: 'not-initialized' as const, hint: 'openspec init' };
    }
    if (location?.kind === 'not-found') {
      return { state: 'cli-missing' as const, notice: missingCliNotice(location) };
    }
    const [changes, specs, schemas] = await Promise.all([
      client!.listChanges(),
      client!.listSpecs(),
      client!.listSchemas(),
    ]);
    return { state: 'ready' as const, root, changes, specs, schemas };
  });

  app.get('/api/config', async () => {
    if (root === null) throw new Error('Рабочее пространство не определено');
    return loadConfig(root);
  });

  app.put('/api/config', async (request) => {
    if (root === null) throw new Error('Рабочее пространство не определено');
    return { config: await saveConfig(root, request.body) };
  });

  app.get('/api/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(encodeSse({ type: 'connected', payload: { root } }));

    let id = 0;
    const unsubscribe = events.subscribe((event) => {
      id += 1;
      reply.raw.write(encodeSse(event, id));
    });

    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  const watcher =
    root !== null && options.watch !== false
      ? new WorkspaceWatcher(
          options.debounceMs === undefined
            ? { root }
            : { root, debounceMs: options.debounceMs },
          (batch) => {
            client?.invalidate();
            events.emit({ type: 'workspace-changed', payload: batch });
          },
        )
      : null;

  return { app, token, events, watcher };
}

/** Поднимает сервер на петлевом интерфейсе. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { app, token, events, watcher } = createApp(options);

  try {
    await app.listen({ host: LOOPBACK_HOST, port: options.port ?? 0 });
  } catch (error) {
    await app.close().catch(() => undefined);
    if (isAddressInUse(error) && options.port !== null) {
      throw new PortInUseError(options.port);
    }
    throw error;
  }

  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('Не удалось определить порт, на котором запущен сервер');
  }

  await watcher?.start();

  return {
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    port: address.port,
    root: options.root,
    token: token.value,
    events,
    close: async () => {
      await watcher?.stop();
      await app.close();
    },
  };
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}
