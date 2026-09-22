import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from './fs/workspace.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_HEADER } from './http/session.js';
import { type RunningServer, startServer } from './server.js';

let root: string;
let server: RunningServer | null = null;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-server-')));
  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
  mkdirSync(join(root, 'openspec', 'specs'), { recursive: true });
  writeFileSync(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
});

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(root, { recursive: true, force: true });
});

async function start(options: { watch?: boolean; debounceMs?: number } = {}) {
  server = await startServer({ root, port: null, dev: false, ...options });
  return server;
}

function authorized(running: RunningServer): RequestInit {
  return { headers: { [SESSION_HEADER]: running.token } };
}

describe('сервер: доступ', () => {
  it('слушает только петлевой интерфейс', async () => {
    const running = await start({ watch: false });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('без токена отвечает 401', async () => {
    const running = await start({ watch: false });
    const response = await fetch(`${running.url}/api/workspace`);
    expect(response.status).toBe(401);
  });

  it('с токеном отдаёт состояние рабочего пространства', async () => {
    const running = await start({ watch: false });
    const response = await fetch(`${running.url}/api/workspace`, authorized(running));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { state: string; root?: string };
    expect(body.state).toBe('ready');
    expect(body.root).toBe(root);
  });

  it('с чужим токеном отвечает 401', async () => {
    const running = await start({ watch: false });
    const response = await fetch(`${running.url}/api/workspace`, {
      headers: { [SESSION_HEADER]: 'wrong-token-value' },
    });
    expect(response.status).toBe(401);
  });
});

describe('сервер: конфигурация', () => {
  it('отдаёт значения по умолчанию и сохраняет правку', async () => {
    const running = await start({ watch: false });

    const initial = await fetch(`${running.url}/api/config`, authorized(running));
    const loaded = (await initial.json()) as { config: { agent: { model: string | null } } };
    expect(loaded.config.agent.model).toBeNull();

    const saved = await fetch(`${running.url}/api/config`, {
      method: 'PUT',
      headers: { [SESSION_HEADER]: running.token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { model: 'GigaChat-2-Max' } }),
    });
    expect(saved.status).toBe(200);
  });

  it('отклоняет запись значения секретного поля с кодом 400', async () => {
    const running = await start({ watch: false });

    const response = await fetch(`${running.url}/api/config`, {
      method: 'PUT',
      headers: { [SESSION_HEADER]: running.token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { apiKey: 'секрет' } }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; field: string };
    expect(body.field).toBe('agent.apiKey');
    expect(body.error).toContain('переменной окружения');
  });
});

describe('сервер: поток событий', () => {
  it('доставляет изменение файла подписчику потока', async () => {
    const running = await start({ debounceMs: 50 });

    const response = await fetch(
      `${running.url}/api/events?token=${encodeURIComponent(running.token)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;
    const decoder = new TextDecoder();

    // Первое сообщение — подтверждение соединения.
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('event: connected');

    writeFileSync(join(root, 'openspec', 'changes', 'new-one.md'), '# новый\n');

    let received = '';
    while (!received.includes('workspace-changed')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }

    expect(received).toContain('event: workspace-changed');
    expect(received).toContain('new-one.md');

    await reader.cancel();
  });

  it('поток без токена отвергается', async () => {
    const running = await start({ watch: false });
    const response = await fetch(`${running.url}/api/events`);
    expect(response.status).toBe(401);
  });

  it('новое соединение после разрыва получает подтверждение заново', async () => {
    const running = await start({ watch: false });
    const url = `${running.url}/api/events?token=${encodeURIComponent(running.token)}`;

    const first = await fetch(url);
    await first.body?.cancel();

    const second = await fetch(url);
    const reader = second.body?.getReader();
    const text = new TextDecoder().decode((await reader?.read())?.value);
    expect(text).toContain('event: connected');
    await reader?.cancel();
  });
});
