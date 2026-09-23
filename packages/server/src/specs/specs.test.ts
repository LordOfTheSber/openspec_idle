import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseSpecMarkdown } from '@openspec-ide/core';
import { SESSION_HEADER } from '../http/session.js';
import { runCli } from '../openspec/exec.js';
import { type RunningServer, startServer } from '../server.js';
import { CodeIndex } from './codeIndex.js';
import { ModuleMapStore } from '../modules/mapStore.js';
import { EditorNotFoundError, openInEditor } from './editor.js';

const FIXTURE = fileURLToPath(new URL('../../../../tests/fixtures/monorepo', import.meta.url));
const CLI = fileURLToPath(new URL('../../../../node_modules/@fission-ai/openspec/bin/openspec.js', import.meta.url));
const FAKE_EDITOR = fileURLToPath(new URL('../../../../tests/editor/fake-editor.mjs', import.meta.url));

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'osi-specs-'));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

let root: string;
let server: RunningServer;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${server.url}${path}`, {
    ...init,
    headers: { [SESSION_HEADER]: server.token, 'content-type': 'application/json', ...init.headers },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(`${path}: ${response.status} ${body.error ?? ''}`), { body });
  return body;
}

beforeAll(async () => {
  root = copyFixture();
  server = await startServer({ root, port: null, dev: false, watch: false, openspecFallback: CLI });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('спека модуля', () => {
  it('разделы, обзор модуля, признаки активных changes', async () => {
    const view = await api<{
      module: { id: string; path: string; kind: string };
      purpose: string;
      counts: { sections: number; requirements: number; scenarios: number };
      sections: { title: string; requirements: { name: string; short: string; changes: unknown[]; proposedBy: string | null; incoming: number; outgoing: number }[]; children: { title: string; requirements: { short: string }[] }[] }[];
      activeChanges: string[];
      warnings: unknown[];
    }>('/api/module-spec?capability=billing');
    expect(view.module).toMatchObject({ id: 'billing', path: 'services/billing', kind: 'service' });
    expect(view.purpose).toContain('Биллинг платформы');
    expect(view.sections.map((section) => section.title)).toEqual(['Счета', 'Возвраты']);
    const bills = view.sections[0]!;
    // Предлагаемое требование активного change — в своём разделе.
    expect(bills.requirements.map((item) => [item.short, item.proposedBy])).toEqual([
      ['Нумерация счетов', null],
      ['Выгрузка счетов', 'add-invoice-export'],
    ]);
    expect(bills.children.map((child) => [child.title, child.requirements.map((item) => item.short)])).toEqual([['НДС', ['Округление']]]);
    expect(view.counts).toEqual({ sections: 3, requirements: 3, scenarios: 3 });
    expect(view.activeChanges).toEqual(['add-invoice-export']);
    expect(view.warnings).toEqual([]);
    // Ссылка из web-ui на прежнее имя битая — во входящие не попадает.
    expect(bills.requirements[0]!.incoming).toBe(0);
    expect(view.sections[1]!.requirements[0]!.outgoing).toBe(1); // на km/core
  });

  it('активный MODIFIED помечает требование библиотеки', async () => {
    const view = await api<{ sections: { requirements: { name: string; changes: { change: string; operation: string }[] }[] }[] }>(
      '/api/module-spec?capability=km/core',
    );
    expect(view.sections[0]!.requirements[0]!.changes).toEqual([{ change: 'add-invoice-export', operation: 'MODIFIED', renamedTo: null }]);
  });

  it('число требований совпадает с CLI; заголовок ## обрывает спеку и видно, сколько потеряно', async () => {
    const text = readFileSync(join(root, 'openspec/specs/billing/spec.md'), 'utf8');
    const shown = await runCli({ bin: CLI, cwd: root }, ['show', 'billing', '--type', 'spec', '--json']);
    const cliCount = (JSON.parse(shown.stdout) as { requirements: unknown[] }).requirements.length;
    expect(parseSpecMarkdown(text).requirements).toHaveLength(cliCount);

    const broken = text.replace('### Requirement: Возвраты / Полный возврат', '## Возвраты\n\n### Requirement: Полный возврат');
    writeFileSync(join(root, 'openspec/specs/ops/runbooks/spec.md'), broken.replace('# billing', '# ops/runbooks'));
    const cut = await runCli({ bin: CLI, cwd: root }, ['show', 'ops/runbooks', '--type', 'spec', '--json']);
    const view = await api<{ warnings: { kind: string; lostRequirements: number }[] }>('/api/module-spec?capability=ops/runbooks');
    expect(view.warnings).toEqual([expect.objectContaining({ kind: 'heading-in-requirements', lostRequirements: 1 })]);
    // CLI действительно видит на одно требование меньше.
    expect((JSON.parse(cut.stdout) as { requirements: unknown[] }).requirements).toHaveLength(cliCount - 1);
    cpSync(join(FIXTURE, 'openspec/specs/ops/runbooks/spec.md'), join(root, 'openspec/specs/ops/runbooks/spec.md'));
  });

  it('история требования по архиву через переименование', async () => {
    const { entries } = await api<{ entries: { change: string; date: string; operation: string; name: string; renamedFrom: string | null; before: string | null; after: string | null }[] }>(
      `/api/module-spec/history?capability=billing&name=${encodeURIComponent('Счета / Нумерация счетов')}`,
    );
    expect(entries.map((entry) => [entry.change, entry.date, entry.operation, entry.name])).toEqual([
      ['invoice-prefix', '2026-09-01', 'MODIFIED', 'Счета / Нумерация счетов'],
      ['billing-sections', '2026-08-20', 'RENAMED', 'Счета / Нумерация счетов'],
      ['add-billing', '2026-08-01', 'ADDED', 'Нумерация счетов'],
    ]);
    expect(entries[1]!.renamedFrom).toBe('Нумерация счетов');
    expect(entries[0]!.before).toContain('сквозные номера.');
    expect(entries[0]!.after).toContain('с префиксом организации');
  });
});

describe('ссылки между требованиями', () => {
  it('обратные ссылки, битая после переименования с заменой, связь без зависимости в карте', async () => {
    const graph = await api<{
      links: { fromCapability: string; toCapability: string; toRequirement: string | null; status: string; suggestion: string | null; line: number; file: string }[];
      edges: { from: string; to: string; count: number; mismatch: boolean }[];
      undocumented: { from: string; to: string }[];
    }>('/api/links');
    const toCache = graph.links.filter((link) => link.toCapability === 'km/core' && link.toRequirement === 'Кэш ответов');
    expect(toCache.map((link) => link.fromCapability).sort()).toEqual(['billing', 'web-ui']);
    const broken = graph.links.find((link) => link.fromCapability === 'web-ui' && link.toCapability === 'billing');
    expect(broken).toMatchObject({ status: 'missing-requirement', suggestion: 'Счета / Нумерация счетов', file: 'openspec/specs/web-ui/spec.md', line: 11 });
    expect(graph.edges).toContainEqual({ from: 'web-ui', to: 'billing', count: 1, mismatch: true });
    expect(graph.edges).toContainEqual({ from: 'billing', to: 'km/core', count: 1, mismatch: false });
    expect(graph.undocumented).toContainEqual({ from: 'billing', to: 'km/events' });
  });

  it('change, меняющий требование, видит ссылающиеся требования других модулей', async () => {
    const traces = await api<{ affectedLinks: { fromCapability: string }[]; brokenLinks: unknown[] }>('/api/code/change?change=add-invoice-export');
    expect(traces.affectedLinks.map((link) => link.fromCapability).sort()).toEqual(['billing', 'web-ui']);
    expect(traces.brokenLinks).toEqual([]);
  });

  it('индекс требований для вставки ссылки', async () => {
    const { requirements } = await api<{ requirements: { capability: string; name: string; anchor: string; module: string | null }[] }>('/api/requirements');
    expect(requirements).toContainEqual({ capability: 'km/core', module: 'km/core', name: 'Кэш ответов', anchor: 'requirement-кэш-ответов' });
  });
});

describe('связь с кодом', () => {
  it('покрытие: код и тесты, только код, вероятно по имени, нет покрытия', async () => {
    let coverage = await api<{ index: { state: string }; requirements: { requirement: string; state: string; code: { path: string }[]; tests: { path: string }[]; usages: unknown[]; probable: { path: string; scenario: string }[] }[]; summary: Record<string, number> }>(
      '/api/code/coverage?capability=billing',
    );
    for (let attempt = 0; coverage.index.state !== 'ready' && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      coverage = await api('/api/code/coverage?capability=billing');
    }
    const byName = Object.fromEntries(coverage.requirements.map((trace) => [trace.requirement, trace]));
    expect(byName['Счета / Нумерация счетов']).toMatchObject({ state: 'full' });
    expect(byName['Счета / Нумерация счетов']!.code.map((place) => place.path)).toEqual([
      'services/billing/src/main/kotlin/ru/platform/billing/InvoiceNumbers.kt',
    ]);
    expect(byName['Счета / Нумерация счетов']!.tests.map((place) => place.path)).toEqual([
      'services/billing/src/test/kotlin/ru/platform/billing/InvoiceNumbersTest.kt',
    ]);
    expect(byName['Возвраты / Полный возврат']).toMatchObject({ state: 'code' });
    expect(byName['Возвраты / Полный возврат']!.probable).toEqual([
      expect.objectContaining({ path: 'services/billing/src/test/kotlin/ru/platform/billing/RefundsTest.kt', scenario: 'Полный возврат' }),
    ]);
    expect(byName['Счета / НДС / Округление']).toMatchObject({ state: 'none' });
    expect(coverage.summary).toEqual({ full: 1, code: 1, tests: 0, probable: 0, none: 1 });

    // Метка на требование библиотеки в коде биллинга — использование, а не реализация.
    const core = await api<{ requirements: { requirement: string; code: { path: string }[]; usages: { path: string; module: string }[] }[] }>(
      '/api/code/coverage?capability=km/core',
    );
    expect(core.requirements[0]!.code.map((place) => place.path)).toEqual(['km/core/src/main/java/ru/platform/km/core/ResponseCache.java']);
    expect(core.requirements[0]!.usages).toEqual([
      expect.objectContaining({ path: 'services/billing/src/main/kotlin/ru/platform/billing/Refunds.kt', module: 'billing' }),
    ]);

    const ui = await api<{ requirements: { state: string; probable: { path: string }[] }[] }>('/api/code/coverage?capability=web-ui');
    expect(ui.requirements[0]!.state).toBe('code');
    expect(ui.requirements[0]!.probable.map((place) => place.path)).toEqual(['ui/src/InvoiceList.test.tsx']);
  });

  it('битая метка со старым именем получает новое имя', async () => {
    const { tags } = await api<{ tags: { path: string; requirement: string; reason: string; suggestion: string | null }[] }>('/api/code/broken');
    expect(tags).toEqual([
      {
        path: 'services/billing/src/main/kotlin/ru/platform/billing/LegacyNumbers.kt',
        line: 3,
        module: 'billing',
        requirement: 'Нумерация счетов',
        reason: 'unknown-requirement',
        suggestion: 'Счета / Нумерация счетов',
      },
    ]);
  });

  it('фрагмент вокруг строки и отказ за пределами репозитория', async () => {
    const snippet = await api<{ start: number; line: number; lines: string[] }>(
      '/api/code/snippet?path=services/billing/src/main/kotlin/ru/platform/billing/InvoiceNumbers.kt&line=3',
    );
    expect(snippet.start).toBe(1);
    expect(snippet.lines[2]).toContain('@spec billing');
    await expect(api('/api/code/snippet?path=../../etc/passwd&line=1')).rejects.toThrow(/403/);
  });
});

describe('индекс меток', () => {
  let other: string;
  let index: CodeIndex | null = null;

  afterEach(async () => {
    await index?.close();
    index = null;
    rmSync(other, { recursive: true, force: true });
  });

  it('повторное открытие перечитывает только изменённые, новая метка без полной переиндексации, node_modules и target не читаются', async () => {
    other = copyFixture();
    mkdirSync(join(other, 'services/billing/target/classes'), { recursive: true });
    writeFileSync(join(other, 'services/billing/target/classes/Copy.kt'), '// @spec billing: Счета / Нумерация счетов\n');
    mkdirSync(join(other, 'ui/node_modules/lib'), { recursive: true });
    writeFileSync(join(other, 'ui/node_modules/lib/index.js'), '// @spec web-ui: Список счетов\n');
    const map = await new ModuleMapStore(other).read();

    index = new CodeIndex({ root: other, watch: false });
    await index.configure(map.modules, null);
    const first = index.status.lastRun!;
    expect(first.reused).toBe(0);
    expect([...index.files.keys()].some((path) => path.includes('/target/') || path.includes('node_modules'))).toBe(false);
    expect(existsSync(join(other, '.openspec-ide/code-index.json'))).toBe(true);
    expect(readFileSync(join(other, '.openspec-ide/.gitignore'), 'utf8')).toBe('*\n');
    await index.close();

    appendFileSync(join(other, 'km/core/src/main/java/ru/platform/km/core/ResponseCache.java'), '// правка\n');
    index = new CodeIndex({ root: other, watch: false });
    await index.configure(map.modules, null);
    expect(index.status.lastRun).toEqual({ read: 1, reused: first.read - 1 });
    await index.close();

    // Наблюдатель: новая метка подхватывается по одному файлу.
    let changes = 0;
    index = new CodeIndex({ root: other, watch: true, onChange: () => (changes += 1) });
    await index.configure(map.modules, null);
    const before = changes;
    writeFileSync(join(other, 'services/billing/src/main/kotlin/ru/platform/billing/Vat.kt'), '// @spec billing: Счета / НДС / Округление\n');
    for (let attempt = 0; attempt < 50 && !index.files.has('services/billing/src/main/kotlin/ru/platform/billing/Vat.kt'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(index.files.get('services/billing/src/main/kotlin/ru/platform/billing/Vat.kt')?.tags).toEqual([
      { line: 1, module: 'billing', requirement: 'Счета / НДС / Округление' },
    ]);
    expect(changes).toBeGreaterThan(before);
    expect(index.status.lastRun?.reused).toBeGreaterThan(0);
  });
});

describe('внешний редактор', () => {
  it.skipIf(process.platform === 'win32')('IDEA и VS Code получают файл и строку', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osi-editor-'));
    const log = join(dir, 'log.jsonl');
    const env = { ...process.env, FAKE_EDITOR_LOG: log };
    const file = 'services/billing/src/main/kotlin/ru/platform/billing/InvoiceNumbers.kt';
    openInEditor({ kind: 'idea', command: FAKE_EDITOR, root, path: file, line: 3, env });
    openInEditor({ kind: 'vscode', command: FAKE_EDITOR, root, path: file, line: 7, env });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (existsSync(log) && readFileSync(log, 'utf8').trim().split('\n').length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]).sort((a) => (a[0] === '--line' ? -1 : 1));
    expect(calls).toEqual([
      ['--line', '3', join(root, file)],
      ['-g', `${join(root, file)}:7`],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('команда не найдена — перечень проверенных путей', () => {
    try {
      openInEditor({ kind: 'idea', command: null, root, path: 'README.md', line: 1, env: { PATH: '/nowhere' } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EditorNotFoundError);
      expect((error as EditorNotFoundError).searched).toEqual(['/nowhere/idea', '/nowhere/idea64']);
    }
  });
});
