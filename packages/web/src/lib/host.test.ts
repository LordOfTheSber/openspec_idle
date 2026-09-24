import type { ViewMessage } from '@openspec-ide/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, StaleWriteConflict, fetchFile, saveFile } from './api.js';
import { HostChannel, type MessageSource, messageStreamTransport } from './host.js';
import { setApiTransport } from './transport.js';

/** Окно страницы в миниатюре: хранит подписчиков и раздаёт им сообщения. */
class FakeWindow implements MessageSource {
  readonly listeners = new Set<(event: { data: unknown }) => void>();

  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  deliver(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

function setup() {
  const source = new FakeWindow();
  const sent: ViewMessage[] = [];
  const channel = new HostChannel((message) => sent.push(message), source);
  setApiTransport(channel.transport);
  return { source, sent, channel };
}

afterEach(() => {
  setApiTransport({
    request: () => Promise.reject(new Error('транспорт не задан')),
  });
});

describe('транспорт сообщений панели', () => {
  it('сопоставляет ответы запросам по номеру, даже если они пришли в обратном порядке', async () => {
    const { source, sent, channel } = setup();

    const first = channel.transport.request('GET', '/api/board');
    const second = channel.transport.request('GET', '/api/workspace');
    const [a, b] = sent as { id: number }[];

    source.deliver({ kind: 'response', id: b?.id, status: 200, body: { which: 'workspace' } });
    source.deliver({ kind: 'response', id: a?.id, status: 200, body: { which: 'board' } });

    expect(await first).toEqual({ status: 200, body: { which: 'board' } });
    expect(await second).toEqual({ status: 200, body: { which: 'workspace' } });
    expect(channel.transport.pendingCount).toBe(0);
  });

  it('409 с версией с диска превращается в конфликт записи, как в HTTP-режиме', async () => {
    const { source, sent } = setup();

    const saving = saveFile('openspec/a.md', 'моё', 'v1');
    const request = sent[0];
    expect(request).toMatchObject({
      kind: 'request',
      method: 'PUT',
      path: '/api/file',
      body: { path: 'openspec/a.md', content: 'моё', baseVersion: 'v1' },
    });
    source.deliver({
      kind: 'response',
      id: (request as { id: number }).id,
      status: 409,
      body: { error: 'изменился', path: 'openspec/a.md', disk: { path: 'openspec/a.md', content: 'чужое', version: 'v2' } },
    });

    const error = await saving.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaleWriteConflict);
    expect((error as StaleWriteConflict).disk.content).toBe('чужое');
  });

  it('прочие отказы становятся ApiError с пояснениями', async () => {
    const { source, sent } = setup();

    const reading = fetchFile('../etc/passwd');
    source.deliver({
      kind: 'response',
      id: (sent[0] as { id: number }).id,
      status: 403,
      body: { error: 'Путь вне рабочего пространства', details: ['a'] },
    });

    const error = await reading.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Путь вне рабочего пространства');
    expect((error as ApiError).details).toEqual(['a']);
  });

  it('неизвестный бэкенду маршрут объясняется, а не показывается как «Not Found»', async () => {
    const { source, sent } = setup();

    const reading = fetchFile('openspec/a.md');
    source.deliver({
      kind: 'response',
      id: (sent[0] as { id: number }).id,
      status: 404,
      body: { message: 'Route GET:/api/file?path=openspec%2Fa.md not found', error: 'Not Found', statusCode: 404 },
    });

    const error = await reading.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('Бэкенд не знает маршрута /api/file');
    expect((error as ApiError).message).toContain('Developer: Reload Window');
  });

  it('отбрасывает сообщения, не прошедшие разбор, и ответы на неизвестный номер', async () => {
    const { source, channel } = setup();
    const pending = channel.transport.request('GET', '/api/board');

    source.deliver('мусор');
    source.deliver({ kind: 'response', id: 999, status: 200, body: null });
    source.deliver({ kind: 'navigate', section: 'explorer', selection: null });

    expect(channel.transport.pendingCount).toBe(1);
    source.deliver({ kind: 'response', id: 1, status: 200, body: 'ok' });
    expect(await pending).toEqual({ status: 200, body: 'ok' });
  });
});

describe('поток событий из сообщений', () => {
  it('открывается сразу и передаёт события бэкенда', async () => {
    const { source, channel } = setup();
    const stream = messageStreamTransport(channel);
    const events: string[] = [];
    let opened = false;

    stream.onOpen(() => {
      opened = true;
    });
    stream.onEvent((event) => events.push(event.type));
    await Promise.resolve();

    source.deliver({ kind: 'event', event: { type: 'workspace-changed', payload: { paths: [] } } });
    source.deliver({ kind: 'event', event: { type: 'agent-event', payload: {} } });

    expect(opened).toBe(true);
    expect(events).toEqual(['workspace-changed', 'agent-event']);

    stream.close();
    source.deliver({ kind: 'event', event: { type: 'workspace-changed', payload: null } });
    expect(events).toHaveLength(2);
  });

  it('передаёт навигацию подписчикам канала', () => {
    const { source, channel } = setup();
    const seen: string[] = [];
    channel.subscribe((message) => {
      if (message.kind === 'navigate') seen.push(`${message.section}:${message.selection?.id ?? '—'}`);
    });

    source.deliver({ kind: 'navigate', section: 'metrics', selection: { kind: 'change', id: 'add-x' } });

    expect(seen).toEqual(['metrics:add-x']);
  });
});
