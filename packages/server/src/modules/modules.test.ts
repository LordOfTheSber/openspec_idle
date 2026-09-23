import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignIds, diffWithMap, discoverModules, goManifest, gradleManifest, mavenManifest, pythonManifest, dotnetManifest } from './discovery.js';
import { GitIgnore } from './gitignore.js';
import { ModuleMapStore } from './mapStore.js';

const FIXTURE = fileURLToPath(new URL('../../../../tests/fixtures/monorepo', import.meta.url));
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'osi-modules-'));
  cpSync(FIXTURE, root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ModuleMapStore', () => {
  it('читает корректную карту фикстуры без ошибок', async () => {
    const view = await new ModuleMapStore(root).read();
    expect(view.exists).toBe(true);
    expect(view.problems).toEqual([]);
    expect(view.modules.map((module) => module.id)).toEqual([
      'auth',
      'billing',
      'orders',
      'notifications',
      'reports',
      'web-ui',
      'km/core',
      'km/auth-client',
      'km/events',
      'km/ui-kit',
    ]);
  });

  it('ошибочная карта: отсутствующий каталог и неизвестная зависимость с модулем и полем', async () => {
    writeFileSync(
      join(root, 'openspec/modules.yaml'),
      'modules:\n  - { id: a, title: A, kind: service, path: nowhere, specs: a, dependsOn: [b] }\n  - { id: c, title: C, kind: library, path: km/core, specs: c }\n',
    );
    const view = await new ModuleMapStore(root).read();
    expect(view.problems).toEqual([
      { module: 'a', field: 'dependsOn', message: 'Неизвестный модуль b' },
      { module: 'a', field: 'path', message: 'Каталог кода nowhere не существует' },
    ]);
    expect(view.modules.map((module) => module.id)).toEqual(['a', 'c']);
  });

  it('YAML с ошибкой синтаксиса — ошибка карты, модулей нет', async () => {
    writeFileSync(join(root, 'openspec/modules.yaml'), 'modules: [\n');
    const view = await new ModuleMapStore(root).read();
    expect(view.problems[0]?.field).toBe('yaml');
    expect(view.modules).toEqual([]);
  });

  it('без карты — exists: false', async () => {
    unlinkSync(join(root, 'openspec/modules.yaml'));
    expect((await new ModuleMapStore(root).read()).exists).toBe(false);
  });

  it('запись сохраняет неизвестные ключи, комментарии и порядок', async () => {
    const store = new ModuleMapStore(root);
    const view = await store.read();
    const modules = view.modules.map((module) => ({ ...module, path: module.path ?? '' }));
    modules[1] = { ...modules[1]!, title: 'Биллинг и счета', dependsOn: ['km/core'] };
    await store.write([...modules.filter((module) => module.id !== 'reports')]);
    const text = readFileSync(join(root, 'openspec/modules.yaml'), 'utf8');
    expect(text).toContain('# Карта модулей платформы.');
    expect(text).toContain('owner: team-billing');
    expect(text).toContain('title: Биллинг и счета');
    expect(text).not.toContain('id: reports');
    const reread = await new ModuleMapStore(root).read();
    expect(reread.modules.find((module) => module.id === 'billing')?.dependsOn).toEqual(['km/core']);
  });

  it('запись создаёт карту с нуля', async () => {
    unlinkSync(join(root, 'openspec/modules.yaml'));
    const store = new ModuleMapStore(root);
    await store.write([{ id: 'x', title: 'X', kind: 'library', path: 'km/core', specs: 'x', group: null, dependsOn: [] }]);
    expect(readFileSync(join(root, 'openspec/modules.yaml'), 'utf8')).toBe(
      'version: 1\nmodules:\n  - id: x\n    title: X\n    kind: library\n    path: km/core\n    specs: x\n',
    );
  });
});

describe('обнаружение модулей', () => {
  it('монорепо на Maven и npm: пять сервисов, UI, КМ из четырёх библиотек, зависимости', async () => {
    // Каталоги зависимостей и сборки есть на диске, но не обходятся.
    mkdirSync(join(root, 'node_modules/left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules/left-pad/package.json'), '{"name":"left-pad"}');
    mkdirSync(join(root, 'services/billing/target/classes'), { recursive: true });
    writeFileSync(join(root, 'services/billing/target/classes/pom.xml'), '<project><artifactId>copy</artifactId></project>');

    const found = await discoverModules(root);
    const summary = Object.fromEntries(found.map((module) => [module.id, [module.kind, module.path, module.dependsOn]]));
    expect(summary).toEqual({
      'km/auth-client': ['library', 'km/auth-client', ['km/core']],
      'km/core': ['library', 'km/core', []],
      'km/events': ['library', 'km/events', ['km/core']],
      'km/ui-kit': ['library', 'km/ui-kit', []],
      auth: ['service', 'services/auth', ['km/core', 'km/auth-client']],
      billing: ['service', 'services/billing', ['km/core', 'km/events']],
      notifications: ['service', 'services/notifications', []],
      orders: ['service', 'services/orders', ['km/core', 'billing']],
      reports: ['service', 'services/reports', ['billing']],
      ui: ['ui', 'ui', ['km/ui-kit']],
    });
    expect(found.find((module) => module.id === 'billing')).toMatchObject({
      title: 'Биллинг',
      group: 'services',
      specs: 'billing',
      manifest: 'services/billing/pom.xml',
      manifestKind: 'maven',
    });
    expect(found.some((module) => module.path.includes('generated'))).toBe(false);
  });

  it('повторное обнаружение при карте: только новое и расхождения зависимостей', async () => {
    mkdirSync(join(root, 'services/payments'), { recursive: true });
    writeFileSync(join(root, 'services/payments/package.json'), JSON.stringify({ name: 'payments', scripts: { start: 'x' }, dependencies: { '@platform/ui-kit': '1' } }));
    const map = await new ModuleMapStore(root).read();
    // В карте у orders лишняя связь с billing убрана, а в коде она есть.
    const edited = map.modules.map((module) => (module.id === 'orders' ? { ...module, dependsOn: ['km/core'] } : module));
    const diff = diffWithMap(await discoverModules(root), edited);
    expect(diff.added.map((module) => module.id)).toEqual(['payments']);
    expect(diff.dependencyChanges).toEqual([{ id: 'orders', add: ['billing'], remove: [] }]);
    expect(diff.missing).toEqual([]);
  });
});

describe('манифесты', () => {
  it('Gradle: путь проекта и project(...)', () => {
    const roots = new Map([['', true]]);
    const info = gradleManifest('services/billing', 'build.gradle.kts', 'plugins { id("org.springframework.boot") }\ndependencies { implementation(project(":km:core")) }', roots);
    expect(info.names).toEqual(['gradle:|:services:billing']);
    expect(info.references).toEqual(['gradle:|:km:core']);
    expect(info.kind).toBe('service');
    expect(gradleManifest('', 'build.gradle', 'subprojects {}', roots).aggregator).toBe(true);
  });

  it('Maven: собственные координаты, а не родителя; dependencyManagement не зависимости', () => {
    const info = mavenManifest('a', '<project><parent><groupId>g</groupId><artifactId>parent</artifactId></parent><artifactId>a</artifactId><dependencyManagement><dependencies><dependency><groupId>g</groupId><artifactId>x</artifactId></dependency></dependencies></dependencyManagement><dependencies><dependency><groupId>g</groupId><artifactId>b</artifactId></dependency></dependencies></project>');
    expect(info.names).toEqual(['g:a']);
    expect(info.references).toEqual(['g:b']);
  });

  it('Go, .NET, Python', () => {
    const go = goManifest('svc', 'module example.com/svc\n\nrequire (\n\texample.com/lib v0.0.0\n)\n\nreplace example.com/lib => ../lib\n', new Set(['go.mod', 'main.go']));
    expect(go).toMatchObject({ names: ['example.com/svc'], kind: 'service' });
    expect(go.references).toEqual(['example.com/lib', 'path:lib']);
    const dotnet = dotnetManifest('src/Api', 'Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><ProjectReference Include="..\\Core\\Core.csproj" /></ItemGroup></Project>');
    expect(dotnet).toMatchObject({ names: ['Api'], references: ['path:src/Core'], kind: 'service' });
    const python = pythonManifest('py', '[project]\nname = "Report_Tools"\ndependencies = ["km-core>=1", "requests"]\n\n[project.scripts]\nreport = "x:main"\n');
    expect(python).toMatchObject({ names: ['report-tools'], references: ['km-core', 'requests'], kind: 'service' });
  });

  it('id без каталога-контейнера и уникальные', () => {
    expect(assignIds(['services/billing', 'km/core', 'ui', 'apps/core', 'libs/core'])).toEqual([
      'billing',
      'km/core',
      'ui',
      'apps/core',
      'libs/core',
    ]);
  });

  it('.gitignore: каталоги, якоря, шаблоны и отрицание', () => {
    const ignore = new GitIgnore('generated/\n/build-cache\n*.tmp\n**/fixtures/**\n!keep.tmp\n');
    expect(ignore.ignores('generated', true)).toBe(true);
    expect(ignore.ignores('a/generated', true)).toBe(true);
    expect(ignore.ignores('generated', false)).toBe(false);
    expect(ignore.ignores('build-cache', true)).toBe(true);
    expect(ignore.ignores('a/build-cache', true)).toBe(false);
    expect(ignore.ignores('x/y.tmp', false)).toBe(true);
    expect(ignore.ignores('keep.tmp', false)).toBe(false);
    expect(ignore.ignores('a/fixtures/b', true)).toBe(true);
  });
});
