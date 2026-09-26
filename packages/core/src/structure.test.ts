import { describe, expect, it } from 'vitest';
import {
  type DirEntry,
  type ReadDir,
  type StructureSpec,
  checkStructure,
  matchesName,
  parseStructureSpec,
  topLevelDirs,
} from './structure.js';

/** Файловая система в памяти: пути файлов; папки выводятся из путей, `dir/` — пустая папка. */
function memoryFs(paths: readonly string[]): ReadDir {
  const dirs = new Map<string, Map<string, boolean>>();
  const ensure = (dir: string): Map<string, boolean> => {
    let children = dirs.get(dir);
    if (children === undefined) {
      children = new Map();
      dirs.set(dir, children);
    }
    return children;
  };
  ensure('');
  for (const raw of paths) {
    const isDirOnly = raw.endsWith('/');
    const parts = raw.replace(/\/$/, '').split('/');
    let parent = '';
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      const isDir = !last || isDirOnly;
      ensure(parent).set(part, isDir || (ensure(parent).get(part) ?? false));
      parent = parent === '' ? part : `${parent}/${part}`;
      if (isDir) ensure(parent);
    });
  }
  return async (path) => {
    const children = dirs.get(path);
    if (children === undefined) return null;
    return [...children].map(([name, isDir]): DirEntry => ({ name, isDir }));
  };
}

function spec(structure: unknown, extra: Record<string, unknown> = {}): StructureSpec {
  const parsed = parseStructureSpec({ version: 1, structure, ...extra });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('\n'));
  return parsed.spec;
}

const CONTEXT = {
  docs: {
    context: {
      'README.md': 'file',
      'glossary.md': 'file',
      adr: { '*.md': 'file' },
    },
  },
  openspec: {
    'config.yaml': 'file',
    specs: '*',
    'schemas?': '*',
  },
};

describe('разбор описания структуры', () => {
  it('понимает все правила и необязательность', () => {
    const parsed = spec({ a: 'file', b: '*', c: 'any', 'd?': { 'x.md': 'file' }, e: null, '*.txt': 'file' });

    expect(parsed.entries.map((entry) => [entry.name, entry.rule.kind, entry.optional, entry.pattern])).toEqual([
      ['a', 'file', false, false],
      ['b', 'free', false, false],
      ['c', 'any', false, false],
      ['d', 'dir', true, false],
      ['e', 'dir', false, false],
      ['*.txt', 'file', false, true],
    ]);
    expect(parsed.ignore).toContain('.gitkeep');
  });

  it('сообщает все ошибки описания со строками', () => {
    const lines: Record<string, number> = {
      'structure/docs': 3,
      'structure/docs/README.md': 4,
      'structure/docs/a/b': 5,
      'structure/docs/*.md?': 6,
    };
    const result = parseStructureSpec(
      { structure: { docs: { 'README.md': 'required', 'a/b': 'file', '*.md?': 'file' } } },
      (path) => lines[path.join('/')] ?? null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({ line: 4, message: expect.stringContaining('Неизвестное правило «required»') }),
      expect.objectContaining({ line: 5, message: expect.stringContaining('не может содержать «/»') }),
      expect.objectContaining({ line: 6, message: expect.stringContaining('и так необязателен') }),
    ]);
  });

  it('без поля structure и с неверной версией — ошибки', () => {
    const result = parseStructureSpec({ version: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.message).join('\n')).toMatch(/версия[\s\S]*structure/);
    expect(parseStructureSpec('text').ok).toBe(false);
  });

  it('шаблон имени со звёздочкой', () => {
    expect(matchesName('*.md', 'README.md')).toBe(true);
    expect(matchesName('*.md', 'README.mdx')).toBe(false);
    expect(matchesName('ADR-*', 'ADR-001.md')).toBe(true);
    expect(matchesName('a.b', 'axb')).toBe(false);
  });
});

describe('проверка соответствия', () => {
  const good = [
    'docs/context/README.md',
    'docs/context/glossary.md',
    'docs/context/adr/0001-start.md',
    'openspec/config.yaml',
    'openspec/specs/a/b/c/spec.md',
    'openspec/specs/.gitkeep',
    'src/index.ts',
    'package.json',
  ];

  it('соответствующая структура: нарушений нет, корень не строгий, свободная папка не проверяется', async () => {
    const result = await checkStructure(spec(CONTEXT), memoryFs(good));

    expect(result.issues).toEqual([]);
    expect(result.tree.map((node) => [node.name, node.state])).toEqual([
      ['docs', 'ok'],
      ['openspec', 'ok'],
    ]);
    const schemas = result.tree[1]?.children.find((child) => child.name === 'schemas');
    expect(schemas?.state).toBe('absent-optional');
  });

  it('нет обязательного файла — со строкой его правила', async () => {
    const parsed = parseStructureSpec(
      { structure: { docs: { context: { 'README.md': 'file' } } } },
      (path) => (path.join('/') === 'structure/docs/context/README.md' ? 7 : null),
    );
    if (!parsed.ok) throw new Error('описание не разобрано');

    const result = await checkStructure(parsed.spec, memoryFs(['docs/context/other/']));

    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'missing', path: 'docs/context/README.md', expected: 'file', line: 7 }),
    );
    expect(result.issues[0]?.message).toBe('Нет обязательного файла docs/context/README.md');
  });

  it('лишний файл в строгой папке — со строкой папки и разрешёнными именами', async () => {
    const parsed = parseStructureSpec(
      { structure: { docs: { context: { 'README.md': 'file', adr: '*' } } } },
      (path) => (path.join('/') === 'structure/docs/context' ? 3 : null),
    );
    if (!parsed.ok) throw new Error('описание не разобрано');

    const result = await checkStructure(parsed.spec, memoryFs(['docs/context/README.md', 'docs/context/adr/', 'docs/context/draft.txt']));

    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'unexpected', path: 'docs/context/draft.txt', actual: 'file', line: 3 }),
    ]);
    expect(result.issues[0]?.message).toContain('разрешены только README.md, adr/');
  });

  it('не тот тип: файл вместо папки и папка вместо файла', async () => {
    const result = await checkStructure(
      spec({ docs: { adr: '*', 'README.md': 'file' } }),
      memoryFs(['docs/adr', 'docs/README.md/x']),
    );

    expect(result.issues.map((issue) => [issue.kind, issue.path, issue.expected, issue.actual])).toEqual([
      ['wrong-type', 'docs/adr', 'dir', 'file'],
      ['wrong-type', 'docs/README.md', 'file', 'dir'],
    ]);
  });

  it('шаблон: любое число подходящих, неподходящее — лишнее', async () => {
    const result = await checkStructure(
      spec({ adr: { '*.md': 'file' } }),
      memoryFs(['adr/1.md', 'adr/2.md', 'adr/notes.txt']),
    );

    expect(result.issues.map((issue) => issue.path)).toEqual(['adr/notes.txt']);
    expect(result.tree[0]?.children[0]?.matches).toBe(2);
    expect((await checkStructure(spec({ adr: { '*.md': 'file' } }), memoryFs(['adr/']))).issues).toEqual([]);
  });

  it('точное имя важнее шаблона', async () => {
    const result = await checkStructure(
      spec({ docs: { 'index.md': { 'a.md': 'file' }, '*.md': 'file' } }),
      memoryFs(['docs/index.md/a.md', 'docs/other.md']),
    );

    expect(result.issues).toEqual([]);
  });

  it('пустая строгая папка и служебные файлы', async () => {
    expect((await checkStructure(spec({ empty: {} }), memoryFs(['empty/.DS_Store']))).issues).toEqual([]);
    const strictIgnore = await checkStructure(spec({ empty: {} }, { ignore: [] }), memoryFs(['empty/.DS_Store']));
    expect(strictIgnore.issues[0]?.message).toContain('должна быть пустой');
  });

  it('any — элемент любого типа', async () => {
    const tree = spec({ docs: { notes: 'any' } });
    expect((await checkStructure(tree, memoryFs(['docs/notes']))).issues).toEqual([]);
    expect((await checkStructure(tree, memoryFs(['docs/notes/a/b']))).issues).toEqual([]);
  });

  it('папки первого уровня для наблюдения', () => {
    expect(topLevelDirs(spec({ docs: '*', 'README.md': 'file', openspec: {} }))).toEqual(['docs', 'openspec']);
  });
});
