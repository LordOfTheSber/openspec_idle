import { describe, expect, it } from 'vitest';
import type { AuthoringSources } from './authoring.js';
import { qualityOverview } from './qualityOverview.js';
import { specCodeIssues } from './specConsistency.js';
import { DEFAULT_QUALITY_CONFIG, type QualityConfig, pathMatches, specQuality } from './specQuality.js';
import { parseQualityConfig } from './specQualityConfig.js';

function spec(capability: string, body: string): { capability: string; path: string; text: string } {
  return { capability, path: `openspec/specs/${capability}/spec.md`, text: `# ${capability} Specification\n\n## Purpose\nСессии.\n\n## Requirements\n\n${body}` };
}

const VAGUE = `### Requirement: Создание

Система ДОЛЖНА (SHALL) принимать валидный запрос.

#### Scenario: Запрос

- **WHEN** приходит запрос
- **THEN** ответ содержит \`id\`

### Requirement: Удаление

Система ДОЛЖНА (SHALL) удалять корректный объект.

#### Scenario: Удаление

- **WHEN** объект удаляют
- **THEN** ответ 204
`;

function sources(config: Partial<QualityConfig> = {}): AuthoringSources {
  return {
    mainSpecs: [spec('sessions', VAGUE), spec('legacy', VAGUE)],
    changes: [{ name: 'add-x', deltas: [], plan: null }],
    quality: { ...DEFAULT_QUALITY_CONFIG, path: 'openspec/quality.yaml', ...config },
  };
}

describe('исключения правил', () => {
  it('шаблон пути: точный путь, каталог, * и **', () => {
    expect(pathMatches('openspec/specs/legacy/spec.md', 'openspec/specs/legacy/spec.md')).toBe(true);
    expect(pathMatches('openspec/specs/legacy', 'openspec/specs/legacy/spec.md')).toBe(true);
    expect(pathMatches('openspec/specs/legacy', 'openspec/specs/legacy-2/spec.md')).toBe(false);
    expect(pathMatches('openspec/specs/*/spec.md', 'openspec/specs/a/spec.md')).toBe(true);
    expect(pathMatches('openspec/specs/*/spec.md', 'openspec/specs/a/b/spec.md')).toBe(false);
    expect(pathMatches('openspec/**/spec.md', 'openspec/changes/x/specs/a/spec.md')).toBe(true);
    expect(pathMatches(null, 'любой')).toBe(true);
  });

  it('правило в требовании, правило в файле — замечание снимается и запоминает исключение', () => {
    const { config } = parseQualityConfig(
      {
        exclude: [
          { rule: 'vague-wording', path: 'openspec/specs/sessions/spec.md', requirement: 'Создание', reason: 'формулировка из договора' },
          { rule: 'vague-wording', path: 'openspec/specs/legacy' },
        ],
      },
      (path) => (path.join('.') === 'exclude.0' ? 4 : null),
    );
    expect(config.errors).toEqual([]);
    expect(config.exclusions[0]).toEqual({ rule: 'vague-wording', path: 'openspec/specs/sessions/spec.md', requirement: 'Создание', reason: 'формулировка из договора', line: 4 });
    const report = specQuality(sources(config));
    const vague = report.issues.filter((issue) => issue.rule === 'vague-wording');
    expect(vague.map((issue) => [issue.path, issue.requirement])).toEqual([['openspec/specs/sessions/spec.md', 'Удаление']]);
    expect(report.excluded.map((issue) => [issue.path, issue.requirement, issue.exclusion])).toEqual([
      ['openspec/specs/sessions/spec.md', 'Создание', 0],
      ['openspec/specs/legacy/spec.md', 'Создание', 1],
      ['openspec/specs/legacy/spec.md', 'Удаление', 1],
    ]);
  });

  it('файл, исключённый целиком, не входит в метрики; ошибки настроек не исключаются', () => {
    const { config } = parseQualityConfig({ exclude: [{ path: 'openspec/specs/legacy/**' }, { path: 'openspec/quality.yaml' }], rules: { nope: 'warning' } });
    const report = specQuality(sources(config));
    expect(report.files.find((file) => file.path.includes('legacy'))?.excluded).toBe(true);
    expect(report.counts.vague).toBe(2);
    expect(report.issues.some((issue) => issue.path.includes('legacy'))).toBe(false);
    expect(report.issues.filter((issue) => issue.rule === 'config')).toHaveLength(1);
  });

  it('ошибки исключений: неизвестное правило, пустое исключение, лишний ключ', () => {
    const { config } = parseQualityConfig({ exclude: [{ rule: 'nope' }, { reason: 'просто так' }, { rule: 'atomicity', file: 'x' }] });
    expect(config.exclusions).toEqual([{ rule: 'atomicity', path: null, requirement: null, reason: null, line: null }]);
    expect(config.errors.map((error) => error.message)).toEqual([
      expect.stringContaining('неизвестное правило исключения «nope»'),
      expect.stringContaining('не задаёт ни rule, ни path, ни requirement'),
      expect.stringContaining('неизвестный ключ исключения «file»'),
    ]);
  });
});

describe('сводка раздела «Качество»', () => {
  it('правила с уровнями и счётчиками, файлы, changes, пороги и исключённые', () => {
    const { config } = parseQualityConfig(
      {
        rules: { atomicity: 'off', 'vague-wording': 'error' },
        exclude: [{ rule: 'plan-test-ref', path: 'openspec/changes/add-x/tasks.md' }],
        thresholds: { ambiguityDensity: 1 },
      },
      (path) => (path.join('.') === 'thresholds.ambiguityDensity' ? 9 : null),
    );
    const all = sources(config);
    const project = [
      { path: 'openspec/changes/add-x/tasks.md', line: 5, level: 'warning' as const, rule: 'plan-test-ref' as const, message: 'нет теста' },
      { path: 'openspec/changes/add-x/design.md', line: 3, level: 'warning' as const, rule: 'artifact-rule' as const, message: 'нет альтернативы' },
    ];
    const overview = qualityOverview(all, specQuality(all), project);

    const vague = overview.rules.find((rule) => rule.id === 'vague-wording');
    expect(vague).toMatchObject({ level: 'error', configured: true, defaultLevel: 'warning', counts: { error: 4, warning: 0, info: 0 }, group: 'requirement' });
    expect(overview.rules.find((rule) => rule.id === 'atomicity')).toMatchObject({ level: 'off', configured: true });
    expect(overview.rules.find((rule) => rule.id === 'plan-test-ref')).toMatchObject({ excluded: 1, counts: { warning: 0 } });
    // Четыре расплывчатых слова — ошибки по настройке, пятая ошибка — невыполненный порог.
    expect(overview.totals).toMatchObject({ error: 5, warning: 1, excluded: 1 });

    expect(overview.files.map((file) => [file.path, file.kind, file.counts.error])).toEqual([
      ['openspec/specs/legacy/spec.md', 'spec', 2],
      ['openspec/specs/sessions/spec.md', 'spec', 2],
      ['openspec/quality.yaml', 'config', 1],
      ['openspec/changes/add-x/design.md', 'artifact', 0],
      ['openspec/changes/add-x/tasks.md', 'artifact', 0],
    ]);
    expect(overview.files.find((file) => file.path.endsWith('tasks.md'))).toMatchObject({ excluded: 1, change: 'add-x' });
    expect(overview.changes).toEqual([{ name: 'add-x', error: 0, warning: 1, info: 0 }]);
    expect(overview.thresholdFailures).toEqual([{ metric: 'ambiguityDensity', value: expect.any(Number), threshold: 1, line: 9 }]);
    expect(overview.config).toMatchObject({ exists: true, path: 'openspec/quality.yaml', scope: 'all' });
    expect(overview.documents).toEqual({ mainSpecs: 2, changes: 0, deltas: 0 });
  });

  it('без настроек — умолчания и признак, что файла нет', () => {
    const overview = qualityOverview({ mainSpecs: [], changes: [] }, specQuality({ mainSpecs: [], changes: [] }));
    expect(overview.config).toMatchObject({ exists: false, path: 'openspec/quality.yaml' });
    expect(overview.rules.every((rule) => rule.level === rule.defaultLevel && !rule.configured)).toBe(true);
  });
});

describe('цитата нашлась в другом модуле', () => {
  it('сообщение называет файл и модуль, где цитата есть', () => {
    const all: AuthoringSources = {
      mainSpecs: [
        spec('runtime', `### Requirement: Корень

Система ДОЛЖНА (SHALL) находить корень.

#### Scenario: Нет корня

- **WHEN** каталога нет
- **THEN** показано «Проект не инициализирован»
`),
      ],
      changes: [],
    };
    const issues = specCodeIssues(
      all,
      [{ capability: 'runtime', modules: ['server'], files: [{ path: 'packages/server/a.ts', text: 'const x = 1;', module: 'server' }] }],
      [
        { path: 'packages/server/a.ts', text: 'const x = 1;', module: 'server' },
        { path: 'packages/vscode/tree.ts', text: "label('Проект не инициализирован')", module: 'vscode' },
      ],
    );
    expect(issues).toEqual([
      expect.objectContaining({
        rule: 'code-message',
        requirement: 'Корень',
        message: expect.stringContaining('есть в `packages/vscode/tree.ts` модуля vscode: добавьте домен «runtime» в domains модуля vscode'),
      }),
    ]);
  });
});
