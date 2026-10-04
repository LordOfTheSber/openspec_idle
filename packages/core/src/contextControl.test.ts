import { describe, expect, it } from 'vitest';
import {
  codePathPrefix,
  countLines,
  estimateTokens,
  extractReferences,
  findDuplicates,
  isActiveAdrStatus,
  isEmptyContext,
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
