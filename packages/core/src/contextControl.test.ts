import { describe, expect, it } from 'vitest';
import {
  codePathPrefix,
  countLines,
  estimateTokens,
  extractReferences,
  findDuplicates,
  isActiveAdrStatus,
  isEmptyContext,
  measureUsefulness,
  normalizeProjectPath,
  referenceCandidates,
} from './contextControl.js';

describe('оценка объёма', () => {
  it('латиница — 4 символа на токен, кириллица — 2,5', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
    expect(estimateTokens('абвгд'.repeat(10))).toBe(20);
    expect(estimateTokens('ab абв')).toBe(Math.ceil(3 / 4 + 3 / 2.5));
  });

  it('строки без завершающего перевода', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\r\nb\r\nc')).toBe(3);
  });
});

describe('ссылки на пути', () => {
  const text = [
    '---',
    'title: `skip/this.md`',
    '---',
    '# Модуль',
    'Сервис в `svc/src/App.java:42` и [схема](../adr/ADR-001.md#решение), см. [сайт](https://example.com) и [выше](#модуль).',
    'Не пути: `I/O`, `/api/context-map`, `openspec/context/modules/<папка>/`, `src/**/*.ts`, `1/2.5`, `a b/c.md`.',
    'Папка `packages/core/` и `@openspec/specs/replication/spec.md`.',
    '```',
    'example/path.ts',
    '`fenced/inline.ts`',
    '```',
    '![рисунок](<img/диаграмма.png> "подпись")',
  ].join('\n');

  it('цели ссылок и пути в коде с номерами строк; frontmatter, якоря, адреса и блоки кода пропущены', () => {
    expect(extractReferences(text)).toEqual([
      { target: '../adr/ADR-001.md', line: 5, kind: 'link' },
      { target: 'svc/src/App.java', line: 5, kind: 'code' },
      { target: 'packages/core/', line: 7, kind: 'code' },
      { target: 'openspec/specs/replication/spec.md', line: 7, kind: 'code' },
      { target: 'img/диаграмма.png', line: 12, kind: 'link' },
    ]);
  });

  it('кандидаты: от файла, от корня, от путей кода; выше корня — нет', () => {
    const file = 'openspec/context/modules/m/context.md';
    expect(referenceCandidates({ target: '../../adr/A.md' }, file)).toEqual(['openspec/context/adr/A.md']);
    expect(referenceCandidates({ target: 'main/App.java' }, file, ['svc/src', 'lib/**/*.ts', '/abs'])).toEqual([
      'openspec/context/modules/m/main/App.java',
      'main/App.java',
      'svc/src/main/App.java',
      'lib/main/App.java',
    ]);
    expect(referenceCandidates({ target: '/README.md' }, file)).toEqual(['README.md']);
    expect(referenceCandidates({ target: '../../../../../x.md' }, file)).toEqual([]);
  });

  it('нормализация путей и префикс шаблона кода', () => {
    expect(normalizeProjectPath('a/./b/../c/')).toBe('a/c');
    expect(normalizeProjectPath('../a')).toBeNull();
    expect(codePathPrefix('sds/src/main/java/**')).toBe('sds/src/main/java');
    expect(codePathPrefix('sds/src/...')).toBe('sds/src');
    expect(codePathPrefix('**/*.java')).toBeNull();
    expect(codePathPrefix('C:\\work')).toBeNull();
  });
});

describe('лишнее', () => {
  const long = 'Мастер хранит данные сессии в памяти и реплицирует их синхронно на резервный узел до ответа клиенту.';

  it('повтор абзаца — с точностью до пробелов и регистра, первое вхождение по порядку файлов', () => {
    const duplicates = findDuplicates([
      { path: 'general.md', text: `# Общее\n\n${long}\n` },
      { path: 'module.md', text: `# Модуль\n\nДругое.\n\n${long.toUpperCase().replace(/ /g, '  ')}\n\n- ${long}\n` },
      { path: 'short.md', text: 'Короткий абзац.\n\nКороткий абзац.\n' },
    ]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.occurrences).toEqual([
      { path: 'general.md', line: 3 },
      { path: 'module.md', line: 5 },
      { path: 'module.md', line: 7 },
    ]);
    expect(duplicates[0]?.tokens).toBe(estimateTokens(long));
  });

  it('заголовки и блоки кода в повторах не участвуют', () => {
    const block = '```\nconst value = "одна и та же длинная строка примера, которая повторяется в двух файлах";\n```';
    expect(findDuplicates([
      { path: 'a.md', text: block },
      { path: 'b.md', text: block },
    ])).toEqual([]);
  });

  it('пустой контекст — только заголовки, frontmatter и комментарии', () => {
    expect(isEmptyContext('# Контекст sds-impl\n')).toBe(true);
    expect(isEmptyContext('---\nmodule: x\n---\n# A\n\n## B\n<!-- заполнить -->\n')).toBe(true);
    expect(isEmptyContext('# A\n\nТекст.')).toBe(false);
    expect(isEmptyContext('# A\n```\ncode\n```\n')).toBe(false);
  });

  it('недействующий ADR — по первому слову статуса', () => {
    expect(isActiveAdrStatus(null)).toBe(true);
    expect(isActiveAdrStatus('accepted')).toBe(true);
    expect(isActiveAdrStatus('Superseded by ADR-007')).toBe(false);
    expect(isActiveAdrStatus('отменено')).toBe(false);
    expect(isActiveAdrStatus('deprecated: см. ADR-3')).toBe(false);
  });
});

describe('коэффициент полезности', () => {
  const content = 'Модуль отвечает за хранение сессий пользователей, их продление и удаление по таймауту.';
  const anchored = 'Сессии хранит класс `Store` в `session/Store.java`, таймауты считает `Expiry`.';

  it('файл без балласта — плотность 1, коэффициент 1', () => {
    const result = measureUsefulness(`# Модуль\n\n${content}\n`);
    expect(result.ballast).toEqual({ duplicate: 0, placeholder: 0, broken: 0, empty: 0 });
    expect(result.density).toBe(1);
    expect(result.grounding).toBeNull();
    expect(result.freshness).toBeNull();
    expect(result.score).toBe(1);
    expect(result.usefulTokens).toBe(result.tokens);
  });

  it('балласт: повтор, заготовки и абзац с битым путём — каждый абзац один раз', () => {
    const text = [
      '# Модуль', // 1
      '', // 2
      '<!-- Опишите назначение модуля и пути к коду. -->', // 3
      '', // 4
      content, // 5
      '', // 6
      'TODO: описать ограничения по памяти.', // 7
      '', // 8
      '<описание сценариев отказа>', // 9
      '', // 10
      anchored, // 11
      '', // 12
      `${content} Повтор.`, // 13
    ].join('\n');
    const result = measureUsefulness(text, { duplicateLines: new Set([13]), brokenLines: new Set([11, 13]) });
    expect(result.ballast.duplicate).toBe(estimateTokens(`${content} Повтор.`));
    expect(result.ballast.broken).toBe(estimateTokens(anchored));
    expect(result.ballast.placeholder).toBe(
      estimateTokens('<!-- Опишите назначение модуля и пути к коду. -->') +
        estimateTokens('TODO: описать ограничения по памяти.') +
        estimateTokens('<описание сценариев отказа>'),
    );
    const waste = result.ballast.duplicate + result.ballast.placeholder + result.ballast.broken;
    expect(result.density).toBeCloseTo((result.tokens - waste) / result.tokens);
    expect(result.score).toBeCloseTo(result.density);
  });

  it('слово в начале абзаца, похожее на заготовку, заготовкой не считается', () => {
    const result = measureUsefulness('# A\n\nTODOist — внешний сервис задач, с ним модуль не работает.\n\n---\n\nMap<string, number> хранит счётчики.\n');
    expect(result.ballast.placeholder).toBe(0);
  });

  it('привязка к коду снижает коэффициент не больше чем вдвое', () => {
    const half = measureUsefulness(`# A\n\n${anchored}\n\n${content}\n`, { grounding: true });
    const share = estimateTokens(anchored) / (estimateTokens(anchored) + estimateTokens(content));
    expect(half.grounding).toBeCloseTo(share);
    expect(half.score).toBeCloseTo(0.5 + 0.5 * share);
    expect(measureUsefulness(`# A\n\n${content}\n`, { grounding: true }).score).toBe(0.5);
    expect(measureUsefulness(`# A\n\n[схема](docs/a.md) — ${content}\n`, { grounding: true }).grounding).toBe(1);
  });

  it('свежесть: 10 коммитов отставания — множитель 0,5, без данных — не учитывается', () => {
    const text = `# A\n\n${content}\n`;
    expect(measureUsefulness(text, { commitsAfter: 0 }).freshness).toBe(1);
    expect(measureUsefulness(text, { commitsAfter: 10 }).score).toBe(0.5);
    expect(measureUsefulness(text, { commitsAfter: 30 }).freshness).toBe(0.25);
    expect(measureUsefulness(text, { commitsAfter: null }).freshness).toBeNull();
  });

  it('пустой файл — балласт целиком, коэффициент 0', () => {
    const result = measureUsefulness('# Контекст sds-impl\n\n<!-- заполнить -->\n', { grounding: true });
    expect(result.ballast.empty).toBe(result.tokens);
    expect(result.score).toBe(0);
    expect(result.usefulTokens).toBe(0);
    expect(measureUsefulness('').score).toBe(0);
  });

  it('HTML-комментарии в поиске повторов не участвуют', () => {
    const comment = '<!-- Опишите назначение модуля, его границы, ключевые классы и пути к коду модуля. -->';
    expect(findDuplicates([
      { path: 'a.md', text: `# A\n\n${comment}\n` },
      { path: 'b.md', text: `# B\n\n${comment}\n` },
    ])).toEqual([]);
  });
});
