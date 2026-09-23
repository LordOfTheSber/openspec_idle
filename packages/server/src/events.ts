/** Событие, отправляемое странице по потоку SSE. */
export interface IdeEvent {
  readonly type: string;
  readonly payload?: unknown;
}

/** Подписчик потока событий. */
export type EventListener = (event: IdeEvent) => void;

/**
 * Рассылка событий подписчикам.
 *
 * Поток односторонний — от сервера к странице, — поэтому здесь нет ничего,
 * кроме подписки и рассылки: действия страницы идут обычными запросами.
 */
export class EventBus {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: IdeEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Сбой одного подписчика не должен мешать остальным получить событие.
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

/** Кодирует событие в формат SSE. */
export function encodeSse(event: IdeEvent, id?: number): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event.payload ?? null)}`);
  return `${lines.join('\n')}\n\n`;
}
