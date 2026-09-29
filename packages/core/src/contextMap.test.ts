import { describe, expect, it } from 'vitest';
import {
  type AdrSource,
  type ModuleSource,
  buildContextMap,
  contextBundle,
  firstHeading,
  normalizeDomain,
  splitFrontmatter,
} from './contextMap.js';

const LINES: Record<string, number> = { module: 2, description: 3, domains: 4, code_paths: 5, depends_on: 6 };

function module(folder: string, frontmatter: unknown, overrides: Partial<ModuleSource> = {}): ModuleSource {
  return {
    folder,
    hasIndex: true,
    hasContext: true,
    frontmatter,
    frontmatterError: null,
    lineOf: (key) => LINES[key] ?? null,
    existingCodePaths: new Set(),
    ...overrides,
  };
}

function adr(path: string, frontmatter: unknown, heading: string | null = null): AdrSource {
  return { path, frontmatter, frontmatterError: null, lineOf: (key) => (key === 'modules' ? 3 : 4), heading };
}

const DOMAINS = ['session-lifecycle', 'session-data', 'replication', 'servant-master-api', 'cm-cluster-api'];

describe('frontmatter', () => {
  it('отделяет YAML от тела', () => {
    const parsed = splitFrontmatter('---\nmodule: sds-master\ndomains: [a]\n---\n# Мастер\nТекст');
    expect(parsed.yaml).toBe('module: sds-master\ndomains: [a]');
    expect(parsed.firstLine).toBe(2);
    expect(parsed.body).toBe('# Мастер\nТекст');
    expect(firstHeading(parsed.body)).toBe('Мастер');
  });

  it('без открывающей или закрывающей черты frontmatter нет', () => {
    expect(splitFrontmatter('# Заголовок\n---\n').yaml).toBeNull();
    expect(splitFrontmatter('---\nmodule: x\n').yaml).toBeNull();
    expect(splitFrontmatter('﻿---\r\nmodule: x\r\n---\r\n').yaml).toBe('module: x');
  });

  it('путь домена приводится к имени папки в openspec/specs', () => {
    expect(normalizeDomain('session-data')).toBe('session-data');
    expect(normalizeDomain('openspec/specs/identity/auth/spec.md')).toBe('identity/auth');
    expect(normalizeDomain('specs/replication/')).toBe('replication');
  });
});

describe('карта контекста: модули и домены', () => {
  const map = buildContextMap({
    domains: DOMAINS,
    general: ['openspec/context/2.md', 'openspec/context/1.md'],
    adrs: [],
    modules: [
      module('master', {
        module: 'sds-master',
        description: 'Хранение данных сессии in-memory',
        domains: ['session-lifecycle', 'session-data', 'replication'],
        code_paths: ['sds-master/src'],
        depends_on: ['sds-impl'],
      }, { existingCodePaths: new Set(['sds-master/src']) }),
      module('sds-impl', {
        domains: ['replication', 'servant-master-api'],
      }),
    ],
  });

  it('связь многие-ко-многим: у модуля несколько доменов, домен у нескольких модулей', () => {
    expect(map.modules.map((item) => item.id)).toEqual(['sds-master', 'sds-impl']);
    expect(map.modules[0]?.domains).toEqual(['session-lifecycle', 'session-data', 'replication']);
    expect(map.domains.find((domain) => domain.id === 'replication')?.modules).toEqual(['sds-impl', 'sds-master']);
    expect(map.links).toHaveLength(5);
    expect(map.links.every((link) => link.resolved)).toBe(true);
  });

  it('идентификатор — из поля module, иначе имя папки; пути файлов модуля', () => {
    const master = map.modules[0];
    expect(master?.folder).toBe('master');
    expect(master?.indexPath).toBe('openspec/context/modules/master/index.md');
    expect(master?.contextPath).toBe('openspec/context/modules/master/context.md');
    expect(map.modules[1]?.id).toBe('sds-impl');
  });

  it('зависимости модулей и обратные ссылки', () => {
    expect(map.dependencies).toEqual([{ from: 'sds-master', to: 'sds-impl', resolved: true, cyclic: false }]);
    expect(map.modules[1]?.dependents).toEqual(['sds-master']);
  });

  it('домен без модулей — предупреждение; общий контекст отсортирован', () => {
    expect(map.issues.map((issue) => issue.kind)).toEqual(['uncovered-domain']);
    expect(map.issues[0]?.domain).toBe('cm-cluster-api');
    expect(map.issues[0]?.severity).toBe('warning');
    expect(map.general).toEqual(['openspec/context/1.md', 'openspec/context/2.md']);
  });

  it('контекст модуля включает зависимости, спеки доменов и общий контекст', () => {
    expect(contextBundle(map, 'sds-master')).toEqual({
      modules: ['sds-master', 'sds-impl'],
      files: [
        'openspec/context/1.md',
        'openspec/context/2.md',
        'openspec/context/modules/master/context.md',
        'openspec/context/modules/sds-impl/context.md',
        'openspec/specs/session-lifecycle/spec.md',
        'openspec/specs/session-data/spec.md',
        'openspec/specs/replication/spec.md',
        'openspec/specs/servant-master-api/spec.md',
      ],
    });
  });
});

describe('карта контекста: замечания', () => {
  it('неизвестный домен — ошибка на строке domains, домен виден на карте без спеки', () => {
    const map = buildContextMap({
      domains: DOMAINS,
      general: [],
      adrs: [],
      modules: [module('master', { module: 'sds-master', domains: ['session-data', 'sesion-lifecycle'] })],
    });
    const issue = map.issues.find((item) => item.kind === 'unknown-domain');
    expect(issue).toMatchObject({ path: 'openspec/context/modules/master/index.md', line: 4, domain: 'sesion-lifecycle' });
    expect(map.domains.find((domain) => domain.id === 'sesion-lifecycle')?.specPath).toBeNull();
    expect(map.links.find((link) => link.domain === 'sesion-lifecycle')?.resolved).toBe(false);
  });

  it('неописанный модуль в depends_on, зависимость от себя и цикл', () => {
    const map = buildContextMap({
      domains: [],
      general: [],
      adrs: [],
      modules: [
        module('a', { depends_on: ['b', 'router', 'a'] }),
        module('b', { depends_on: ['c'] }),
        module('c', { depends_on: 'a' }),
      ],
    });
    const kinds = map.issues.map((issue) => issue.kind);
    expect(kinds).toContain('unknown-module');
    expect(kinds).toContain('self-dependency');
    expect(map.issues.filter((issue) => issue.kind === 'dependency-cycle').map((issue) => issue.module)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(map.dependencies.find((edge) => edge.to === 'router')).toEqual({
      from: 'a',
      to: 'router',
      resolved: false,
      cyclic: false,
    });
    // Цикл не мешает собрать контекст: каждый модуль берётся один раз.
    expect(contextBundle(map, 'a').modules).toEqual(['a', 'b', 'c']);
  });

  it('нет index.md, нет frontmatter, ошибка YAML, нет context.md, неверное поле, дубль модуля', () => {
    const map = buildContextMap({
      domains: [],
      general: [],
      adrs: [],
      modules: [
        module('no-index', null, { hasIndex: false }),
        module('no-meta', null),
        module('broken', null, { frontmatterError: { message: 'bad indentation', line: 3 } }),
        module('no-context', { module: 'x' }, { hasContext: false }),
        module('bad-field', { module: 'y', domains: { a: 1 } }),
        module('z-dup', { module: 'x' }),
      ],
    });
    const kinds = map.issues.map((issue) => `${issue.kind}:${issue.module ?? ''}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'missing-index:no-index',
        'bad-frontmatter:no-meta',
        'bad-frontmatter:broken',
        'missing-context:x',
        'bad-field:y',
        'duplicate-module:x',
      ]),
    );
    expect(map.issues.find((issue) => issue.kind === 'bad-frontmatter' && issue.module === 'broken')?.line).toBe(3);
  });

  it('отсутствующий путь кода — предупреждение', () => {
    const map = buildContextMap({
      domains: [],
      general: [],
      adrs: [],
      modules: [module('m', { code_paths: ['src/a', 'src/b'] }, { existingCodePaths: new Set(['src/a']) })],
    });
    expect(map.modules[0]?.codePaths).toEqual([
      { path: 'src/a', exists: true },
      { path: 'src/b', exists: false },
    ]);
    expect(map.issues).toEqual([expect.objectContaining({ kind: 'missing-code-path', severity: 'warning', line: 5 })]);
  });

  it('без модулей и ADR контекст не заведён и замечаний о доменах нет', () => {
    const map = buildContextMap({ domains: DOMAINS, general: [], adrs: [], modules: [] });
    expect(map.configured).toBe(false);
    expect(map.issues).toEqual([]);
    expect(map.domains).toHaveLength(DOMAINS.length);
  });
});

describe('карта контекста: ADR', () => {
  const map = buildContextMap({
    domains: DOMAINS,
    general: [],
    modules: [module('master', { module: 'sds-master', domains: ['replication'] })],
    adrs: [
      adr(
        'openspec/context/adr/ADR-001-replication.md',
        { title: 'Синхронная репликация', status: 'accepted', modules: ['sds-master', 'ghost'], domains: ['replication'] },
      ),
      adr('openspec/context/adr/ADR-002.md', null, 'Хранение in-memory'),
    ],
  });

  it('ADR связан с модулями и доменами; заголовок из поля title или из тела', () => {
    expect(map.adrs.map((item) => [item.id, item.title, item.status])).toEqual([
      ['ADR-001-replication', 'Синхронная репликация', 'accepted'],
      ['ADR-002', 'Хранение in-memory', null],
    ]);
    expect(map.modules[0]?.adrs).toEqual(['openspec/context/adr/ADR-001-replication.md']);
    expect(map.domains.find((domain) => domain.id === 'replication')?.adrs).toEqual([
      'openspec/context/adr/ADR-001-replication.md',
    ]);
  });

  it('ссылка ADR на неописанный модуль — ошибка на строке modules', () => {
    expect(map.issues.find((issue) => issue.kind === 'unknown-module')).toMatchObject({
      path: 'openspec/context/adr/ADR-001-replication.md',
      line: 3,
    });
    expect(map.adrLinks.find((link) => link.target === 'ghost')?.resolved).toBe(false);
  });

  it('ADR модуля попадает в его контекст', () => {
    expect(contextBundle(map, 'sds-master').files).toContain('openspec/context/adr/ADR-001-replication.md');
  });
});
