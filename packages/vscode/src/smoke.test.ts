import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from '../../../tests/fixtures.js';
// @ts-expect-error — модуль сборки на JavaScript без объявлений типов.
import { bundleExtension } from '../bundle.mjs';
import { type FakeState, type FakeWebviewPanel, Uri, createFakeVscode } from './testing/fakeVscode.js';
import type { TreeNode } from './treeModel.js';

/**
 * Дымовой тест собранного бандла расширения.
 *
 * Бандл собирается тем же кодом, что уходит в .vsix, и загружается с
 * подменённым модулем `vscode`: так ловятся ошибки сборки (зависимости,
 * import.meta в CommonJS), активации и регистрации, которые модульные тесты
 * исходников не видят.
 */

const EXTENSION_DIR = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

interface LoadedExtension {
  activate(context: unknown): Promise<void>;
  deactivate(): Promise<void>;
}

let bundleDir: string;
let bundle: string;
let project: string | null = null;
let loaded: LoadedExtension | null = null;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'osi-vsix-'));
  bundle = join(bundleDir, 'extension.cjs');
  await bundleExtension(bundle);
}, 60_000);

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

afterEach(async () => {
  await loaded?.deactivate();
  loaded = null;
  if (project !== null) rmSync(project, { recursive: true, force: true });
  project = null;
});

function copyFixture(name: string): string {
  project = mkdtempSync(join(tmpdir(), 'osi-vscode-'));
  cpSync(join(FIXTURES_ROOT, name), project, { recursive: true });
  return project;
}

/** Загружает свежую копию бандла с подменой `vscode` и активирует её. */
async function activate(folders: readonly string[]): Promise<FakeState> {
  const fake = createFakeVscode(folders);
  const moduleApi = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const original = moduleApi._load;
  moduleApi._load = function load(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return fake.module;
    return original.call(this, request, ...rest);
  };
  try {
    delete require.cache[bundle];
    loaded = require(bundle) as LoadedExtension;
  } finally {
    moduleApi._load = original;
  }
  await loaded.activate({ subscriptions: [], extensionUri: Uri.file(EXTENSION_DIR) });
  return fake.state;
}

function topNodes(state: FakeState): readonly TreeNode[] {
  const view = state.treeViews.get('openspec.workspace');
  const provider = view?.treeDataProvider as { getChildren(node?: TreeNode): TreeNode[] };
  return provider.getChildren();
}

function findNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function command(state: FakeState, id: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.commands.get(id);
  if (handler === undefined) throw new Error(`Команда ${id} не зарегистрирована`);
  return handler(...args);
}

function lastPanel(state: FakeState): FakeWebviewPanel {
  const panel = state.panels.at(-1);
  if (panel === undefined) throw new Error('Панель не открыта');
  return panel;
}

describe('расширение VS Code: активация', () => {
  it('регистрирует дерево и все команды из манифеста, показывает changes', async () => {
    const state = await activate([copyFixture('full-change')]);

    const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string }[]; views: { openspec: { id: string }[] } };
    };
    for (const { command: id } of manifest.contributes.commands) {
      expect(state.commands.has(id), id).toBe(true);
    }
    for (const { id } of manifest.contributes.views.openspec) {
      expect(state.treeViews.has(id), id).toBe(true);
    }

    expect(state.context.get('openspec.state')).toBe('ready');
    const change = findNode(topNodes(state), 'change:full-feature');
    expect(change?.children.map((node) => node.label)).toEqual(['proposal', 'specs', 'design', 'tasks']);
    expect(state.statusBar.text).toContain('1');
    expect(state.statusBar.command).toBe('openspec.openBoard');
  });

  it('открытый подкаталог проекта даёт корнем каталог с openspec/', async () => {
    const root = copyFixture('full-change');
    const state = await activate([join(root, 'openspec', 'changes')]);

    expect(state.context.get('openspec.state')).toBe('ready');
    await command(state, 'openspec.openNode', findNode(topNodes(state), 'artifact:full-feature/proposal'));
    expect(state.shownDocuments.at(-1)?.path).toBe(join(root, 'openspec', 'changes', 'full-feature', 'proposal.md'));
  });

  it('без OpenSpec в рабочей области: состояние «не инициализирован», команды не падают', async () => {
    project = mkdtempSync(join(tmpdir(), 'osi-vscode-bare-'));
    const state = await activate([project]);

    expect(state.context.get('openspec.state')).toBe('not-initialized');
    expect(topNodes(state)).toEqual([]);
    await command(state, 'openspec.newChange');
    expect(state.messages.at(-1)?.text).toContain('openspec init');
  });
});

describe('расширение VS Code: дерево и редактор', () => {
  it('выбор артефакта открывает файл в редакторе', async () => {
    const root = copyFixture('full-change');
    const state = await activate([root]);

    await command(state, 'openspec.openNode', findNode(topNodes(state), 'artifact:full-feature/tasks'));

    expect(state.shownDocuments).toEqual([
      { path: join(root, 'openspec', 'changes', 'full-feature', 'tasks.md'), line: null },
    ]);
  });

  it('отсутствующий артефакт создаётся по шаблону после согласия', async () => {
    const root = copyFixture('bare-change');
    const state = await activate([root]);
    const node = findNode(topNodes(state), 'artifact:bare-feature/proposal');
    expect(node?.contextValue).toBe('artifact-missing');

    state.answers.push('Пустой по шаблону');
    await command(state, 'openspec.openNode', node);

    const created = join(root, 'openspec', 'changes', 'bare-feature', 'proposal.md');
    expect(existsSync(created)).toBe(true);
    expect(state.shownDocuments.at(-1)?.path).toBe(created);
    expect(state.messages.at(-1)?.buttons).toEqual(['Сгенерировать агентом', 'Пустой по шаблону']);
  });

  it('отсутствующий артефакт генерируется агентом: панель открывается на агенте с замыслом', async () => {
    const root = copyFixture('bare-change');
    const state = await activate([root]);

    state.answers.push('Сгенерировать агентом', 'Выгрузка данных в CSV');
    await command(state, 'openspec.openNode', findNode(topNodes(state), 'artifact:bare-feature/proposal'));

    const panel = lastPanel(state);
    panel.webview.receive({ kind: 'ready' });
    await until(() => panel.webview.posted.length > 0, 'навигация к агенту');
    expect(panel.webview.posted[0]).toEqual({
      kind: 'navigate',
      section: 'agent',
      selection: { kind: 'change', id: 'bare-feature' },
      agent: { artifact: 'proposal', brief: 'Выгрузка данных в CSV' },
    });
    // Файл пишет агент после подтверждения запуска, а не расширение.
    expect(existsSync(join(root, 'openspec', 'changes', 'bare-feature', 'proposal.md'))).toBe(false);
  });
});

describe('расширение VS Code: панель разделов', () => {
  it('открывается из контекстного меню change и получает раздел после загрузки', async () => {
    const state = await activate([copyFixture('full-change')]);
    const change = findNode(topNodes(state), 'change:full-feature');

    await command(state, 'openspec.openMetrics', change);
    const panel = lastPanel(state);
    expect(panel.title).toBe('OpenSpec: Метрики');

    panel.webview.receive({ kind: 'ready' });
    await until(() => panel.webview.posted.length > 0, 'навигация в панель');
    expect(panel.webview.posted[0]).toEqual({
      kind: 'navigate',
      section: 'metrics',
      selection: { kind: 'change', id: 'full-feature' },
    });
  });

  it('повторный вызов переключает ту же панель, а не создаёт вторую', async () => {
    const state = await activate([copyFixture('full-change')]);
    await command(state, 'openspec.openMetrics', findNode(topNodes(state), 'change:full-feature'));
    const panel = lastPanel(state);
    panel.webview.receive({ kind: 'ready' });

    await command(state, 'openspec.openBoard');

    expect(state.panels).toHaveLength(1);
    expect(panel.title).toBe('OpenSpec: Доска');
    await until(
      () => panel.webview.posted.some((message) => (message as { section?: string }).section === 'board'),
      'переключение на доску',
    );
  });

  it('отвечает на запрос панели тем же, что HTTP-режим, и отказывает вне /api/', async () => {
    const state = await activate([copyFixture('full-change')]);
    await command(state, 'openspec.openBoard');
    const panel = lastPanel(state);

    panel.webview.receive({ kind: 'request', id: 1, method: 'GET', path: '/api/workspace' });
    panel.webview.receive({ kind: 'request', id: 2, method: 'GET', path: '/etc/passwd' });
    await until(() => panel.webview.posted.length >= 2, 'ответы панели');

    const replies = panel.webview.posted as { id: number; status: number; body: { state?: string } }[];
    const workspace = replies.find((reply) => reply.id === 1);
    const outside = replies.find((reply) => reply.id === 2);
    expect(workspace?.status).toBe(200);
    expect(workspace?.body.state).toBe('ready');
    expect(outside?.status).toBe(400);
  });

  it('открывает файл по просьбе панели и отказывает в пути за пределами корня', async () => {
    const root = copyFixture('full-change');
    const state = await activate([root]);
    await command(state, 'openspec.openSearch');
    const panel = lastPanel(state);

    panel.webview.receive({ kind: 'open-file', path: 'openspec/changes/full-feature/design.md', line: 3 });
    panel.webview.receive({ kind: 'open-file', path: '../../etc/passwd', line: null });
    await until(() => state.messages.some((message) => message.level === 'warning'), 'отказ в пути');

    expect(state.shownDocuments).toEqual([
      { path: join(root, 'openspec', 'changes', 'full-feature', 'design.md'), line: 3 },
    ]);
    expect(state.messages.find((message) => message.level === 'warning')?.text).toContain('вне рабочего пространства');
  });

  it('разметка панели запрещает сеть и сторонние скрипты', async () => {
    const state = await activate([copyFixture('full-change')]);
    await command(state, 'openspec.openBoard');
    const html = lastPanel(state).webview.html;

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("connect-src 'none'");
    if (existsSync(join(EXTENSION_DIR, 'media', 'web', 'index.html'))) {
      expect(html).toMatch(/<script[^>]*nonce="[A-Za-z0-9]+"[^>]*src="[^"]*\/media\/web\/assets\//);
    }
  });
});

describe('расширение VS Code: валидация и команды', () => {
  it('проверка change с ошибками раскладывает замечания в панель «Проблемы»', async () => {
    const root = copyFixture('bare-change');
    const state = await activate([root]);

    await command(state, 'openspec.validateChange', findNode(topNodes(state), 'change:bare-feature'));

    const all = [...state.diagnostics.entries()];
    expect(all.length).toBeGreaterThan(0);
    for (const [path] of all) expect(path.startsWith(join(root, 'openspec', 'changes', 'bare-feature'))).toBe(true);
    expect(all.flatMap(([, list]) => list).some((item) => item.source === 'openspec')).toBe(true);
    expect(state.messages.at(-1)?.level).toBe('warning');
  });

  it('создаёт change командой с выбором схемы', async () => {
    const root = copyFixture('empty');
    const state = await activate([root]);

    state.answers.push('add-thing', 'spec-driven');
    await command(state, 'openspec.newChange');

    expect(existsSync(join(root, 'openspec', 'changes', 'add-thing'))).toBe(true);
    await until(() => findNode(topNodes(state), 'change:add-thing') !== undefined, 'change в дереве');
  });

  it('создаёт change с замыслом и открывает агента по первому артефакту схемы', async () => {
    const root = copyFixture('empty');
    const state = await activate([root]);

    state.answers.push('add-export', 'spec-driven', 'Выгрузка данных пользователя в CSV');
    await command(state, 'openspec.newChange');

    const panel = lastPanel(state);
    panel.webview.receive({ kind: 'ready' });
    await until(() => panel.webview.posted.length > 0, 'навигация к агенту');
    expect(panel.webview.posted[0]).toMatchObject({
      section: 'agent',
      selection: { kind: 'change', id: 'add-export' },
      agent: { artifact: 'proposal', brief: 'Выгрузка данных пользователя в CSV' },
    });
  });

  it('архивирует change из палитры: подтверждение перечисляет изменения спеков', async () => {
    const root = copyFixture('full-change');
    const state = await activate([root]);

    state.answers.push('full-feature', 'Архивировать');
    await command(state, 'openspec.archiveChange');

    const confirm = state.messages.find((message) => message.text.startsWith('Архивировать change'));
    expect(confirm?.detail).toContain('data-export — новая: +1');
    expect(confirm?.buttons).toEqual(['Архивировать', 'Показать изменения спеков']);
    expect(existsSync(join(root, 'openspec', 'changes', 'full-feature'))).toBe(false);
    expect(existsSync(join(root, 'openspec', 'specs', 'data-export', 'spec.md'))).toBe(true);
    expect(findNode(topNodes(state), 'change:full-feature')).toBeUndefined();
  });

  it('архивацию, которую CLI отклонит, не предлагает и объясняет', async () => {
    const root = copyFixture('delta-ops');
    const state = await activate([root]);

    await command(state, 'openspec.archiveChange', findNode(topNodes(state), 'change:rework-export'));

    const refusal = state.messages.find((message) => message.level === 'error');
    expect(refusal?.text).toContain('CLI отклонит');
    expect(refusal?.detail).toContain('Пустой набор данных');
    expect(refusal?.buttons).not.toContain('Архивировать');
    expect(existsSync(join(root, 'openspec', 'changes', 'rework-export'))).toBe(true);
  });

  it('предпросмотр архивации открывает сравнение: слева пусто, справа спек после архивации', async () => {
    const root = copyFixture('full-change');
    const state = await activate([root]);

    await command(state, 'openspec.previewArchive', findNode(topNodes(state), 'change:full-feature'));

    expect(state.diffs).toHaveLength(1);
    const [diff] = state.diffs;
    const provider = state.contentProviders.get('openspec-preview');
    expect(diff?.left.scheme).toBe('openspec-preview');
    expect(provider?.provideTextDocumentContent(diff!.left)).toBe('');
    expect(provider?.provideTextDocumentContent(diff!.right)).toContain('### Requirement: Выгрузка данных');
    expect(diff?.title).toContain('data-export');
    // Файлы проекта предпросмотр не трогает.
    expect(existsSync(join(root, 'openspec', 'changes', 'full-feature'))).toBe(true);
    expect(existsSync(join(root, 'openspec', 'specs', 'data-export'))).toBe(false);
  });

  it('панель просит сравнение по имени capability — расширение строит его само', async () => {
    const state = await activate([copyFixture('full-change')]);
    await command(state, 'openspec.openBoard');
    const panel = lastPanel(state);

    panel.webview.receive({ kind: 'preview-archive', change: 'full-feature', capability: 'data-export' });
    await until(() => state.diffs.length === 1, 'сравнение из панели');

    expect(state.diffs[0]?.right.path).toBe('/full-feature/data-export/spec.md');
  });
});
