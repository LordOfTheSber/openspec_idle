import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixturePath } from '../../../tests/fixtures.js';
import { ContextMapService, codePathExists, parseFrontmatter } from './contextMap.js';
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
    ]);
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
    ]);
  });
});
