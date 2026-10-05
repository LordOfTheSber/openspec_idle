import { describe, expect, it } from 'vitest';
import type { AuthoringSources } from './authoring.js';
import { DEFAULT_QUALITY_CONFIG, type QualityConfig, type QualityRule, specQuality, wordsMatch } from './specQuality.js';
import { parseQualityConfig, registryCodes } from './specQualityConfig.js';

const SPEC = 'openspec/specs/sessions/spec.md';

function sources(text: string, config: Partial<QualityConfig> = {}): AuthoringSources {
  return {
    mainSpecs: [{ capability: 'sessions', path: SPEC, text }],
    changes: [],
    quality: { ...DEFAULT_QUALITY_CONFIG, path: 'openspec/quality.yaml', ...config },
  };
}

function spec(requirements: string, purpose = 'Сессии клиентов.'): string {
  return `# sessions Specification\n\n## Purpose\n${purpose}\n\n## Requirements\n\n${requirements}`;
}

function rules(text: string, config: Partial<QualityConfig> = {}): QualityRule[] {
  return specQuality(sources(text, config)).issues.map((issue) => issue.rule as QualityRule);
}

function issuesOf(text: string, rule: QualityRule, config: Partial<QualityConfig> = {}) {
  return specQuality(sources(text, config)).issues.filter((issue) => issue.rule === rule);
}

describe('качество спеков: сравнение слов', () => {
  it('совпадают формы одного слова и слово с приставкой', () => {
    expect(wordsMatch('кэш', 'кэша')).toBe(true);
    expect(wordsMatch('сессия', 'сессии')).toBe(true);
    expect(wordsMatch('создание', 'создается')).toBe(true);
    expect(wordsMatch('формулировки', 'переформулировка')).toBe(true);
    expect(wordsMatch('запрос', 'запись')).toBe(false);
    expect(wordsMatch('конфигурация', 'конфликт')).toBe(false);
  });
});

describe('качество спеков: R1 трассируемость кодов ошибок', () => {
  it('код из THEN без правила в тексте и код из текста без сценария', () => {
    const text = spec(`### Requirement: Создание сессии

Кластер ДОЛЖЕН (SHALL) создавать сессию. Если в запросе нет \`externalSessionId\`, кластер ДОЛЖЕН вернуть ошибку \`SESSION_CREATION_WITHOUT_EXTERNAL_SESSION_ID\`.

#### Scenario: Сессия без внешнего идентификатора

- **WHEN** запрос без \`externalSessionId\`
- **THEN** ответ содержит ошибку \`SESSION_EXTERNAL_ID_REQUIRED\`
`);
    const issues = issuesOf(text, 'error-code-trace');
    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('SESSION_CREATION_WITHOUT_EXTERNAL_SESSION_ID назван в тексте'),
      expect.stringContaining('SESSION_EXTERNAL_ID_REQUIRED есть в THEN'),
    ]);
    expect(issues[0]?.line).toBe(10);
    expect(issues[1]?.line).toBe(15);
    expect(specQuality(sources(text)).metrics.errorCodeTraceability).toBe(0);
  });

  it('код и в тексте, и в THEN — трассируем; входное значение WHEN кодом ошибки не считается', () => {
    const text = spec(`### Requirement: Режим TTL

Кластер ДОЛЖЕН (SHALL) принимать режим \`SESSION_ENTIRE_TTL\` и отклонять запрос без режима с кодом \`TTL_MODE_REQUIRED\`.

#### Scenario: Режим целиком

- **WHEN** запрос с режимом \`SESSION_ENTIRE_TTL\`
- **THEN** ответ содержит \`sessionId\`

#### Scenario: Без режима

- **WHEN** запрос без режима
- **THEN** ответ — ошибка \`TTL_MODE_REQUIRED\`
`);
    expect(issuesOf(text, 'error-code-trace')).toEqual([]);
    expect(specQuality(sources(text)).metrics.errorCodeTraceability).toBe(1);
  });

  it('имя переменной в предложении не об ошибках — не код ошибки', () => {
    const text = spec(`### Requirement: Поиск CLI

Система ДОЛЖНА (SHALL) брать путь из переменной \`OPENSPEC_CLI\`.

#### Scenario: Путь из переменной

- **WHEN** переменная задана
- **THEN** CLI запускается по этому пути
`);
    expect(issuesOf(text, 'error-code-trace')).toEqual([]);
    expect(specQuality(sources(text)).metrics.errorCodeTraceability).toBeNull();
  });
});

describe('качество спеков: R2 покрытие ветвлений', () => {
  it('условие без сценария — сведение, условие со сценарием — покрыто', () => {
    const text = spec(`### Requirement: Продление сессии

Кластер ДОЛЖЕН (SHALL) продлевать сессию. Если сессия истекла, кластер ДОЛЖЕН создать новую. Если клиент заблокирован, кластер ДОЛЖЕН отказать.

#### Scenario: Сессия истекла

- **WHEN** клиент продлевает сессию, которая истекла
- **THEN** ответ содержит новый \`sessionId\`
`);
    const issues = issuesOf(text, 'branch-coverage');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('info');
    expect(issues[0]?.message).toContain('клиент заблокирован');
    expect(specQuality(sources(text)).metrics.branchCoverage).toBe(0.5);
  });
});

describe('качество спеков: R3 покрытие перечислений', () => {
  it('элемент перечисления, которого нет ни в одном сценарии', () => {
    const text = spec(`### Requirement: Режимы TTL

Кластер ДОЛЖЕН (SHALL) поддерживать как \`SESSION_SLIDING_TTL\`, так и \`SESSION_ENTIRE_TTL\`.

#### Scenario: Скользящий TTL

- **WHEN** запрос с режимом \`SESSION_SLIDING_TTL\`
- **THEN** TTL продлевается при каждом обращении
`);
    const issues = issuesOf(text, 'enumeration-coverage');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('`SESSION_ENTIRE_TTL`');
    expect(issues[0]?.message).not.toContain('SESSION_SLIDING_TTL');
  });

  it('пути и фразы в коде — не значения перечисления', () => {
    const text = spec(`### Requirement: Файлы

Система ДОЛЖНА (SHALL) читать \`openspec/config.yaml\` и \`openspec list --json\`.

#### Scenario: Чтение

- **WHEN** проект открыт
- **THEN** настройки прочитаны
`);
    expect(issuesOf(text, 'enumeration-coverage')).toEqual([]);
  });
});

describe('качество спеков: R4 граничные значения', () => {
  const text = spec(`### Requirement: TTL сессии

Кластер ДОЛЖЕН (SHALL) приводить TTL запроса к интервалу [\`minTtl\`, \`maxTtl\`].

#### Scenario: TTL меньше минимума

- **WHEN** \`minTtl\` = 60, \`maxTtl\` = 3600 и запрос с TTL 10
- **THEN** сессия создаётся с TTL 60

#### Scenario: TTL больше максимума

- **WHEN** \`minTtl\` = 60, \`maxTtl\` = 3600 и запрос с TTL 7200
- **THEN** сессия создаётся с TTL 3600
`);

  it('нет сценариев на значения, равные границам', () => {
    const issues = issuesOf(text, 'boundary-values');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('= minTtl, = maxTtl');
    expect(issues[0]?.message).not.toContain('< minTtl');
    expect(specQuality(sources(text)).metrics.boundaryCoverage).toBe(0.5);
  });

  it('сценарий на равенство размера лимиту закрывает порог «не более»', () => {
    const limit = spec(`### Requirement: Лимит кэша

Кластер ДОЛЖЕН (SHALL) хранить не более \`maxCacheSize\` сессий и отклонять создание сверх лимита с кодом \`CACHE_LIMIT_EXCEEDED\`.

#### Scenario: Лимит превышен

- **WHEN** число сессий больше \`maxCacheSize\`
- **THEN** ответ — ошибка \`CACHE_LIMIT_EXCEEDED\`
`);
    expect(issuesOf(limit, 'boundary-values').map((issue) => issue.message)).toEqual([
      expect.stringContaining('нет сценариев на значения = maxCacheSize'),
    ]);
    const fixed = limit.replace(
      '#### Scenario: Лимит превышен',
      '#### Scenario: Размер равен лимиту\n\n- **WHEN** число сессий равно `maxCacheSize`\n- **THEN** ответ содержит `sessionId`\n\n#### Scenario: Лимит превышен',
    );
    expect(issuesOf(fixed, 'boundary-values')).toEqual([]);
  });
});

describe('качество спеков: R5 арифметика clamp', () => {
  it('ожидание THEN не совпадает с clamp(x, min, max)', () => {
    const text = spec(`### Requirement: TTL сессии

Кластер ДОЛЖЕН (SHALL) приводить TTL запроса к интервалу [60, 3600].

#### Scenario: TTL больше максимума

- **WHEN** запрос с TTL 7200
- **THEN** сессия создаётся с TTL 7200

#### Scenario: TTL меньше минимума

- **WHEN** запрос с TTL 10
- **THEN** сессия создаётся с TTL 60
`);
    const issues = issuesOf(text, 'clamp-arithmetic');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('должно стать 3600, а THEN ожидает 7200');
    expect(issues[0]?.line).toBe(15);
  });

  it('границы берутся из параметров настроек', () => {
    const text = spec(`### Requirement: TTL сессии

Кластер ДОЛЖЕН (SHALL) приводить TTL запроса к интервалу [\`minTtl\`, \`maxTtl\`].

#### Scenario: TTL меньше минимума

- **WHEN** запрос с TTL 10
- **THEN** сессия создаётся с TTL 30
`);
    expect(issuesOf(text, 'clamp-arithmetic', { parameters: { minTtl: 60, maxTtl: 3600 } })[0]?.message).toContain('должно стать 60');
  });
});

describe('качество спеков: R6 утечка реализации', () => {
  it('вызов метода и внутреннее имя в THEN', () => {
    const text = spec(`### Requirement: Учёт сессий

Кластер ДОЛЖЕН (SHALL) учитывать созданные сессии.

#### Scenario: Сессия учтена

- **WHEN** клиент создаёт сессию
- **THEN** sessionCache.getCacheSize() возвращает 1
- **AND** ответ содержит scenario(s) и HTTP(S)-адрес
`);
    const issues = issuesOf(text, 'implementation-leak');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('«sessionCache.getCacheSize()»');
  });
});

describe('качество спеков: R7 реестр параметров', () => {
  const text = `# sessions Specification

## Purpose
Сессии клиентов.

## Configuration

- \`minTtl\` — минимальный TTL, с.

## Requirements

### Requirement: TTL сессии

Кластер ДОЛЖЕН (SHALL) держать TTL в пределах \`minTtl\` и \`maxTtl\`, поле \`SessionDto.expirationInfo\` показывает срок.

#### Scenario: TTL

- **WHEN** запрос с \`ttlSeconds\` = 10
- **THEN** ответ содержит \`expirationInfo\`
`;

  it('параметр вне раздела Configuration и glossary', () => {
    const issues = issuesOf(text, 'parameter-registry');
    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('«maxTtl»'),
      expect.stringContaining('«SessionDto.expirationInfo»'),
      expect.stringContaining('«ttlSeconds»'),
      expect.stringContaining('«expirationInfo»'),
    ]);
  });

  it('glossary и parameters настроек пополняют реестр; поле DTO находится по имени', () => {
    const issues = issuesOf(text, 'parameter-registry', { glossary: ['SessionDto.expirationInfo'], parameters: { maxTtl: 3600, ttlSeconds: null } });
    expect(issues).toEqual([]);
  });

  it('без реестра правило молчит', () => {
    expect(issuesOf(text.replace(/## Configuration[\s\S]*?## Requirements/, '## Requirements'), 'parameter-registry')).toEqual([]);
  });
});

describe('качество спеков: R8 словарь акторов', () => {
  const text = spec(`### Requirement: Синхронизация

Кластер ДОЛЖЕН (SHALL) рассылать изменения. Master ДОЛЖЕН подтверждать приём. КМ ДОЛЖЕН повторять запрос при отказе.

#### Scenario: Изменение разослано

- **WHEN** сессия изменена
- **THEN** узлы получают событие изменения
`);

  it('подлежащее не из словаря', () => {
    const issues = issuesOf(text, 'actor-dictionary', { actors: ['кластер', 'КМ'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('«Master»');
  });

  it('без словаря правило молчит', () => {
    expect(issuesOf(text, 'actor-dictionary')).toEqual([]);
  });
});

describe('качество спеков: R9 расплывчатые слова', () => {
  const text = spec(`### Requirement: Создание сессии

Кластер ДОЛЖЕН (SHALL) создавать сессию по валидным NewSessionRq, например с TTL и т. д. Ссылки дельты проверяются в основном спеке.

#### Scenario: Сессия создана

- **WHEN** приходит корректный запрос
- **THEN** ответ содержит «Некорректный путь» и \`valid\`
`);

  it('флагает словарные слова, но не «в основном спеке» и не текст в кавычках и коде', () => {
    const issues = issuesOf(text, 'vague-wording');
    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringMatching(/«валидным», «и т\. д\.», «например»/),
      expect.stringContaining('«корректный»'),
    ]);
    expect(specQuality(sources(text)).metrics.ambiguityDensity).toBeGreaterThan(0);
  });

  it('словарь пополняется и сокращается настройками', () => {
    const issues = issuesOf(text, 'vague-wording', { vagueWords: { add: ['сессию'], ignore: ['например', 'корректный'] } });
    expect(issues.map((issue) => issue.message)).toEqual([expect.stringMatching(/^(?!.*например).*«сессию»/)]);
  });
});

describe('качество спеков: R10 наблюдаемость THEN', () => {
  it('THEN про кэш без ответа или кода', () => {
    const text = spec(`### Requirement: Отказ в создании

Кластер ДОЛЖЕН (SHALL) отклонять запрос без заголовков с кодом \`HEADERS_REQUIRED\`.

#### Scenario: Нет заголовков

- **WHEN** запрос без заголовков
- **THEN** ответ — ошибка \`HEADERS_REQUIRED\`
- **AND** сессия в кэш не создаётся
`);
    const issues = issuesOf(text, 'observable-then');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.line).toBe(16);
  });
});

describe('качество спеков: R11 негативные и позитивные сценарии', () => {
  it('требование с отказом без позитивного сценария и без негативного', () => {
    const onlyNegative = spec(`### Requirement: Заголовки SDS-CM

Кластер ДОЛЖЕН (SHALL) отклонять запрос без заголовка \`SDS-CM-CLIENT-IP\`.

#### Scenario: Нет заголовка

- **WHEN** запрос без заголовка
- **THEN** ответ — ошибка 400
`);
    expect(issuesOf(onlyNegative, 'negative-scenarios')[0]?.message).toContain('только сценарии с ошибкой');

    const onlyPositive = onlyNegative.replace('- **THEN** ответ — ошибка 400', '- **THEN** сессия создаётся');
    expect(issuesOf(onlyPositive, 'negative-scenarios')[0]?.message).toContain('ни один сценарий не проверяет');
  });
});

describe('качество спеков: R12 атомарность', () => {
  it('нормативные предложения без общих слов — сведение', () => {
    const text = spec(`### Requirement: Создание сессии

Кластер ДОЛЖЕН (SHALL) создавать сессию клиента. Каждый ответ ДОЛЖЕН нести заголовки трассировки.

#### Scenario: Сессия создана

- **WHEN** запрос пришёл
- **THEN** ответ содержит \`sessionId\`
`);
    const issues = issuesOf(text, 'atomicity');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('info');
  });

  it('предложения об одном предмете не флагаются', () => {
    const text = spec(`### Requirement: Создание сессии

Кластер ДОЛЖЕН (SHALL) создавать сессию клиента. Сессия ДОЛЖНА получать TTL из запроса.

#### Scenario: Сессия создана

- **WHEN** запрос пришёл
- **THEN** ответ содержит \`sessionId\`
`);
    expect(issuesOf(text, 'atomicity')).toEqual([]);
  });
});

describe('качество спеков: R13 согласованность с Purpose', () => {
  it('сущность из Purpose без требования', () => {
    const text = spec(
      `### Requirement: Создание сессии

Кластер ДОЛЖЕН (SHALL) создавать сессию клиента.

#### Scenario: Сессия создана

- **WHEN** запрос пришёл
- **THEN** ответ содержит \`sessionId\`
`,
      'Кластер управляет сессиями: создание сессии, healthcheck и синхронизация узлов.',
    );
    const issues = issuesOf(text, 'purpose-coverage');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('«healthcheck», «синхронизация узлов»');
    expect(issues[0]?.line).toBe(4);
  });
});

describe('качество спеков: реестр кодов ошибок', () => {
  const text = spec(`### Requirement: Отказ

Кластер ДОЛЖЕН (SHALL) отклонять запрос с кодом \`HEADERS_REQUIRED\` или \`TTL_TOO_LONG\`.

#### Scenario: Нет заголовков

- **WHEN** запрос без заголовков
- **THEN** ответ — ошибка \`HEADERS_REQUIRED\`

#### Scenario: Длинный TTL

- **WHEN** TTL слишком длинный
- **THEN** ответ — ошибка \`TTL_TOO_LONG\`

#### Scenario: Успех

- **WHEN** запрос полный
- **THEN** ответ содержит \`sessionId\`
`);
  const registry = [{ path: 'src/ErrorCode.java', codes: registryCodes('enum ErrorCode {\n  HEADERS_REQUIRED,\n  CACHE_LIMIT_EXCEEDED\n}', null) }];

  it('код спеки вне реестра и код реестра без спеки', () => {
    const issues = issuesOf(text, 'error-code-registry', { registry });
    expect(issues.map((issue) => [issue.path, issue.line, issue.level])).toEqual([
      [SPEC, 10, 'warning'],
      ['src/ErrorCode.java', 3, 'info'],
    ]);
    expect(issues[0]?.message).toContain('TTL_TOO_LONG');
    expect(issues[1]?.message).toContain('CACHE_LIMIT_EXCEEDED');
  });

  it('по одному документу сверка реестра не делается', () => {
    const report = specQuality(sources(text, { registry }), SPEC);
    expect(report.issues.filter((issue) => issue.path === 'src/ErrorCode.java')).toEqual([]);
  });
});

describe('качество спеков: пороги метрик и уровни правил', () => {
  const text = spec(`### Requirement: Создание сессии

Кластер ДОЛЖЕН (SHALL) создавать сессию по валидным NewSessionRq.

#### Scenario: Сессия создана

- **WHEN** запрос пришёл
- **THEN** ответ содержит \`sessionId\`
`);

  it('метрика за порогом — ошибка на строке порога', () => {
    const issues = issuesOf(text, 'metric-threshold', { thresholds: [{ metric: 'ambiguityDensity', value: 0.5, line: 7 }] });
    expect(issues).toEqual([
      expect.objectContaining({ path: 'openspec/quality.yaml', line: 7, level: 'error', message: expect.stringContaining('выше порога 0,50') }),
    ]);
  });

  it('уровень правила меняется, off выключает', () => {
    expect(issuesOf(text, 'vague-wording', { levels: { 'vague-wording': 'error' } })[0]?.level).toBe('error');
    expect(rules(text, { levels: { 'vague-wording': 'off' } })).not.toContain('vague-wording');
  });

  it('scope: changes — только дельты активных changes', () => {
    const all: AuthoringSources = {
      ...sources(text, { scope: 'changes' }),
      changes: [{ name: 'add-ttl', deltas: [{ capability: 'sessions', path: 'openspec/changes/add-ttl/specs/sessions/spec.md', text: `## ADDED Requirements\n\n${text.split('## Requirements\n\n')[1] ?? ''}` }], plan: null }],
    };
    const report = specQuality(all);
    expect(report.files.map((file) => file.path)).toEqual(['openspec/changes/add-ttl/specs/sessions/spec.md']);
    expect(report.issues.every((issue) => issue.path.startsWith('openspec/changes/'))).toBe(true);
  });

  it('удалённые и переименованные требования не проверяются', () => {
    const delta = `## REMOVED Requirements\n\n### Requirement: Старое\n\n**Reason**: корректно и т. д.\n**Migration**: нет\n`;
    const report = specQuality({ mainSpecs: [], changes: [{ name: 'x', deltas: [{ capability: 'sessions', path: 'd.md', text: delta }], plan: null }] });
    expect(report.issues).toEqual([]);
  });
});

describe('качество спеков: сквозной пример', () => {
  it('спека сессий ловится сразу несколькими правилами', () => {
    const text = `# sessions Specification

## Purpose
Кластер управляет клиентскими сессиями: создание сессии, продление TTL, healthcheck и синхронизация.

## Configuration

- \`minTtl\`, \`maxTtl\` — границы TTL, с.

## Requirements

### Requirement: Создание сессии

Кластер ДОЛЖЕН (SHALL) создавать сессию по валидным NewSessionRq с TTL, приведённым к [\`minTtl\`, \`maxTtl\`]. Если нет \`externalSessionId\`, кластер ДОЛЖЕН вернуть ошибку \`SESSION_CREATION_WITHOUT_EXTERNAL_SESSION_ID\`. Master ДОЛЖЕН проверять заголовки SDS-CM.

#### Scenario: Сессия создана

- **WHEN** КМ отправляет NewSessionRq с \`externalSessionId\` и TTL 10, \`minTtl\` = 60
- **THEN** sessionCache.getCacheSize() возвращает 1
- **AND** сессия попадает в кэш
`;
    const found = new Set(rules(text, { actors: ['кластер', 'КМ'] }));
    expect([...found].sort()).toEqual(
      [
        'actor-dictionary',
        'atomicity',
        'boundary-values',
        'error-code-trace',
        'implementation-leak',
        'negative-scenarios',
        'observable-then',
        'parameter-registry',
        'purpose-coverage',
        'vague-wording',
        'branch-coverage',
      ].sort(),
    );
  });
});

describe('настройки проверки качества', () => {
  it('разбирает все ключи', () => {
    const { config, registryPaths } = parseQualityConfig({
      version: 1,
      scope: 'changes',
      rules: { atomicity: 'off', 'vague-wording': 'error', 'purpose-coverage': false },
      errorCodes: { pattern: 'E\\d{3}', registry: ['src/ErrorCode.java'] },
      actors: ['кластер', 'КМ'],
      glossary: ['SessionDto.sectionList'],
      parameters: { minTtl: 60, maxCacheSize: null },
      vagueWords: { add: ['оперативно'], ignore: ['например'] },
      internalTerms: ['sessionCache'],
      thresholds: { errorCodeTraceability: 1, ambiguityDensity: 0.5 },
    });
    expect(config.errors).toEqual([]);
    expect(config.scope).toBe('changes');
    expect(config.levels).toEqual({ atomicity: 'off', 'vague-wording': 'error', 'purpose-coverage': 'off' });
    expect(config.errorCodePattern).toBe('E\\d{3}');
    expect(registryPaths).toEqual(['src/ErrorCode.java']);
    expect(config.parameters).toEqual({ minTtl: 60, maxCacheSize: null });
    expect(config.internalTerms).toEqual({ add: ['sessionCache'], ignore: [] });
    expect(config.thresholds.map((item) => [item.metric, item.value])).toEqual([
      ['errorCodeTraceability', 1],
      ['ambiguityDensity', 0.5],
    ]);
  });

  it('ошибки — со строкой ключа, остальное действует', () => {
    const lines: Record<string, number> = { unknown: 2, 'rules\u0000nope': 4, 'thresholds\u0000branchCoverage': 6, 'errorCodes\u0000pattern': 8 };
    const { config } = parseQualityConfig(
      { unknown: 1, rules: { nope: 'warning', atomicity: 'loud' }, thresholds: { branchCoverage: 80 }, errorCodes: { pattern: '(' }, actors: ['КМ'] },
      (path) => lines[path.join('\u0000')] ?? null,
    );
    expect(config.errors.map((error) => error.line)).toEqual([2, 4, null, 8, 6]);
    expect(config.actors).toEqual(['КМ']);
  });

  it('реестр кодов — первое вхождение каждого кода со строкой', () => {
    expect(registryCodes('A_B\nA_B, C_D\nlower_case', null)).toEqual([
      { code: 'A_B', line: 1 },
      { code: 'C_D', line: 2 },
    ]);
  });
});
