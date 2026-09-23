import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('сервер: схемы', () => {
  it('отдаёт реестр и отклоняет занятое имя с кодом 400 и пояснением', async () => {
    const running = await start({ watch: false });
    const list = await fetch(`${running.url}/api/schemas`, authorized(running));
    const body = (await list.json()) as { schemas: { name: string }[]; default: string };
    expect(body.default).toBe('spec-driven');
    expect(body.schemas.some((entry) => entry.name === 'spec-driven')).toBe(true);

    const request = (name: string) =>
      fetch(`${running.url}/api/schema`, {
        method: 'POST',
        headers: { [SESSION_HEADER]: running.token, 'content-type': 'application/json' },
        body: JSON.stringify({ name, from: 'spec-driven' }),
      });
    expect((await request('flow')).status).toBe(200);
    const conflict = await request('flow');
    expect(conflict.status).toBe(400);
    expect(((await conflict.json()) as { error: string }).error).toMatch(/уже существует/);
  });

  it('change по схеме с нарушением SDD не создаётся', async () => {
    const running = await start({ watch: false });
    const dir = join(root, 'openspec', 'schemas', 'no-specs');
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'plan.md'), '# План\n');
    writeFileSync(
      join(dir, 'schema.yaml'),
      'name: no-specs\nversion: 1\ndescription: x\nartifacts:\n  - id: plan\n    generates: plan.md\n    description: План\n    template: plan.md\n    instruction: Пункты.\n    requires: []\napply:\n  requires: [plan]\n  tracks: plan.md\n',
    );
    const response = await fetch(`${running.url}/api/change`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: running.token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hotfix', schema: 'no-specs' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; output: string };
    expect(body.error).toMatch(/нельзя назначить/);
    expect(body.output).toMatch(/sdd\/behaviour-contract/);
    expect(existsSync(join(root, 'openspec', 'changes', 'hotfix'))).toBe(false);
  });

  it('некорректный YAML схемы не сохраняется: 400 с местом ошибки', async () => {
    const running = await start({ watch: false });
    await fetch(`${running.url}/api/schema`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: running.token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'flow', from: null }),
    });
    const response = await fetch(`${running.url}/api/schema`, {
      method: 'PUT',
      headers: { [SESSION_HEADER]: running.token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'flow', text: 'name: flow\n  broken: [' }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { details: string[] }).details[0]).toMatch(/строка/);
  });
});

describe('сервер: какой CLI OpenSpec используется', () => {
  const BUNDLED = fileURLToPath(new URL('../../../node_modules/@fission-ai/openspec/bin/openspec.js', import.meta.url));
  let savedPath: string | undefined;

  beforeEach(() => {
    // В PATH машины может стоять свой openspec — здесь его быть не должно.
    savedPath = process.env['PATH'];
    process.env['PATH'] = '';
  });

  afterEach(() => {
    process.env['PATH'] = savedPath;
  });

  async function health(running: RunningServer) {
    const response = await fetch(`${running.url}/api/health`, authorized(running));
    return (await response.json()) as { cli: { source: string; bin: string; version: string | null } | null };
  }

  it('без CLI в репозитории берёт встроенный и сообщает его версию', async () => {
    server = await startServer({ root, port: null, dev: false, watch: false, openspecFallback: BUNDLED });
    const { cli } = await health(server);
    expect(cli).toMatchObject({ source: 'bundled', bin: BUNDLED });
    expect(cli?.version).toMatch(/^\d+\.\d+\.\d+/);
    const workspace = await fetch(`${server.url}/api/workspace`, authorized(server));
    expect(((await workspace.json()) as { state: string }).state).toBe('ready');
  });

  it.skipIf(process.platform === 'win32')('версия из репозитория важнее встроенной', async () => {
    const bin = join(root, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'openspec'), '#!/bin/sh\necho 9.9.9-repo\n');
    chmodSync(join(bin, 'openspec'), 0o755);
    server = await startServer({ root, port: null, dev: false, watch: false, openspecFallback: BUNDLED });
    const { cli } = await health(server);
    expect(cli).toMatchObject({ source: 'project', bin: join(bin, 'openspec'), version: '9.9.9-repo' });
  });

  it('без CLI и без встроенного — CLI не указан', async () => {
    server = await startServer({ root, port: null, dev: false, watch: false });
    expect((await health(server)).cli).toBeNull();
  });
});
