import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@openspec-ide/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './run.js';

let dir: string;
const started: (() => Promise<void>)[] = [];

beforeEach(() => {
  dir = canonicalize(mkdtempSync(join(tmpdir(), 'osi-run-')));
});

afterEach(async () => {
  for (const close of started.splice(0)) await close();
  rmSync(dir, { recursive: true, force: true });
});

async function launch(argv: readonly string[]) {
  const outcome = await run(argv);
  if (outcome.close) started.push(outcome.close);
  return outcome;
}

/** Занимает свободный порт и возвращает его номер вместе со способом освободить. */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('нет порта');
  return {
    port: address.port,
    release: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('запуск openspec-ide', () => {
  it('в корне проекта с openspec/ поднимает сервер на петлевом интерфейсе', async () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });

    const outcome = await launch([dir, '--no-open']);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout.join('\n')).toContain(`Рабочее пространство: ${dir}`);
    expect(outcome.stdout.join('\n')).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
  });

  it('из вложенного каталога берёт корнем каталог с openspec/', async () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });
    const nested = join(dir, 'packages', 'web');
    mkdirSync(nested, { recursive: true });

    const outcome = await launch([nested, '--no-open']);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout.join('\n')).toContain(`Рабочее пространство: ${dir}`);
  });

  it('слушает явно заданный порт', async () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });
    const { port, release } = await occupyPort();
    await release();

    const outcome = await launch([dir, '--port', String(port), '--no-open']);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout.join('\n')).toContain(`http://127.0.0.1:${port}`);
  });

  it('на занятом порту завершается ненулевым кодом и называет порт', async () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });
    const { port, release } = await occupyPort();

    try {
      const outcome = await launch([dir, '--port', String(port), '--no-open']);

      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr.join('\n')).toContain(`Порт ${port} уже занят`);
      expect(outcome.stderr.join('\n')).toContain('--port');
    } finally {
      await release();
    }
  });

  it('в проекте без openspec/ запускается и объясняет состояние', async () => {
    const outcome = await launch([dir, '--no-open']);

    expect(outcome.code).toBe(0);
    const text = outcome.stdout.join('\n');
    expect(text).toContain('не найден каталог openspec/');
    expect(text).toContain('openspec init');
    expect(text).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
  });

  it('отвечает на проверку доступности при предъявлении токена сессии', async () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });
    const outcome = await launch([dir, '--no-open']);
    expect(outcome.url).toBeDefined();
    expect(outcome.token).toBeDefined();

    const response = await fetch(`${outcome.url}/api/health`, {
      headers: { 'x-openspec-ide-token': outcome.token ?? '' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', root: dir });
  });

  it('без токена сессии API отвечает 401 и не раскрывает корень', async () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });
    const outcome = await launch([dir, '--no-open']);

    const response = await fetch(`${outcome.url}/api/health`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(dir);
  });

  it('токен сессии различается между запусками', async () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });
    const first = await launch([dir, '--no-open']);
    const second = await launch([dir, '--no-open']);

    expect(first.token).toBeDefined();
    expect(second.token).toBeDefined();
    expect(first.token).not.toBe(second.token);
  });

  it('печатает справку и версию без запуска сервера', async () => {
    const help = await launch(['--help']);
    expect(help.code).toBe(0);
    expect(help.close).toBeUndefined();
    expect(help.stdout.join('\n')).toContain('openspec-ide');

    const version = await launch(['--version']);
    expect(version.stdout.join('\n')).toBe('0.1.0');
  });

  it('на неизвестной опции выходит с кодом 2 и не поднимает сервер', async () => {
    const outcome = await launch(['--nope']);
    expect(outcome.code).toBe(2);
    expect(outcome.close).toBeUndefined();
    expect(outcome.stderr.join('\n')).toContain('Неизвестная опция');
  });
});
