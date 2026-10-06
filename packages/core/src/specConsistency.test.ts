import { describe, expect, it } from 'vitest';
import type { AuthoringSources } from './authoring.js';
import {
  artifactRuleIssues,
  metricRegressions,
  planTestRefIssues,
  planTestReferences,
  specCodeIssues,
} from './specConsistency.js';
import { type QualityReport, specQuality } from './specQuality.js';
import { parseQualityConfig } from './specQualityConfig.js';

function spec(capability: string, requirements: string): { capability: string; path: string; text: string } {
  return { capability, path: `openspec/specs/${capability}/spec.md`, text: `# ${capability} Specification\n\n## Purpose\nСессии.\n\n## Requirements\n\n${requirements}` };
}

describe('согласованность сценариев', () => {
  it('один WHEN в требовании с разными THEN — противоречие на втором сценарии', () => {
    const sources: AuthoringSources = {
      mainSpecs: [
        spec('sessions', `### Requirement: Продление

Кластер ДОЛЖЕН (SHALL) продлевать сессию.

#### Scenario: Продление активной

- **WHEN** клиент продлевает сессию
- **THEN** TTL сессии продлевается

#### Scenario: Продление ещё раз

- **WHEN** клиент продлевает \`сессию\`.
- **THEN** ответ — ошибка 409
`),
      ],
      changes: [],
    };
    const issues = specQuality(sources).issues.filter((issue) => issue.rule === 'scenario-conflict');
    expect(issues).toEqual([expect.objectContaining({ line: 17, level: 'warning', message: expect.stringContaining('«Продление активной»') })]);
  });

  it('один WHEN в разных спеках — сведение о пересечении, одинаковые THEN — дубль', () => {
    const scenario = (then: string): string => `### Requirement: Отказ

Кластер ДОЛЖЕН (SHALL) отвечать.

#### Scenario: Нет заголовка

- **WHEN** запрос без заголовка
- **THEN** ${then}
`;
    const overlap = specQuality({ mainSpecs: [spec('a', scenario('ответ 400')), spec('b', scenario('запрос пишется в журнал'))], changes: [] }).issues;
    expect(overlap.filter((issue) => issue.rule === 'scenario-overlap').map((issue) => [issue.path, issue.level])).toEqual([
      ['openspec/specs/a/spec.md', 'info'],
      ['openspec/specs/b/spec.md', 'info'],
    ]);
    const duplicate = specQuality({ mainSpecs: [spec('a', scenario('ответ 400')), spec('b', scenario('ответ 400'))], changes: [] }).issues;
    expect(duplicate.filter((issue) => issue.rule === 'scenario-duplicate')).toHaveLength(2);
    expect(duplicate[0]?.message ?? '').not.toBe('');
  });

  it('дельта не сравнивается с основным спеком своей capability', () => {
    const main = spec('sessions', `### Requirement: Отказ

Кластер ДОЛЖЕН (SHALL) отвечать.

#### Scenario: Нет заголовка

- **WHEN** запрос без заголовка
- **THEN** ответ 400
`);
    const delta = { capability: 'sessions', path: 'openspec/changes/x/specs/sessions/spec.md', text: `## MODIFIED Requirements\n\n${main.text.split('## Requirements\n\n')[1] ?? ''}`.replace('ответ 400', 'ответ 422') };
    const issues = specQuality({ mainSpecs: [main], changes: [{ name: 'x', deltas: [delta], plan: null }] }).issues;
    expect(issues.filter((issue) => issue.rule.startsWith('scenario-'))).toEqual([]);
  });
});

describe('порядок ошибок', () => {
  const text = (extra: string): string => `### Requirement: Создание сессии

Кластер ДОЛЖЕН (SHALL) отклонять запрос без заголовка с кодом \`HEADER_REQUIRED\` и запрос с TTL больше суток с кодом \`TTL_TOO_LONG\`.${extra}

#### Scenario: Нет заголовка

- **WHEN** запрос без заголовка
- **THEN** ответ — ошибка \`HEADER_REQUIRED\`

#### Scenario: Длинный TTL

- **WHEN** TTL 100000
- **THEN** ответ — ошибка \`TTL_TOO_LONG\`
`;

  it('два кода отказа без порядка проверок — предупреждение', () => {
    const issues = specQuality({ mainSpecs: [spec('sessions', text(''))], changes: [] }).issues.filter((issue) => issue.rule === 'error-order');
    expect(issues).toEqual([expect.objectContaining({ line: 8, message: expect.stringContaining('HEADER_REQUIRED, TTL_TOO_LONG') })]);
  });

  it('порядок задан — замечания нет', () => {
    const issues = specQuality({ mainSpecs: [spec('sessions', text(' Заголовок проверяется первым.'))], changes: [] }).issues;
    expect(issues.filter((issue) => issue.rule === 'error-order')).toEqual([]);
  });
});

describe('исполняемые правила артефактов', () => {
  const design = `# Design

## Context

Контекст.

## Decisions

### 1. Разбор в core

**Решение.** Чистые функции.

**Альтернатива — сервер.** Нельзя собрать страницу.

### 2. Отдельный файл

**Решение.** quality.yaml.
`;
  const tasks = `# Tasks

## 1. Модель

- [x] 1.1 Разбор; проверка — тесты core
- [ ] 1.2 Настройки
  ↳ spec-quality / Правило выключено
`;
  const { config } = parseQualityConfig({
    artifacts: [
      { id: 'design-alternative', artifact: 'design', each: 'section', heading: '^###\\s', require: 'альтернатив', message: 'Нет альтернативы' },
      { id: 'task-acceptance', artifact: 'tasks', each: 'item', require: 'провер', message: 'Нет проверки', level: 'error' },
      { id: 'no-todo', artifact: 'design', forbid: 'TODO', message: 'Есть TODO' },
    ],
  });
  const sources: AuthoringSources = {
    mainSpecs: [],
    changes: [
      {
        name: 'x',
        deltas: [],
        plan: null,
        artifacts: [
          { id: 'design', path: 'openspec/changes/x/design.md', text: design },
          { id: 'tasks', path: 'openspec/changes/x/tasks.md', text: tasks },
        ],
      },
    ],
    quality: config,
  };

  it('раздел без альтернативы и пункт без проверки — со строкой и уровнем правила', () => {
    expect(config.errors).toEqual([]);
    expect(artifactRuleIssues(sources).map((issue) => [issue.path, issue.line, issue.level, issue.message.split(':')[0]])).toEqual([
      ['openspec/changes/x/design.md', 15, 'warning', 'Нет альтернативы'],
      ['openspec/changes/x/tasks.md', 6, 'error', 'Нет проверки'],
    ]);
  });

  it('forbid и разделы по умолчанию: пустой раздел «## Decisions» не проверяется', () => {
    const withTodo = { ...sources, changes: [{ ...sources.changes[0]!, artifacts: [{ id: 'design', path: 'd.md', text: `${design}\nTODO: дописать\n` }] }] };
    expect(artifactRuleIssues(withTodo).filter((issue) => issue.message.startsWith('Есть TODO'))).toHaveLength(1);
    const { config: sectionsOnly } = parseQualityConfig({ artifacts: [{ id: 'r', artifact: 'design', each: 'section', require: 'Решение' }] });
    const issues = artifactRuleIssues({ ...sources, quality: sectionsOnly });
    // «## Context» без «Решение» — замечание; «## Decisions» пуст до «### 1.» и не проверяется.
    expect(issues.map((issue) => issue.line)).toEqual([3]);
  });

  it('ошибки правил — в настройках', () => {
    const { config: broken } = parseQualityConfig({ artifacts: [{ id: 'r', artifact: 'design' }, { artifact: 'tasks', each: 'line', require: '(' }] });
    expect(broken.artifactRules).toEqual([]);
    expect(broken.errors.map((error) => error.message)).toEqual([
      expect.stringContaining('нет ни «require», ни «forbid»'),
      expect.stringContaining('«require» правила артефактов не разбирается'),
      expect.stringContaining('«each» правила «artifacts[1]» — file, section или item'),
      expect.stringContaining('нет ни «require», ни «forbid»'),
    ]);
  });
});

describe('ссылки плана на тесты', () => {
  const plan = `# Tasks

- [x] 1.1 Модель; проверка — тесты \`packages/core/src/a.test.ts\` «разбор: …», «вид «Контроль» показывает объём» и e2e \`tests/e2e/b.spec.ts\`
- [x] 1.2 Без файла теста — \`packages/core/src/a.ts\` «не тест»
- [x] 1.3 Пропавший тест — \`packages/core/src/gone.test.ts\`
\`\`\`
\`packages/core/src/ignored.test.ts\` «в блоке кода»
\`\`\`
`;
  const sources: AuthoringSources = { mainSpecs: [], changes: [{ name: 'x', deltas: [], plan: { path: 'openspec/changes/x/tasks.md', text: plan } }] };

  it('находит файлы тестов и имена с вложенными кавычками', () => {
    expect(planTestReferences(sources)).toEqual([
      { path: 'openspec/changes/x/tasks.md', line: 3, file: 'packages/core/src/a.test.ts', names: ['разбор: …', 'вид «Контроль» показывает объём'] },
      { path: 'openspec/changes/x/tasks.md', line: 3, file: 'tests/e2e/b.spec.ts', names: [] },
      { path: 'openspec/changes/x/tasks.md', line: 5, file: 'packages/core/src/gone.test.ts', names: [] },
    ]);
  });

  it('нет файла, нет теста; имя с «…» — начало имени', () => {
    const files = new Map<string, string | null>([
      ['packages/core/src/a.test.ts', "it('разбор: шаги и сценарии', () => {});"],
      ['tests/e2e/b.spec.ts', 'test("x")'],
      ['packages/core/src/gone.test.ts', null],
    ]);
    const issues = planTestRefIssues(planTestReferences(sources), files);
    expect(issues.map((issue) => [issue.line, issue.message])).toEqual([
      [3, expect.stringContaining('нет теста «вид «Контроль» показывает объём»')],
      [5, expect.stringContaining('`packages/core/src/gone.test.ts`, а такого файла нет')],
    ]);
  });
});

describe('спека ↔ код модулей домена', () => {
  const sources: AuthoringSources = {
    mainSpecs: [
      spec('ui', `### Requirement: Сообщения

Панель ДОЛЖНА (SHALL) предупреждать о файле больше 8000 токенов и о доле ниже 30 % и сворачиваться при ширине меньше 640 px.

#### Scenario: Тяжёлый файл

- **WHEN** файл в 9000 токенов
- **THEN** показано «Файл тяжелее 8000 токенов» и «Контроль»
- **AND** показано «Проект не инициализирован»
`),
    ],
    changes: [],
  };
  const code = [
    {
      capability: 'ui',
      modules: ['web'],
      files: [{ path: 'packages/web/src/x.ts', text: "const HEAVY = 8_000;\nconst LOW = 0.3;\nconst message = `Файл тяжелее ${HEAVY} токенов`;" }],
    },
  ];

  it('цитата THEN без кода — предупреждение, число без литерала — сведение; одно слово не ищется', () => {
    const issues = specCodeIssues(sources, code);
    expect(issues.map((issue) => [issue.rule, issue.level, issue.line])).toEqual([
      ['code-message', 'warning', 16],
      ['code-constant', 'info', 10],
    ]);
    expect(issues[0]?.message).toContain('«Проект не инициализирован»');
    expect(issues[0]?.message).toContain('модулей web домена «ui»');
    expect(issues[1]?.message).toContain('Граница 640');
  });

  it('спеки без модулей в карте контекста не проверяются', () => {
    expect(specCodeIssues(sources, [])).toEqual([]);
  });
});

describe('регресс относительно базовой ревизии', () => {
  const report = (metrics: Partial<QualityReport['metrics']>, rules: string[]): QualityReport => ({
    issues: rules.map((rule) => ({ path: 'a.md', line: 1, level: 'warning', rule: rule as never, message: '' })),
    files: [],
    counts: { codesTraced: 0, codesTotal: 0, branchesCovered: 0, branchesTotal: 0, boundariesCovered: 0, boundariesTotal: 0, words: 0, vague: 0 },
    metrics: { errorCodeTraceability: null, branchCoverage: null, boundaryCoverage: null, ambiguityDensity: null, ...metrics },
  });

  it('метрика хуже и долг больше — сообщения с разбивкой по правилам', () => {
    const messages = metricRegressions(
      report({ boundaryCoverage: 0.25, ambiguityDensity: 0.2 }, ['vague-wording', 'vague-wording', 'boundary-values']),
      report({ boundaryCoverage: 0.5, ambiguityDensity: 0.1 }, ['vague-wording']),
      'origin/main',
    );
    expect(messages).toEqual([
      'Метрика «покрытие границ» ухудшилась относительно origin/main: 50 % → 25 %',
      'Метрика «расплывчатых слов на 100» ухудшилась относительно origin/main: 0,10 → 0,20',
      'Предупреждений и ошибок качества спеков стало больше, чем в origin/main: 1 → 3 (vague-wording +1, boundary-values +1)',
    ]);
  });

  it('без ухудшений — пусто; пустая метрика не сравнивается', () => {
    expect(metricRegressions(report({ boundaryCoverage: 0.5 }, ['vague-wording']), report({ boundaryCoverage: 0.5, branchCoverage: 1 }, ['atomicity']), 'HEAD')).toEqual([]);
  });
});
