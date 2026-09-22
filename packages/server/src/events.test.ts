import { describe, expect, it, vi } from 'vitest';
import { EventBus, encodeSse } from './events.js';

describe('шина событий', () => {
  it('доставляет событие всем подписчикам', () => {
    const bus = new EventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.subscribe(first);
    bus.subscribe(second);

    bus.emit({ type: 'workspace-changed', payload: { count: 1 } });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('отписка прекращает доставку', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();

    bus.emit({ type: 'workspace-changed' });

    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount).toBe(0);
  });

  it('сбой одного подписчика не мешает остальным', () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('сломался');
    });
    bus.subscribe(good);

    expect(() => bus.emit({ type: 'x' })).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});

describe('кодирование SSE', () => {
  it('содержит тип события и данные', () => {
    const encoded = encodeSse({ type: 'workspace-changed', payload: { count: 3 } }, 7);
    expect(encoded).toContain('id: 7');
    expect(encoded).toContain('event: workspace-changed');
    expect(encoded).toContain('data: {"count":3}');
    expect(encoded.endsWith('\n\n')).toBe(true);
  });

  it('событие без данных кодируется как null', () => {
    expect(encodeSse({ type: 'connected' })).toContain('data: null');
  });
});
