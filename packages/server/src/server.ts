import Fastify, { type FastifyInstance } from 'fastify';

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
}

/** Запущенный сервер. */
export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly root: string | null;
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

/** Собирает приложение, не открывая сокет. */
export function createApp(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({
    status: 'ok' as const,
    root: options.root,
    dev: options.dev,
  }));

  return app;
}

/** Поднимает сервер на петлевом интерфейсе. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const app = createApp(options);

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

  return {
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    port: address.port,
    root: options.root,
    close: () => app.close(),
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
