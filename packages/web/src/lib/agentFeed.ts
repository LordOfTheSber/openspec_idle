import type { StreamEvent } from './connection.js';

type Listener = (event: StreamEvent) => void;

const listeners = new Set<Listener>();

/** Типы событий потока, относящиеся к запускам агента. */
export const AGENT_EVENT_TYPES = ['agent-started', 'agent-event', 'agent-finished'] as const;

/**
 * Раздаёт события запусков агента подписанным панелям.
 *
 * Поток событий у страницы один — его держит приложение; панель агента
 * подписывается сюда, а не открывает второе соединение.
 */
export function publishAgentEvent(event: StreamEvent): void {
  for (const listener of [...listeners]) listener(event);
}

export function subscribeAgentEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
