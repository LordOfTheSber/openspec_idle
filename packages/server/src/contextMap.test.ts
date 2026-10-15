import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextBundle } from '@openspec-ide/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixturePath } from '../../../tests/fixtures.js';
import { ContextMapService, codePathExists, parseFrontmatter, scanContext } from './contextMap.js';
import { canonicalize } from './fs/workspace.js';

let root: string;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-context-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content = ''): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

describe('frontmatter со строками', () => {
  it('строки ключей считаются от начала файла', () => {
    const parsed = parseFrontmatter('---\nmodule: m\n\ndomains: [a, b]\ndepends_on: [x]\n---\n# M\n');
    expect(parsed.value).toEqual({ module: 'm', domains: ['a', 'b'], depends_on: ['x'] });
    expect(parsed.lineOf('module')).toBe(2);
    expect(parsed.lineOf('domains')).toBe(4);
    expect(parsed.lineOf('depends_on')).toBe(5);
    expect(parsed.body).toBe('# M\n');
  });

  it('ошибка YAML — со строкой в файле', () => {
    const parsed = parseFrontmatter('---\nmodule: m\ndomains: [a, b\n---\n');
    expect(parsed.value).toBeNull();
    expect(parsed.error?.line).toBeGreaterThanOrEqual(3);
  });
});

describe('пути кода', () => {
  it('существующий путь, шаблон по префиксу, путь наружу и абсолютный', async () => {
    write('svc/src/main/java/App.java');
    expect(await codePathExists(root, 'svc/src')).toBe(true);
    expect(await codePathExists(root, 'svc/src/main/java/**/*.java')).toBe(true);
    expect(await codePathExists(root, 'svc/src/main/java/...')).toBe(true);
    expect(await codePathExists(root, 'other/**')).toBe(false);
    expect(await codePathExists(root, '../outside')).toBe(false);
    expect(await codePathExists(root, '/etc')).toBe(false);
    expect(await codePathExists(root, '**/*.java')).toBe(true);
  });
});

describe('карта контекста с диска', () => {
  it('фикстура: модули, домены, ADR, общий контекст и замечания', async () => {
    const map = await new ContextMapService(fixturePath('context-map')).build();

    expect(map.configured).toBe(true);
    expect(map.general).toEqual(['openspec/context/1.md', 'openspec/context/2.md', 'openspec/context/3.md']);
    expect(map.modules.map((module) => [module.id, module.folder])).toEqual([
      ['sds-master', 'modules/master'],
      ['sds-impl', 'modules/sds-impl'],
    ]);
    expect(map.domains.map((domain) => [domain.id, domain.modules])).toEqual([
      ['cm-cluster-api', []],
      ['replication', ['sds-impl', 'sds-master']],
      ['servant-master-api', ['sds-impl']],
      ['session-data', ['sds-master']],
      ['session-lifecycle', ['sds-master']],
    ]);
    expect(map.adrs.map((adr) => [adr.id, adr.title, adr.status])).toEqual([
      ['ADR-001-sync-replication', 'ADR-001: Синхронная репликация данных сессии', 'accepted'],
    ]);
    expect(map.issues.map((issue) => [issue.kind, issue.path, issue.line])).toEqual([
      ['unknown-module', 'openspec/context/modules/sds-impl/index.md', 6],
      ['missing-code-path', 'openspec/context/modules/sds-impl/index.md', 5],
      ['uncovered-domain', 'openspec/specs/cm-cluster-api/spec.md', null],
      ['empty-context', 'openspec/context/modules/sds-impl/context.md', null],
    ]);
    // Объём известен для общего контекста, модулей, спек и ADR.
    expect(map.files.map((file) => file.path)).toContain('openspec/specs/replication/spec.md');
    expect(map.files.map((file) => file.path)).toContain('openspec/context/adr/ADR-001-sync-replication.md');
    expect(map.totalTokens).toBeGreaterThan(0);
    expect(map.modules[0]?.bundleTokens).toBeGreaterThan(0);
    expect(map.unusedFiles).toEqual([]);
  });

  it('фикстура с нумерованными частями: модули в группе, части по номерам, замечаний нет', async () => {
    const map = await new ContextMapService(fixturePath('context-layered')).build();

    expect(map.general).toEqual([
      'openspec/context/01-product-context.md',
      'openspec/context/02-architecture.md',
      'openspec/context/03-engineering-standards.md',
      'openspec/context/04-security-and-compliance.md',
      'openspec/context/05-testing-and-quality.md',
      'openspec/context/failure-log.md',
      'openspec/context/glossary.md',
      'openspec/context/index.md',
    ]);
    expect(map.modules.map((module) => [module.id, module.folder, module.files.length])).toEqual([
      ['cm', 'modules/back/cm', 5],
      ['configuration', 'modules/back/configuration', 5],
      ['master', 'modules/back/master', 6],
      ['conf', 'modules/conf', 4],
    ]);
    expect(map.modules.find((module) => module.id === 'master')?.files[0]).toBe('openspec/context/modules/back/master/00-start-here.md');
    expect(map.modules.find((module) => module.id === 'cm')?.adrs).toEqual(['openspec/context/adr/ADR-001-sync-replication.md']);
    expect(map.issues.filter((issue) => issue.severity !== 'info')).toEqual([]);
    expect(map.unusedFiles).toEqual([]);
  });

  it('без папки контекста карта не заведена, домены — из спеков, включая вложенные', async () => {
    write('openspec/specs/identity/auth/spec.md', '# auth');
    write('openspec/specs/billing/spec.md', '# billing');
    write('openspec/specs/billing/notes.md', '');
    const map = await new ContextMapService(root).build();
    expect(map.configured).toBe(false);
    expect(map.domains.map((domain) => domain.id)).toEqual(['billing', 'identity/auth']);
    expect(map.issues).toEqual([]);
  });

  it('модуль без файла метаданных и без файлов контекста', async () => {
    write('openspec/context/modules/empty/.gitkeep');
    write('openspec/context/modules/meta-only/index.md', '---\nmodule: meta-only\n---\n');
    write('openspec/context/modules/start-only/00-start-here.md', '---\nmodule: start-only\n---\n\n# start-only\n');
    const map = await new ContextMapService(root).build();
    expect(map.issues.map((issue) => `${issue.kind}:${issue.module ?? ''}`)).toEqual([
      'missing-index:empty',
      'missing-context:meta-only',
      'missing-context:start-only',
      'no-code-paths:meta-only',
      'no-code-paths:start-only',
    ]);
  });
});

describe('контроль контекста с диска', () => {
  const index = (codePaths: string): string => `---\nmodule: svc\ndomains: []\ncode_paths: [${codePaths}]\n---\n# svc\n`;

  it('пути в тексте: от кода модуля, от файла и от корня; пропавший — предупреждение; файлы вне наборов', async () => {
    write('svc/src/main/App.java');
    write('README.md', '# readme');
    write('openspec/context/adr/ADR-001.md', '# ADR-001\n\nСм. [readme](../../../README.md).\n');
    write('openspec/context/adr/README.md', '# Решения');
    write('openspec/context/adr/diagram.png');
    write('openspec/context/notes/todo.txt');
    write('openspec/context/modules/svc/index.md', index('svc/src'));
    write('openspec/context/modules/svc/notes.md', '# черновик');
    write('openspec/context/modules/svc/diagram.drawio');
    write('openspec/context/modules/svc/context.md', '# svc\n\nВход — `main/App.java`, разбор — `main/Parser.java`.\n');

    const map = await new ContextMapService(root).build();
    expect(map.references.map((ref) => [ref.path, ref.target, ref.resolved])).toEqual([
      ['openspec/context/modules/svc/context.md', 'main/App.java', true],
      ['openspec/context/modules/svc/context.md', 'main/Parser.java', false],
      ['openspec/context/adr/ADR-001.md', '../../../README.md', true],
    ]);
    expect(map.issues.filter((issue) => issue.kind === 'broken-reference')).toEqual([
      expect.objectContaining({ path: 'openspec/context/modules/svc/context.md', line: 3, module: 'svc' }),
    ]);
    // .md рядом с файлом метаданных — часть модуля, остальное — вне наборов.
    expect(map.modules[0]?.files).toEqual(['openspec/context/modules/svc/context.md', 'openspec/context/modules/svc/notes.md']);
    expect(map.unusedFiles).toEqual([
      'openspec/context/adr/diagram.png',
      'openspec/context/modules/svc/diagram.drawio',
      'openspec/context/notes/todo.txt',
    ]);
    // Каталог не в git — свежесть не известна, замечаний о ней нет.
    expect(map.modules[0]?.freshness).toBeNull();
    expect(map.issues.some((issue) => issue.kind === 'stale-context')).toBe(false);
  });

  it('git: коммиты в коде после правки файлов модуля — сведение; незакоммиченная правка контекста — свежий', async () => {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
    };
    git('init', '-q');
    write('svc/src/App.java', 'class App {}');
    write('openspec/context/modules/svc/index.md', index('svc/src/**'));
    write('openspec/context/modules/svc/context.md', '# svc\n\nСервис.\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    for (const version of [1, 2]) {
      write('svc/src/App.java', `class App { int v = ${version}; }`);
      git('commit', '-q', '-am', `code ${version}`);
    }
    write('svc/README.md', 'не код модуля');
    git('add', '.');
    git('commit', '-q', '-m', 'docs');

    const stale = await new ContextMapService(root).build();
    expect(stale.modules[0]?.freshness).toMatchObject({ commitsAfter: 2, uncommitted: false });
    expect(stale.modules[0]?.freshness?.contextDate).not.toBeNull();
    expect(stale.issues.find((issue) => issue.kind === 'stale-context')).toMatchObject({ severity: 'info', module: 'svc' });

    write('openspec/context/modules/svc/context.md', '# svc\n\nСервис, версия 2.\n');
    const edited = await new ContextMapService(root).build();
    expect(edited.modules[0]?.freshness).toMatchObject({ commitsAfter: 0, uncommitted: true });
    expect(edited.issues.some((issue) => issue.kind === 'stale-context')).toBe(false);

    // Коммит любого файла модуля, не только context.md, освежает контекст.
    git('checkout', '-q', '--', '.');
    write('openspec/context/modules/svc/02-architecture.md', '# Архитектура\n\nСлои сервиса.\n');
    git('add', '.');
    git('commit', '-q', '-m', 'architecture');
    const fresh = await new ContextMapService(root).build();
    expect(fresh.modules[0]?.freshness).toMatchObject({ commitsAfter: 0, uncommitted: false });
  });
});

describe('раскладка контекста: разделы, группы, вложенные модули', () => {
  const start = (id: string, extra = ''): string => `---\nmodule: ${id}\ncode_paths: [svc]\n${extra}---\n\n# ${id}\n`;

  beforeEach(() => {
    write('svc/App.java');
    write('openspec/specs/replication/spec.md', '# replication');
    write('openspec/context/index.md', '# Контекст\n\nС чего начать.\n');
    write('openspec/context/01-product-context.md', '# Продукт\n\nОбщее.\n');
    write('openspec/context/glossary.md', '# Глоссарий\n\nТермины.\n');
    write('openspec/context/failure-log.md', '# Журнал сбоев\n\nСбои.\n');
    write('openspec/context/adr/README.md', '# Решения');
    write('openspec/context/adr/ADR-001.md', '---\nstatus: accepted\nmodules: [master]\n---\n# ADR-001\n');
    write('openspec/context/modules/back/03-engineering-standards.md', '# Backend\n\nСборка бэкенда.\n');
    write('openspec/context/modules/back/master/00-start-here.md', `${start('master', 'domains: [replication]\n')}\nЧитайте 01-product-context.md.\n`);
    write('openspec/context/modules/back/master/01-product-context.md', '# Продукт\n\nОперации Master.\n');
    write('openspec/context/modules/back/master/02-architecture.md', '# Архитектура\n\nАнти-паттерны.\n');
    write('openspec/context/modules/back/master/examples/request.md', '# Пример\n\nЗапрос.\n');
    write('openspec/context/modules/back/master/examples/request.json', '{}');
    write('openspec/context/modules/back/master/replica/00-start-here.md', `${start('replica')}\nРеплика.\n`);
    write('openspec/context/modules/back/cm/00-start-here.md', start('cm', 'depends_on: [master]\n'));
    write('openspec/context/modules/back/cm/01-product-context.md', '# cm\n\nКластер.\n');
    write('openspec/context/modules/back/configuration/index.md', start('configuration'));
    write('openspec/context/modules/back/configuration/context.md', '# configuration\n\nНастройки.\n');
    write('openspec/context/modules/conf/00-start-here.md', start('conf'));
    write('openspec/context/modules/conf/01-product-context.md', '# conf\n\nКонфиги.\n');
    write('openspec/context/modules/ui/01-product-context.md', '# ui\n\nБез файла метаданных.\n');
    write('openspec/context/functions/billing/00-start-here.md', `${start('billing')}\nБиллинг.\n`);
    write('openspec/context/functions/README.md', '# Функции\n\nОбщее для функций.\n');
  });

  it('файлы раскладываются по общему контексту, группам, модулям, ADR и лишнему', async () => {
    const layout = await scanContext(root);
    expect(layout.general).toEqual([
      'openspec/context/01-product-context.md',
      'openspec/context/failure-log.md',
      'openspec/context/glossary.md',
      'openspec/context/index.md',
    ]);
    expect(layout.adrs).toEqual(['openspec/context/adr/ADR-001.md']);
    expect(layout.groups).toEqual([
      { folder: 'functions', files: ['openspec/context/functions/README.md'] },
      { folder: 'modules/back', files: ['openspec/context/modules/back/03-engineering-standards.md'] },
    ]);
    expect(layout.modules.map((module) => [module.folder, module.index, [...module.files].sort()])).toEqual(
      expect.arrayContaining([
        ['modules/back/master', '00-start-here.md', ['01-product-context.md', '02-architecture.md', 'examples/request.md']],
        ['modules/back/master/replica', '00-start-here.md', []],
        ['modules/back/cm', '00-start-here.md', ['01-product-context.md']],
        ['modules/back/configuration', 'index.md', ['context.md']],
        ['modules/conf', '00-start-here.md', ['01-product-context.md']],
        ['modules/ui', null, ['01-product-context.md']],
        ['functions/billing', '00-start-here.md', []],
      ]),
    );
    expect(layout.modules).toHaveLength(7);
    expect(layout.unused).toEqual(['openspec/context/modules/back/master/examples/request.json']);
  });

  it('карта: модули из всех разделов, набор — с группами, папка без файла метаданных — ошибка', async () => {
    const map = await new ContextMapService(root).build();
    expect(map.modules.map((module) => [module.id, module.section])).toEqual([
      ['billing', 'functions'],
      ['cm', 'modules'],
      ['configuration', 'modules'],
      ['master', 'modules'],
      ['replica', 'modules'],
      ['conf', 'modules'],
      ['ui', 'modules'],
    ]);
    const master = map.modules.find((module) => module.id === 'master');
    expect(master?.files).toEqual([
      'openspec/context/modules/back/master/00-start-here.md',
      'openspec/context/modules/back/master/01-product-context.md',
      'openspec/context/modules/back/master/02-architecture.md',
      'openspec/context/modules/back/master/examples/request.md',
    ]);
    expect(master?.adrs).toEqual(['openspec/context/adr/ADR-001.md']);
    expect(map.modules.find((module) => module.id === 'billing')?.groupFiles).toEqual(['openspec/context/functions/README.md']);
    const cm = map.modules.find((module) => module.id === 'cm');
    expect(cm?.files).toEqual(['openspec/context/modules/back/cm/01-product-context.md']);
    expect(cm?.groupFiles).toEqual(['openspec/context/modules/back/03-engineering-standards.md']);

    const bundle = contextBundle(map, { modules: ['cm'] });
    expect(bundle.files.slice(0, 6)).toEqual([
      'openspec/context/01-product-context.md',
      'openspec/context/failure-log.md',
      'openspec/context/glossary.md',
      'openspec/context/index.md',
      'openspec/context/modules/back/03-engineering-standards.md',
      'openspec/context/modules/back/cm/01-product-context.md',
    ]);
    expect(bundle.files).toContain('openspec/context/modules/back/master/02-architecture.md');
    expect(bundle.files).toContain('openspec/specs/replication/spec.md');

    expect(map.issues.filter((issue) => issue.severity !== 'info').map((issue) => [issue.kind, issue.path])).toEqual([
      ['missing-index', 'openspec/context/modules/ui'],
      ['unused-file', 'openspec/context/modules/back/master/examples/request.json'],
    ]);
    expect(map.unusedFiles).toEqual(['openspec/context/modules/back/master/examples/request.json']);
  });

  it('новый модуль — в разделе modules, с группой в имени; раскладка — как у модулей проекта', async () => {
    const service = new ContextMapService(root);
    expect(await service.createModule('back/router')).toEqual({
      index: 'openspec/context/modules/back/router/00-start-here.md',
      context: 'openspec/context/modules/back/router/01-product-context.md',
    });
    await expect(service.createModule('back/router')).rejects.toMatchObject({ status: 409 });
    await expect(service.createModule('Back/Router')).rejects.toMatchObject({ status: 400 });
    await expect(service.createModule('../x')).rejects.toMatchObject({ status: 400 });
    const map = await service.build();
    expect(map.modules.find((module) => module.id === 'router')?.folder).toBe('modules/back/router');
  });

  it('проект на прежней раскладке получает index.md и context.md', async () => {
    rmSync(join(root, 'openspec/context'), { recursive: true, force: true });
    write('openspec/context/modules/web/index.md', start('web'));
    write('openspec/context/modules/web/context.md', '# web\n\nИнтерфейс.\n');
    expect(await new ContextMapService(root).createModule('core')).toEqual({
      index: 'openspec/context/modules/core/index.md',
      context: 'openspec/context/modules/core/context.md',
    });
  });
});
