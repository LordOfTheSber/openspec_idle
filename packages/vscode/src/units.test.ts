import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalize } from '@openspec-ide/server';
import { handleViewMessage, resolvePanelPath } from './bridge.js';
import { changesTouched, diagnosticsByFile } from './diagnosticsModel.js';
import { renderPanelHtml } from './panelHtml.js';
import { pickWorkspaceRoot } from './root.js';

const temporary: string[] = [];

function directory(): string {
  const path = canonicalize(mkdtempSync(join(tmpdir(), 'osi-vscode-unit-')));
  temporary.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('выбор корня', () => {
  it('берёт первую папку, в которой или выше которой есть openspec/', () => {
    const plain = directory();
    const project = directory();
    mkdirSync(join(project, 'openspec', 'changes'), { recursive: true });
    mkdirSync(join(project, 'src', 'deep'), { recursive: true });

    expect(pickWorkspaceRoot([plain, join(project, 'src', 'deep')])).toEqual({
      kind: 'found',
      root: project,
      folder: join(project, 'src', 'deep'),
    });
  });

  it('без openspec/ сообщает, что корень не найден', () => {
    const plain = directory();
    expect(pickWorkspaceRoot([plain]).kind).toBe('not-found');
    expect(pickWorkspaceRoot([]).kind).toBe('not-found');
  });
});

describe('диагностики валидации', () => {
  const exists = (path: string) => path.endsWith('proposal.md');

  it('замечание со строкой ложится на неё, без строки — на начало файла', () => {
    const result = diagnosticsByFile(
      'add-x',
      [
        { level: 'ERROR', message: 'нет сценария', file: 'openspec/changes/add-x/specs/a/spec.md', line: 12 },
        { level: 'WARNING', message: 'короткое описание', file: 'openspec/changes/add-x/specs/a/spec.md', line: null },
      ],
      exists,
    );
    expect(result.get('openspec/changes/add-x/specs/a/spec.md')).toEqual([
      { line: 11, level: 'error', message: 'нет сценария' },
      { line: 0, level: 'warning', message: 'короткое описание' },
    ]);
  });

  it('замечание без файла ложится на proposal.md, а без него — на каталог change', () => {
    const entry = { level: 'INFO' as const, message: 'общее', file: null, line: null };
    expect([...diagnosticsByFile('add-x', [entry], exists).keys()]).toEqual(['openspec/changes/add-x/proposal.md']);
    expect([...diagnosticsByFile('add-x', [entry], () => false).keys()]).toEqual(['openspec/changes/add-x']);
  });

  it('пути Windows приводятся к прямым косым', () => {
    const result = diagnosticsByFile(
      'add-x',
      [{ level: 'ERROR', message: 'x', file: 'openspec\\changes\\add-x\\tasks.md', line: 1 }],
      exists,
    );
    expect([...result.keys()]).toEqual(['openspec/changes/add-x/tasks.md']);
  });

  it('изменённые файлы сопоставляются changes, архив пропускается', () => {
    expect(
      changesTouched([
        'openspec/changes/b/tasks.md',
        'openspec/changes/a/specs/x/spec.md',
        'openspec/changes/b/design.md',
        'openspec/changes/archive/2026-01-01-old/tasks.md',
        'openspec/specs/x/spec.md',
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('разметка панели', () => {
  const built = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <script type="module" crossorigin src="./assets/index-1.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-1.css">
    <script src="https://example.com/x.js"></script>
    <script>alert(1)</script>
    <link rel="stylesheet" href="https://example.com/x.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

  const html = renderPanelHtml(built, {
    assetUri: (relative) => `vscode-webview://ext/media/web/${relative}`,
    cspSource: 'vscode-webview://ext',
    nonce: 'abc123',
  });

  it('переписывает ресурсы на адреса webview и ставит nonce только своему скрипту', () => {
    expect(html).toContain('<script type="module" nonce="abc123" src="vscode-webview://ext/media/web/assets/index-1.js">');
    expect(html).toContain('href="vscode-webview://ext/media/web/assets/index-1.css"');
    expect(html).not.toContain('crossorigin');
  });

  it('вырезает сторонние и встроенные скрипты и чужие стили', () => {
    expect(html).not.toContain('example.com');
    expect(html).not.toContain('alert(1)');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('запрещает сеть и разрешает скрипты только по nonce', () => {
    const policy = /content="([^"]+)"/.exec(html.slice(html.indexOf('Content-Security-Policy')))?.[1] ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'nonce-abc123'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toMatch(/https?:/);
  });
});

describe('мост панели', () => {
  function deps() {
    const posted: unknown[] = [];
    const opened: { path: string; line: number | null }[] = [];
    const warnings: string[] = [];
    let ready = 0;
    return {
      posted,
      opened,
      warnings,
      get ready() {
        return ready;
      },
      value: {
        backend: {
          request: async (method: string, path: string) => ({ status: 200, body: { method, path } }),
        },
        post: (message: unknown) => posted.push(message),
        openFile: async (path: string, line: number | null) => {
          opened.push({ path, line });
        },
        onReady: () => {
          ready += 1;
        },
        warn: (text: string) => warnings.push(text),
      },
    };
  }

  it('передаёт запрос бэкенду и отвечает с тем же номером', async () => {
    const context = deps();
    await handleViewMessage({ kind: 'request', id: 5, method: 'GET', path: '/api/board' }, context.value);
    expect(context.posted).toEqual([{ kind: 'response', id: 5, status: 200, body: { method: 'GET', path: '/api/board' } }]);
  });

  it('некорректный запрос с номером получает отказ, без номера — предупреждение в журнал', async () => {
    const context = deps();
    await handleViewMessage({ kind: 'request', id: 6, method: 'GET', path: '/' }, context.value);
    await handleViewMessage({ kind: 'eval', code: '1' }, context.value);
    expect(context.posted).toEqual([
      { kind: 'response', id: 6, status: 400, body: { error: 'Путь «/» недоступен панели' } },
    ]);
    expect(context.warnings).toHaveLength(1);
  });

  it('сбой бэкенда превращается в ответ 500, а не в вечное ожидание', async () => {
    const context = deps();
    context.value.backend.request = async () => {
      throw new Error('упал');
    };
    await handleViewMessage({ kind: 'request', id: 7, method: 'GET', path: '/api/board' }, context.value);
    expect(context.posted).toEqual([{ kind: 'response', id: 7, status: 500, body: { error: 'упал' } }]);
  });

  it('открытие файла и готовность передаются расширению', async () => {
    const context = deps();
    await handleViewMessage({ kind: 'open-file', path: 'openspec/a.md', line: 4 }, context.value);
    await handleViewMessage({ kind: 'ready' }, context.value);
    expect(context.opened).toEqual([{ path: 'openspec/a.md', line: 4 }]);
    expect(context.ready).toBe(1);
  });
});

describe('пути, которые панели разрешено открыть', () => {
  it('разрешает файл внутри корня и отклоняет переход наружу и ссылку наружу', () => {
    const root = directory();
    const outside = directory();
    mkdirSync(join(root, 'openspec'), { recursive: true });
    symlinkSync(outside, join(root, 'openspec', 'escape'));

    expect(resolvePanelPath(root, 'openspec/a.md')).toBe(join(root, 'openspec', 'a.md'));
    expect(resolvePanelPath(root, '../../etc/passwd')).toBeNull();
    expect(resolvePanelPath(root, 'openspec/escape/secret.md')).toBeNull();
    expect(resolvePanelPath(null, 'openspec/a.md')).toBeNull();
  });
});
