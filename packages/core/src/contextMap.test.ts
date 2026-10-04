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

  it('домен без модулей — предупреждение; модуль без code_paths — сведение; общий контекст отсортирован', () => {
    expect(map.issues.map((issue) => issue.kind)).toEqual(['uncovered-domain', 'no-code-paths']);
    expect(map.issues[1]).toMatchObject({ module: 'sds-impl', severity: 'info' });
    expect(map.issues[0]?.domain).toBe('cm-cluster-api');
    expect(map.issues[0]?.severity).toBe('warning');
    expect(map.general).toEqual(['openspec/context/1.md', 'openspec/context/2.md']);
  });

  it('контекст модуля включает зависимости, спеки доменов и общий контекст', () => {
    expect(contextBundle(map, { modules: ['sds-master'] })).toEqual({
      modules: ['sds-master', 'sds-impl'],
      domains: ['session-lifecycle', 'session-data', 'replication', 'servant-master-api'],
      adrs: [],
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
      skippedAdrs: [],
      tokens: 0,
      usefulTokens: 0,
    });
  });

  it('набор из нескольких модулей и доменов: каждый файл один раз, модули — в порядке выбора', () => {
    const bundle = contextBundle(map, { modules: ['sds-impl', 'sds-master'], domains: ['cm-cluster-api', 'replication'] });
    expect(bundle.modules).toEqual(['sds-impl', 'sds-master']);
    expect(bundle.domains).toEqual([
      'replication',
      'servant-master-api',
      'session-lifecycle',
      'session-data',
      'cm-cluster-api',
    ]);
    expect(bundle.files).toEqual([
      'openspec/context/1.md',
      'openspec/context/2.md',
      'openspec/context/modules/sds-impl/context.md',
      'openspec/context/modules/master/context.md',
      'openspec/specs/replication/spec.md',
      'openspec/specs/servant-master-api/spec.md',
      'openspec/specs/session-lifecycle/spec.md',
      'openspec/specs/session-data/spec.md',
      'openspec/specs/cm-cluster-api/spec.md',
    ]);
  });

  it('только выбранные домены — без модулей, только общий контекст и их спеки', () => {
    expect(contextBundle(map, { domains: ['session-data', 'ghost'] })).toEqual({
      modules: [],
      domains: ['session-data'],
      adrs: [],
      files: ['openspec/context/1.md', 'openspec/context/2.md', 'openspec/specs/session-data/spec.md'],
      skippedAdrs: [],
      tokens: 0,
      usefulTokens: 0,
    });
  });

  it('без зависимостей и без доменов модулей — только выбранное', () => {
    const bundle = contextBundle(
      map,
      { modules: ['sds-master'], domains: ['replication'] },
      { dependencies: false, moduleDomains: false },
    );
    expect(bundle.modules).toEqual(['sds-master']);
    expect(bundle.files).toEqual([
      'openspec/context/1.md',
      'openspec/context/2.md',
      'openspec/context/modules/master/context.md',
      'openspec/specs/replication/spec.md',
    ]);
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
    expect(contextBundle(map, { modules: ['a'] }).modules).toEqual(['a', 'b', 'c']);
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
    expect(contextBundle(map, { modules: ['sds-master'] }).files).toContain('openspec/context/adr/ADR-001-replication.md');
  });

  it('ADR выбранного домена и выбранный ADR попадают в набор', () => {
    expect(contextBundle(map, { domains: ['replication'] }).adrs).toEqual(['openspec/context/adr/ADR-001-replication.md']);
    expect(contextBundle(map, { adrs: ['openspec/context/adr/ADR-002.md'] }).files).toEqual([
      'openspec/context/adr/ADR-002.md',
    ]);
  });
});

describe('контроль контекста', () => {
  const paragraph = 'Мастер хранит данные сессии в памяти и реплицирует их синхронно на резервный узел до ответа клиенту.';
  const texts = new Map<string, string>([
    ['openspec/context/1.md', `# Общее\n\n${paragraph}\n`],
    ['openspec/context/modules/master/context.md', `# Мастер\n\n${paragraph}\n\nКод в \`main/App.java\` и \`gone/Old.java\`.\n`],
    ['openspec/context/modules/impl/context.md', '# Контекст impl\n'],
    ['openspec/specs/replication/spec.md', 'х'.repeat(25_000)],
    ['openspec/context/adr/ADR-001.md', '---\nstatus: superseded\nmodules: [sds-master]\n---\n# ADR-001\n\nНастройки — в `old/config.json`.\n'],
    ['openspec/context/adr/ADR-002.md', '---\nstatus: accepted\nmodules: [sds-master]\n---\n# ADR-002\n'],
  ]);
  const freshness = { contextDate: '2026-09-01T10:00:00+03:00', codeDate: '2026-10-01T10:00:00+03:00', commitsAfter: 3, uncommitted: false };
  const map = buildContextMap({
    domains: ['replication'],
    general: ['openspec/context/1.md'],
    adrs: [
      { ...adr('openspec/context/adr/ADR-001.md', { status: 'superseded', modules: ['sds-master'] }) },
      { ...adr('openspec/context/adr/ADR-002.md', { status: 'accepted', modules: ['sds-master'] }) },
    ],
    modules: [
      module(
        'master',
        { module: 'sds-master', domains: ['replication'], code_paths: ['svc/src'], max_tokens: 100 },
        { existingCodePaths: new Set(['svc/src']), freshness, lineOf: (key) => (key === 'max_tokens' ? 7 : (LINES[key] ?? null)) },
      ),
      module('impl', { module: 'impl', code_paths: ['impl/src'], max_tokens: 'много' }, { existingCodePaths: new Set(['impl/src']) }),
    ],
    texts,
    existingPaths: new Set(['svc/src/main/App.java']),
    unusedFiles: ['openspec/context/modules/master/notes.md'],
  });
  const issue = (kind: string) => map.issues.filter((item) => item.kind === kind);

  it('объём каждого файла и сумма; тяжёлый файл — предупреждение', () => {
    expect(map.files.map((file) => [file.path, file.kind])).toEqual([
      ['openspec/context/1.md', 'general'],
      ['openspec/context/modules/impl/context.md', 'module'],
      ['openspec/context/modules/master/context.md', 'module'],
      ['openspec/specs/replication/spec.md', 'spec'],
      ['openspec/context/adr/ADR-001.md', 'adr'],
      ['openspec/context/adr/ADR-002.md', 'adr'],
    ]);
    expect(map.totalTokens).toBe(map.files.reduce((sum, file) => sum + file.tokens, 0));
    expect(issue('large-file')).toEqual([
      expect.objectContaining({ path: 'openspec/specs/replication/spec.md', severity: 'warning', domain: 'replication' }),
    ]);
  });

  it('бюджет набора модуля: превышение — предупреждение на строке max_tokens, не число — ошибка', () => {
    const master = map.modules.find((item) => item.id === 'sds-master');
    expect(master?.maxTokens).toBe(100);
    expect(master?.bundleTokens).toBe(contextBundle(map, { modules: ['sds-master'] }).tokens);
    expect(issue('over-budget')).toEqual([expect.objectContaining({ module: 'sds-master', line: 7, severity: 'warning' })]);
    expect(issue('bad-field')).toEqual([expect.objectContaining({ module: 'impl', path: 'openspec/context/modules/impl/index.md' })]);
  });

  it('лишнее: повтор абзаца, пустой контекст, файл вне наборов', () => {
    expect(issue('duplicate-text')).toEqual([
      expect.objectContaining({ path: 'openspec/context/modules/master/context.md', line: 3, module: 'sds-master' }),
    ]);
    expect(issue('duplicate-text')[0]?.message).toContain('openspec/context/1.md:3');
    expect(map.duplicates).toHaveLength(1);
    expect(issue('empty-context')).toEqual([expect.objectContaining({ module: 'impl' })]);
    expect(issue('unused-file').map((item) => item.path)).toEqual(['openspec/context/modules/master/notes.md']);
  });

  it('связь с реальностью: путь от кода модуля найден, пропавший — предупреждение, в недействующем ADR — не проверяется; отставание — сведение', () => {
    expect(map.references.map((ref) => [ref.target, ref.resolved])).toEqual([
      ['main/App.java', true],
      ['gone/Old.java', false],
    ]);
    expect(issue('broken-reference')).toEqual([
      expect.objectContaining({ path: 'openspec/context/modules/master/context.md', line: 5, severity: 'warning' }),
    ]);
    expect(issue('stale-context')).toEqual([expect.objectContaining({ module: 'sds-master', severity: 'info' })]);
    expect(issue('stale-context')[0]?.message).toContain('3 коммита');
    expect(map.modules.find((item) => item.id === 'sds-master')?.freshness).toEqual(freshness);
  });

  it('недействующий ADR вне набора по умолчанию, с флажком или явным выбором — в наборе', () => {
    expect(map.adrs.map((item) => [item.id, item.active])).toEqual([
      ['ADR-001', false],
      ['ADR-002', true],
    ]);
    const bundle = contextBundle(map, { modules: ['sds-master'] });
    expect(bundle.adrs).toEqual(['openspec/context/adr/ADR-002.md']);
    expect(bundle.skippedAdrs).toEqual(['openspec/context/adr/ADR-001.md']);
    expect(contextBundle(map, { modules: ['sds-master'] }, { inactiveAdrs: true }).adrs).toHaveLength(2);
    expect(contextBundle(map, { adrs: ['openspec/context/adr/ADR-001.md'] }).adrs).toEqual(['openspec/context/adr/ADR-001.md']);
  });

  it('полезность: повтор и битый путь — балласт, привязка и свежесть — у context.md, сумма по набору', () => {
    const master = map.files.find((file) => file.path === 'openspec/context/modules/master/context.md')?.usefulness;
    expect(master?.ballast.duplicate).toBeGreaterThan(0);
    expect(master?.ballast.broken).toBeGreaterThan(0);
    expect(master?.grounding).toBe(0);
    expect(master?.freshness).toBeCloseTo(1 / 1.3);
    expect(map.files.find((file) => file.path === 'openspec/context/1.md')?.usefulness.score).toBe(1);
    expect(map.files.find((file) => file.path === 'openspec/context/modules/impl/context.md')?.usefulness.score).toBe(0);
    expect(map.usefulTokens).toBe(map.files.reduce((sum, file) => sum + file.usefulness.usefulTokens, 0));
    const bundle = contextBundle(map, { modules: ['sds-master'] });
    expect(bundle.usefulTokens).toBeLessThan(bundle.tokens);
    expect(map.modules.find((item) => item.id === 'sds-master')?.bundleUsefulTokens).toBe(bundle.usefulTokens);
    // Файлы легче порога сведением не отмечаются, пустой контекст — уже предупреждение.
    expect(issue('low-usefulness')).toEqual([]);
  });

  it('низкая полезность заметного файла — сведение с причинами', () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Абзац ${index + 1}: модуль принимает запросы балансировщика и отдаёт данные сессии другим узлам кластера.`);
    const text = ['# Мастер', '', '<!-- Опишите назначение модуля, его границы и ключевые классы. Укажите пути к коду. -->', '', ...paragraphs.flatMap((item) => [item, '', `TODO: ${item}`, ''])].join('\n');
    const low = buildContextMap({
      domains: [],
      general: [],
      adrs: [],
      modules: [module('master', { module: 'sds-master', code_paths: ['svc/src'] }, { existingCodePaths: new Set(['svc/src']), freshness })],
      texts: new Map([['openspec/context/modules/master/context.md', text]]),
      existingPaths: new Set(),
    });
    const found = low.issues.filter((item) => item.kind === 'low-usefulness');
    expect(found).toEqual([
      expect.objectContaining({ path: 'openspec/context/modules/master/context.md', line: null, severity: 'info', module: 'sds-master' }),
    ]);
    expect(found[0]?.message).toContain('заготовки ≈');
    expect(found[0]?.message).toContain('привязка к коду 0 %');
    expect(found[0]?.message).toContain('множитель 0,77');
  });

  it('без текстов и путей контроль молчит', () => {
    const plain = buildContextMap({ domains: [], general: [], adrs: [], modules: [module('m', { code_paths: ['x'] }, { existingCodePaths: new Set(['x']) })] });
    expect(plain.files).toEqual([]);
    expect(plain.references).toEqual([]);
    expect(plain.issues).toEqual([]);
  });
});
