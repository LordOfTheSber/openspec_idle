import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize } from './fs/workspace.js';
import { SESSION_HEADER } from './http/session.js';
import { type RunningServer, startServer } from './server.js';
import type { TraceView } from './trace.js';
import type { AuthoringSources } from '@openspec-ide/core';

let root: string;
let server: RunningServer | null = null;

const SPEC = `## ADDED Requirements

### Requirement: Путь к CLI OpenSpec в настройках

Расширение ДОЛЖНО (SHALL) брать путь к CLI из настройки.

#### Scenario: Путь исправлен в настройках

- **WHEN** пользователь указывает верный путь
- **THEN** бэкенд перезапускается

#### Scenario: Команда без CLI

- **WHEN** CLI не найден
- **THEN** показывается предупреждение
`;

const TASKS = `# Tasks

## 1. Настройка

- [x] 1.1 Настройка cliPath
  ↳ vscode-extension / Путь исправлен в настройках
`;

function write(path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-trace-')));
  write('openspec/config.yaml', 'schema: spec-driven\n');
  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true });
  mkdirSync(join(root, 'openspec', 'specs'), { recursive: true });
  write('openspec/changes/fix-cli/.openspec.yaml', 'schema: spec-driven\ncreated: 2026-09-29\n');
  write('openspec/changes/fix-cli/proposal.md', '# Change\n\n## Why\n\nНужно.\n\n## What Changes\n\n- Путь.\n');
  write('openspec/changes/fix-cli/specs/vscode-extension/spec.md', SPEC);
  write('openspec/changes/fix-cli/tasks.md', TASKS);
});

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(root, { recursive: true, force: true });
});

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  server ??= await startServer({ root, port: null, dev: false, watch: false });
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { [SESSION_HEADER]: server.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

describe('трассировка через API', () => {
  it('сценарии дельт, связь по ссылке и пробел', async () => {
    const { status, body } = await request<TraceView>('GET', '/api/trace?change=fix-cli');

    expect(status).toBe(200);
    expect(body.planPath).toBe('openspec/changes/fix-cli/tasks.md');
    expect(body.trace.scenarios.map((item) => item.name)).toEqual(['Путь исправлен в настройках', 'Команда без CLI']);
    expect(body.trace.covered).toEqual(['vscode-extension/Путь к CLI OpenSpec в настройках/Путь исправлен в настройках']);
    expect(body.trace.links[0]?.kind).toBe('explicit');
    expect(Object.keys(body.metrics)).toEqual(['1.1']);
  });

  it('добавление пункта дописывает план и закрывает пробел', async () => {
    const { status, body } = await request<TraceView>('POST', '/api/trace/item', {
      change: 'fix-cli',
      capability: 'vscode-extension',
      requirement: 'Путь к CLI OpenSpec в настройках',
      scenario: 'Команда без CLI',
    });

    expect(status).toBe(200);
    expect(body.trace.covered).toHaveLength(2);
    expect(readFileSync(join(root, 'openspec/changes/fix-cli/tasks.md'), 'utf8')).toBe(
      `${TASKS}- [ ] 1.2 Команда без CLI\n  ↳ vscode-extension / Команда без CLI\n`,
    );
  });

  it('без сценария пункт ссылается на требование целиком и покрывает все его сценарии', async () => {
    const { status, body } = await request<TraceView>('POST', '/api/trace/item', {
      change: 'fix-cli',
      capability: 'vscode-extension',
      requirement: 'Путь к CLI OpenSpec в настройках',
    });

    expect(status).toBe(200);
    expect(body.trace.covered).toHaveLength(2);
    expect(readFileSync(join(root, 'openspec/changes/fix-cli/tasks.md'), 'utf8')).toBe(
      `${TASKS}- [ ] 1.2 Путь к CLI OpenSpec в настройках\n  ↳ vscode-extension / Путь к CLI OpenSpec в настройках\n`,
    );
  });

  it('неизвестный сценарий не пишет в план', async () => {
    const { status } = await request('POST', '/api/trace/item', {
      change: 'fix-cli',
      capability: 'vscode-extension',
      requirement: 'Путь к CLI OpenSpec в настройках',
      scenario: 'Нет такого',
    });

    expect(status).toBe(400);
    expect(readFileSync(join(root, 'openspec/changes/fix-cli/tasks.md'), 'utf8')).toBe(TASKS);
  });
});

describe('источники для функций редактора', () => {
  it('отдаёт основные спеки, дельты и план активного change с путями от корня', async () => {
    write('openspec/specs/vscode-extension/spec.md', '# vscode-extension\n\n## Purpose\n\nРасширение.\n\n## Requirements\n');
    const { status, body } = await request<AuthoringSources>('GET', '/api/authoring');

    expect(status).toBe(200);
    expect(body.mainSpecs.map((spec) => spec.path)).toEqual(['openspec/specs/vscode-extension/spec.md']);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]?.name).toBe('fix-cli');
    expect(body.changes[0]?.deltas).toEqual([
      { capability: 'vscode-extension', path: 'openspec/changes/fix-cli/specs/vscode-extension/spec.md', text: SPEC },
    ]);
    expect(body.changes[0]?.plan).toEqual({ path: 'openspec/changes/fix-cli/tasks.md', text: TASKS });
  });
});

describe('создание модуля контекста', () => {
  it('заводит index.md и context.md, повтор отклоняется', async () => {
    const created = await request<{ index: string; context: string }>('POST', '/api/context/module', { id: 'web' });

    expect(created.status).toBe(200);
    expect(created.body.index).toBe('openspec/context/modules/web/index.md');
    expect(readFileSync(join(root, created.body.index), 'utf8')).toContain('module: web\n');
    expect(existsSync(join(root, 'openspec/context/modules/web/context.md'))).toBe(true);

    const again = await request<{ error: string }>('POST', '/api/context/module', { id: 'web' });
    expect(again.status).toBe(409);
  });

  it('имя не в kebab-case отклоняется', async () => {
    const { status } = await request('POST', '/api/context/module', { id: '../Web App' });

    expect(status).toBe(400);
    expect(existsSync(join(root, 'openspec/context'))).toBe(false);
  });
});
