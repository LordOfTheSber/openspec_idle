import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePath } from '../../../tests/fixtures.js';
import { ContextMapService, codePathExists, parseFrontmatter } from './contextMap.js';
import { canonicalize } from './fs/workspace.js';
import { GitHistory } from './git.js';

let root: string;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-context-')));
});

afterEach(() => {
  vi.restoreAllMocks();
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
      ['sds-master', 'master'],
      ['sds-impl', 'sds-impl'],
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

  it('без папки контекста карта не заведена, домены — из спеков, включая вложенные', async () => {
    write('openspec/specs/identity/auth/spec.md', '# auth');
    write('openspec/specs/billing/spec.md', '# billing');
    write('openspec/specs/billing/notes.md', '');
    const map = await new ContextMapService(root).build();
    expect(map.configured).toBe(false);
    expect(map.domains.map((domain) => domain.id)).toEqual(['billing', 'identity/auth']);
    expect(map.issues).toEqual([]);
  });

  it('модуль без index.md и без context.md', async () => {
    write('openspec/context/modules/empty/.gitkeep');
    write('openspec/context/modules/meta-only/index.md', '---\nmodule: meta-only\n---\n');
    const map = await new ContextMapService(root).build();
    expect(map.issues.map((issue) => `${issue.kind}:${issue.module ?? ''}`)).toEqual([
      'missing-index:empty',
      'missing-context:meta-only',
      'no-code-paths:meta-only',
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
    expect(map.unusedFiles).toEqual([
      'openspec/context/adr/diagram.png',
      'openspec/context/modules/svc/notes.md',
      'openspec/context/notes/todo.txt',
    ]);
    // Каталог не в git — свежесть не известна, замечаний о ней нет.
    expect(map.modules[0]?.freshness).toBeNull();
    expect(map.issues.some((issue) => issue.kind === 'stale-context')).toBe(false);
  });

  it('git: коммиты в коде после context.md — сведение; незакоммиченная правка контекста — свежий', async () => {
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
  });

  describe('кэш свежести', () => {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
    };

    /** Два модуля: у каждого свой код, после контекста — один коммит в коде `a`. */
    function project(): void {
      git('init', '-q');
      for (const name of ['a', 'b']) {
        write(`${name}/src/App.java`, 'class App {}');
        write(`openspec/context/modules/${name}/index.md`, `---\nmodule: ${name}\ndomains: []\ncode_paths: [${name}/src]\n---\n# ${name}\n`);
        write(`openspec/context/modules/${name}/context.md`, `# ${name}\n\nМодуль ${name}.\n`);
      }
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      write('a/src/App.java', 'class App { int v = 1; }');
      git('commit', '-q', '-am', 'code a');
    }

    function spyHistory() {
      return {
        hasChanges: vi.spyOn(GitHistory.prototype, 'hasChanges'),
        lastCommit: vi.spyOn(GitHistory.prototype, 'lastCommit'),
        lastCommitDate: vi.spyOn(GitHistory.prototype, 'lastCommitDate'),
        commitsAfter: vi.spyOn(GitHistory.prototype, 'commitsAfter'),
      };
    }

    const freshness = (map: Awaited<ReturnType<ContextMapService['build']>>, folder: string) =>
      map.modules.find((module) => module.folder === folder)?.freshness;

    it('повторная сборка без изменений не запрашивает историю git, а свежесть та же', async () => {
      project();
      const service = new ContextMapService(root);
      const first = await service.build();
      expect(freshness(first, 'a')).toMatchObject({ commitsAfter: 1, uncommitted: false });

      const spies = spyHistory();
      const second = await service.build();
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
      expect(second.modules.map((module) => module.freshness)).toEqual(first.modules.map((module) => module.freshness));
      expect(second.issues).toEqual(first.issues);
    });

    it('новый коммит в коде модуля — отставание на один коммит больше, у другого модуля — как было', async () => {
      project();
      const service = new ContextMapService(root);
      await service.build();

      write('a/src/App.java', 'class App { int v = 2; }');
      git('commit', '-q', '-am', 'code a 2');
      const map = await service.build();
      expect(freshness(map, 'a')).toMatchObject({ commitsAfter: 2, uncommitted: false });
      expect(freshness(map, 'b')).toMatchObject({ commitsAfter: 0, uncommitted: false });
    });

    it('незакоммиченная правка context.md — свежий, пересчитан только этот модуль', async () => {
      project();
      const service = new ContextMapService(root);
      await service.build();

      write('openspec/context/modules/a/context.md', '# a\n\nМодуль a, версия 2.\n');
      const spies = spyHistory();
      const map = await service.build();
      expect(freshness(map, 'a')).toMatchObject({ commitsAfter: 0, uncommitted: true });
      expect(spies.hasChanges).toHaveBeenCalledTimes(1);
      expect(spies.hasChanges).toHaveBeenCalledWith('openspec/context/modules/a/context.md');
    });

    it('одновременные сборки считают свежесть каждого модуля один раз', async () => {
      project();
      const service = new ContextMapService(root);
      const spies = spyHistory();
      const [left, right] = await Promise.all([service.build(), service.build()]);
      expect(spies.commitsAfter).toHaveBeenCalledTimes(2);
      expect(left.modules.map((module) => module.freshness)).toEqual(right.modules.map((module) => module.freshness));
    });

    it('сбой git не запоминается: следующая сборка пробует снова', async () => {
      project();
      const service = new ContextMapService(root);
      const commitsAfter = vi.spyOn(GitHistory.prototype, 'commitsAfter').mockResolvedValueOnce(null);
      const failed = await service.build();
      expect(failed.modules.filter((module) => module.freshness === null)).toHaveLength(1);
      const retried = await service.build();
      expect(freshness(retried, 'a')).toMatchObject({ commitsAfter: 1 });
      expect(freshness(retried, 'b')).toMatchObject({ commitsAfter: 0 });
      expect(commitsAfter).toHaveBeenCalledTimes(3);
    });
  });
});
