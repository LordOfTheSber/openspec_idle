/** Состояние соединения страницы с сервером. */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** Событие, пришедшее по потоку. */
export interface StreamEvent {
  readonly type: string;
  readonly payload: unknown;
}

/** Абстракция потока: позволяет проверять логику без браузера. */
export interface StreamTransport {
  onOpen(handler: () => void): void;
  onEvent(handler: (event: StreamEvent) => void): void;
  onError(handler: () => void): void;
  close(): void;
}

/** Настройки соединения. */
export interface ConnectionOptions {
  /** Открывает новый поток. Вызывается при каждой попытке подключения. */
  readonly connect: () => StreamTransport;
  /** Сообщает странице смену состояния. */
  readonly onState: (state: ConnectionState) => void;
  /** Передаёт пришедшее событие. */
  readonly onEvent: (event: StreamEvent) => void;
  /**
   * Вызывается после восстановления соединения: состояние рабочего
   * пространства перечитывается целиком, потому что события, пропущенные за
   * время разрыва, восстановить неоткуда.
   */
  readonly onResync: () => void;
  /** Первая пауза перед повтором, мс. */
  readonly baseDelayMs?: number;
  /** Верхний предел паузы, мс. */
  readonly maxDelayMs?: number;
  /** Планировщик — подменяется в тестах. */
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  /** Отмена запланированного повтора. */
  readonly cancel?: (handle: unknown) => void;
}

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Держит поток событий открытым, переподключаясь с нарастающей паузой.
 *
 * Пауза растёт вдвое на каждой неудаче и сбрасывается при успешном
 * подключении: частые повторы при коротком сбое, редкие — при долгом.
 */
export class WorkspaceConnection {
  readonly #options: ConnectionOptions;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancel: (handle: unknown) => void;

  #transport: StreamTransport | null = null;
  #retryHandle: unknown = null;
  #attempt = 0;
  #state: ConnectionState = 'disconnected';
  #everConnected = false;
  #stopped = false;

  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#schedule =
      options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle as never));
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Пауза, которая будет выдержана перед следующей попыткой. */
  get nextDelayMs(): number {
    const base = this.#options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const max = this.#options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    return Math.min(base * 2 ** Math.max(0, this.#attempt - 1), max);
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryHandle !== null) {
      this.#cancel(this.#retryHandle);
      this.#retryHandle = null;
    }
    this.#transport?.close();
    this.#transport = null;
    this.#setState('disconnected');
  }

  #open(): void {
    if (this.#stopped) return;
    this.#setState('connecting');

    const transport = this.#options.connect();
    this.#transport = transport;

    transport.onOpen(() => {
      const reconnected = this.#everConnected;
      this.#everConnected = true;
      this.#attempt = 0;
      this.#setState('connected');
      // После разрыва часть событий потеряна безвозвратно, поэтому состояние
      // перечитывается целиком, а не догоняется по одному событию.
      if (reconnected) this.#options.onResync();
    });

    transport.onEvent((event) => this.#options.onEvent(event));

    transport.onError(() => {
      this.#transport?.close();
      this.#transport = null;
      this.#setState('disconnected');
      this.#scheduleRetry();
    });
  }

  #scheduleRetry(): void {
    if (this.#stopped) return;
    this.#attempt += 1;
    const delay = this.nextDelayMs;
    this.#retryHandle = this.#schedule(() => {
      this.#retryHandle = null;
      this.#open();
    }, delay);
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onState(state);
  }
}

/** Создаёт транспорт поверх EventSource браузера. */
export function eventSourceTransport(url: string, types: readonly string[]): StreamTransport {
  const source = new EventSource(url);
  return {
    onOpen: (handler) => source.addEventListener('open', () => handler()),
    onEvent: (handler) => {
      for (const type of types) {
        source.addEventListener(type, (event) => {
          const data = (event as MessageEvent<string>).data;
          handler({ type, payload: data === '' ? null : (JSON.parse(data) as unknown) });
        });
      }
    },
    onError: (handler) => source.addEventListener('error', () => handler()),
    close: () => source.close(),
  };
}
