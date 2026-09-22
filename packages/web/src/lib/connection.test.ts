import { describe, expect, it, vi } from 'vitest';
import {
  type ConnectionState,
  type StreamEvent,
  type StreamTransport,
  WorkspaceConnection,
} from './connection.js';

/** Поток, которым управляет тест: открытие и разрыв вызываются вручную. */
class FakeTransport implements StreamTransport {
  #open: (() => void) | null = null;
  #event: ((event: StreamEvent) => void) | null = null;
  #error: (() => void) | null = null;
  closed = false;

  onOpen(handler: () => void): void {
    this.#open = handler;
  }
  onEvent(handler: (event: StreamEvent) => void): void {
    this.#event = handler;
  }
  onError(handler: () => void): void {
    this.#error = handler;
  }
  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.#open?.();
  }
  emitEvent(event: StreamEvent): void {
    this.#event?.(event);
  }
  emitError(): void {
    this.#error?.();
  }
}

/** Планировщик, который запускает отложенные вызовы по команде теста. */
class ManualScheduler {
  readonly delays: number[] = [];
  #queue: (() => void)[] = [];

  schedule = (callback: () => void, delayMs: number): number => {
    this.delays.push(delayMs);
    this.#queue.push(callback);
    return this.#queue.length - 1;
  };

  cancel = (): void => {
    this.#queue = [];
  };

  runNext(): void {
    const next = this.#queue.shift();
    next?.();
  }
}

function setup(options: { baseDelayMs?: number; maxDelayMs?: number } = {}) {
  const transports: FakeTransport[] = [];
  const states: ConnectionState[] = [];
  const events: StreamEvent[] = [];
  const scheduler = new ManualScheduler();
  const onResync = vi.fn();

  const connection = new WorkspaceConnection({
    connect: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    onState: (state) => states.push(state),
    onEvent: (event) => events.push(event),
    onResync,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    baseDelayMs: options.baseDelayMs ?? 100,
    maxDelayMs: options.maxDelayMs ?? 2000,
  });

  return { connection, transports, states, events, scheduler, onResync };
}

describe('соединение страницы с потоком событий', () => {
  it('после открытия переходит в состояние «подключено»', () => {
    const { connection, transports, states } = setup();
    connection.start();
    transports[0]?.emitOpen();

    expect(states).toEqual(['connecting', 'connected']);
    expect(connection.state).toBe('connected');
  });

  it('передаёт пришедшие события странице', () => {
    const { connection, transports, events } = setup();
    connection.start();
    transports[0]?.emitOpen();
    transports[0]?.emitEvent({ type: 'workspace-changed', payload: { count: 3 } });

    expect(events).toEqual([{ type: 'workspace-changed', payload: { count: 3 } }]);
  });

  it('при разрыве показывает признак отключения', () => {
    const { connection, transports, states } = setup();
    connection.start();
    transports[0]?.emitOpen();
    transports[0]?.emitError();

    expect(connection.state).toBe('disconnected');
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    expect(transports[0]?.closed).toBe(true);
  });

  it('пауза между попытками нарастает вдвое и упирается в предел', () => {
    const { connection, transports, scheduler } = setup({ baseDelayMs: 100, maxDelayMs: 400 });
    connection.start();
    transports[0]?.emitOpen();

    transports[0]?.emitError();
    scheduler.runNext();
    transports[1]?.emitError();
    scheduler.runNext();
    transports[2]?.emitError();
    scheduler.runNext();
    transports[3]?.emitError();

    expect(scheduler.delays).toEqual([100, 200, 400, 400]);
  });

  it('после восстановления перечитывает состояние целиком', () => {
    const { connection, transports, scheduler, onResync } = setup();
    connection.start();
    transports[0]?.emitOpen();
    expect(onResync).not.toHaveBeenCalled();

    transports[0]?.emitError();
    scheduler.runNext();
    transports[1]?.emitOpen();

    expect(onResync).toHaveBeenCalledOnce();
    expect(connection.state).toBe('connected');
  });

  it('успешное подключение сбрасывает нарастающую паузу', () => {
    const { connection, transports, scheduler } = setup({ baseDelayMs: 100 });
    connection.start();
    transports[0]?.emitOpen();

    transports[0]?.emitError();
    scheduler.runNext();
    transports[1]?.emitError();
    scheduler.runNext();
    transports[2]?.emitOpen();

    transports[2]?.emitError();

    expect(scheduler.delays).toEqual([100, 200, 100]);
  });

  it('остановка прекращает попытки переподключения', () => {
    const { connection, transports, scheduler } = setup();
    connection.start();
    transports[0]?.emitOpen();
    connection.stop();

    transports[0]?.emitError();

    expect(scheduler.delays).toHaveLength(0);
    expect(connection.state).toBe('disconnected');
  });
});
