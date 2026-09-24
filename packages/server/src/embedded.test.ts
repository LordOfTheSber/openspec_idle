import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from '../../../tests/fixtures.js';
import { type EmbeddedBackend, createEmbeddedBackend } from './embedded.js';
import { canonicalize } from './fs/workspace.js';
import { isStaleBackend } from '@openspec-ide/core';

let root: string | null = null;
let backend: EmbeddedBackend | null = null;

function copyFixture(name: string): string {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-embedded-')));
  cpSync(join(FIXTURES_ROOT, name), root, { recursive: true });
  return root;
}

afterEach(async () => {
  await backend?.close();
  backend = null;
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('встроенный бэкенд', () => {
  it('отдаёт дерево рабочего пространства без сокета', async () => {
    backend = await createEmbeddedBackend({ root: copyFixture('full-change'), watch: false });

    const reply = await backend.request('GET', '/api/workspace');

    expect(reply.status).toBe(200);
    const body = reply.body as { state: string; tree: { changes: { name: string }[] } };
    expect(body.state).toBe('ready');
    expect(body.tree.changes.map((change) => change.name)).toEqual(['full-feature']);
  });

  it('при конфликте записи отвечает 409 с версией с диска, как HTTP-режим', async () => {
    const project = copyFixture('full-change');
    backend = await createEmbeddedBackend({ root: project, watch: false });
    const path = 'openspec/changes/full-feature/proposal.md';

    const read = await backend.request('GET', `/api/file?path=${encodeURIComponent(path)}`);
    expect(read.status).toBe(200);
    const { version } = read.body as { version: string };

    writeFileSync(join(project, path), '# правка в обход редактора\n');

    const saved = await backend.request('PUT', '/api/file', {
      path,
      content: '# моя правка\n',
      baseVersion: version,
    });

    expect(saved.status).toBe(409);
    const body = saved.body as { path: string; disk: { content: string } };
    expect(body.path).toBe(path);
    expect(body.disk.content).toBe('# правка в обход редактора\n');
    expect(readFileSync(join(project, path), 'utf8')).toBe('# правка в обход редактора\n');
  });

  it('отказывает в путях вне /api/ и в потоке событий, не вызывая маршруты', async () => {
    backend = await createEmbeddedBackend({ root: copyFixture('empty'), watch: false });

    expect((await backend.request('GET', '/')).status).toBe(404);
    expect((await backend.request('GET', '/api/../etc/passwd')).status).toBe(404);
    expect((await backend.request('GET', '/api/events')).status).toBe(404);
  });

  it('POST без тела не ломается на разборе JSON', async () => {
    backend = await createEmbeddedBackend({ root: copyFixture('empty'), watch: false });

    const reply = await backend.request('POST', '/api/archive');

    expect(reply.status).toBe(400);
    expect((reply.body as { error: string }).error).toContain('Не указано имя изменения');
  });

  it('сообщает ревизию API, по которой панель узнаёт устаревший бэкенд', async () => {
    backend = await createEmbeddedBackend({ root: copyFixture('empty'), watch: false });

    const reply = await backend.request('GET', '/api/health');

    expect(isStaleBackend(reply.body)).toBe(false);
  });

  it('отдаёт предпросмотр архивации и 404 для неизвестного change', async () => {
    backend = await createEmbeddedBackend({ root: copyFixture('full-change'), watch: false });

    const reply = await backend.request('GET', '/api/archive/preview?change=full-feature');
    expect(reply.status).toBe(200);
    const body = reply.body as { outcome: string; specs: { capability: string; status: string }[] };
    expect(body.outcome).toBe('ready');
    expect(body.specs).toEqual([expect.objectContaining({ capability: 'data-export', status: 'created' })]);

    const missing = await backend.request('GET', '/api/archive/preview?change=no-such-change');
    expect(missing.status).toBe(404);
  });

  it('доставляет событие изменения файла подписчику', async () => {
    const project = copyFixture('empty');
    backend = await createEmbeddedBackend({ root: project, debounceMs: 50 });

    const received = new Promise<{ type: string; payload?: unknown }>((resolve) => {
      backend?.subscribe((event) => {
        if (event.type === 'workspace-changed') resolve(event);
      });
    });
    writeFileSync(join(project, 'openspec', 'changes', 'new-one.md'), '# новый\n');

    const event = await received;
    expect(JSON.stringify(event.payload)).toContain('new-one.md');
  });

  it('после закрытия не шлёт событий и не выполняет запросов', async () => {
    const project = copyFixture('empty');
    const instance = await createEmbeddedBackend({ root: project, debounceMs: 20 });
    const events: string[] = [];
    instance.subscribe((event) => events.push(event.type));

    await instance.close();
    writeFileSync(join(project, 'openspec', 'changes', 'late.md'), '# поздно\n');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(events).toEqual([]);
    expect((await instance.request('GET', '/api/workspace')).status).toBe(503);
  });

  it('без корня отдаёт состояние «не инициализирован»', async () => {
    backend = await createEmbeddedBackend({ root: null });

    const reply = await backend.request('GET', '/api/workspace');

    expect(reply.status).toBe(200);
    expect((reply.body as { state: string }).state).toBe('not-initialized');
  });
});
