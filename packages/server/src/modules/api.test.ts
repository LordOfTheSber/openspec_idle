import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../openspec/exec.js';
import { SESSION_HEADER } from '../http/session.js';
import { type RunningServer, startServer } from '../server.js';
import { withModules } from './changeMeta.js';

const FIXTURE = fileURLToPath(new URL('../../../../tests/fixtures/monorepo', import.meta.url));
const CLI = fileURLToPath(new URL('../../../../node_modules/@fission-ai/openspec/bin/openspec.js', import.meta.url));

let root: string;
let server: RunningServer;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${server.url}${path}`, {
    ...init,
    headers: { [SESSION_HEADER]: server.token, 'content-type': 'application/json', ...init.headers },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error ?? ''}`);
  return body;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'osi-modules-api-'));
  cpSync(FIXTURE, root, { recursive: true });
  server = await startServer({ root, port: null, dev: false, watch: false, openspecFallback: CLI });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('API модулей на фикстуре монорепо', () => {
  it('дерево: модули changes по дельтам и явному списку, capability вне модулей', async () => {
    const workspace = await api<{
      tree: { changes: { name: string; deltaCapabilities: string[]; declaredModules: string[] }[] };
      modules: { map: { modules: unknown[]; problems: unknown[] }; overlay: { changes: Record<string, string[]>; capabilities: Record<string, string | null> } };
    }>('/api/workspace');
    expect(workspace.modules.map.modules).toHaveLength(10);
    expect(workspace.modules.map.problems).toEqual([]);
    expect(workspace.modules.overlay.changes).toEqual({
      'add-cache-ttl': ['km/core'],
      'add-invoice-export': ['billing', 'km/core'],
      'fix-auth-timeout': ['auth'],
    });
    expect(workspace.modules.overlay.capabilities).toEqual({
      auth: 'auth',
      billing: 'billing',
      'km/core': 'km/core',
      'ops/runbooks': null,
      'web-ui': 'web-ui',
    });
    const exportChange = workspace.tree.changes.find((change) => change.name === 'add-invoice-export');
    expect(exportChange?.deltaCapabilities).toEqual(['billing', 'km/core']);
  });

  it('доска и поиск несут модули', async () => {
    const board = await api<{ cards: { change: string; modules: string[] }[] }>('/api/board');
    expect(board.cards.find((card) => card.change === 'add-invoice-export')?.modules).toEqual(['billing', 'km/core']);
    const search = await api<{ hits: { owner: string; modules: string[] }[] }>(
      `/api/search?q=${encodeURIComponent('Кэш ответов')}`,
    );
    expect(search.hits.length).toBeGreaterThan(0);
    for (const hit of search.hits) expect(hit.modules).toContain('km/core');
  });

  it('детали change: затронутые потребители и дельты по модулям', async () => {
    const impact = await api<{ modules: string[]; consumers: { id: string; depth: number }[]; deltasByModule: Record<string, string[]> }>(
      '/api/modules/impact?change=add-cache-ttl',
    );
    expect(impact.modules).toEqual(['km/core']);
    expect(impact.consumers.map((consumer) => [consumer.id, consumer.depth])).toEqual([
      ['auth', 1],
      ['billing', 1],
      ['orders', 1],
      ['web-ui', 1],
      ['km/auth-client', 1],
      ['km/events', 1],
      ['notifications', 2],
      ['reports', 2],
    ]);
    const cross = await api<{ deltasByModule: Record<string, string[]> }>('/api/modules/impact?change=add-invoice-export');
    expect(cross.deltasByModule).toEqual({ billing: ['billing'], 'km/core': ['km/core'] });
  });

  it('сводка метрик по модулю считается по его changes', async () => {
    const summary = await api<{ changes: string[]; total: number; complete: number }>('/api/modules/metrics?ids=billing');
    expect(summary.changes).toEqual(['add-invoice-export']);
    expect([summary.total, summary.complete]).toEqual([2, 1]);
    const km = await api<{ changes: string[] }>('/api/modules/metrics?ids=km/core');
    expect(km.changes.sort()).toEqual(['add-cache-ttl', 'add-invoice-export']);
  });

  it('создание сквозного change пишет modules, остальное содержимое .openspec.yaml не меняется', async () => {
    await api('/api/change', { method: 'POST', body: JSON.stringify({ name: 'add-refund-events', modules: ['billing', 'km/events'] }) });
    const text = readFileSync(join(root, 'openspec/changes/add-refund-events/.openspec.yaml'), 'utf8');
    const lines = text.split('\n');
    expect(lines.at(-2)).toBe('modules: [billing, km/events]');
    expect(lines.slice(0, -2).join('\n')).toMatch(/^schema: spec-driven\ncreated: \d{4}-\d{2}-\d{2}$/);
    const validate = await runCli({ bin: CLI, cwd: root }, ['validate', 'add-refund-events', '--type', 'change', '--strict', '--json']);
    // Дельт ещё нет — CLI говорит только об этом, ключ modules ему не мешает.
    const report = JSON.parse(validate.stdout) as { items: { issues: { message: string }[] }[] };
    const messages = report.items.flatMap((item) => item.issues.map((issue) => issue.message));
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message).toMatch(/delta/i);
    const workspace = await api<{ modules: { overlay: { changes: Record<string, string[]> } } }>('/api/workspace');
    expect(workspace.modules.overlay.changes['add-refund-events']).toEqual(['billing', 'km/events']);
  });

  it('запись карты через API и отказ на неполном модуле', async () => {
    const view = await api<{ map: { modules: { id: string; path: string }[] } }>('/api/modules');
    const modules = view.map.modules.map((module) => ({ ...module }));
    modules.push({ id: 'payments', title: 'Платежи', kind: 'service', path: 'services/billing', specs: 'payments', group: 'Сервисы', dependsOn: ['billing'] } as never);
    const saved = await api<{ modules: { id: string }[] }>('/api/modules', { method: 'PUT', body: JSON.stringify({ modules }) });
    expect(saved.modules.map((module) => module.id)).toContain('payments');
    await expect(api('/api/modules', { method: 'PUT', body: JSON.stringify({ modules: [{ id: 'x' }] }) })).rejects.toThrow(/400/);
  });
});

describe('withModules', () => {
  it('добавляет ключ в конец и заменяет существующий, не трогая остальное', () => {
    expect(withModules('schema: spec-driven\ncreated: 2026-01-01\n', ['a', 'b'])).toBe(
      'schema: spec-driven\ncreated: 2026-01-01\nmodules: [a, b]\n',
    );
    expect(withModules('schema: x\nmodules:\n  - a\n  - b\ncreated: y', ['c'])).toBe('schema: x\nmodules: [c]\ncreated: y\n');
    expect(withModules('schema: x\nmodules: [a]\n', [])).toBe('schema: x\n');
  });
});
