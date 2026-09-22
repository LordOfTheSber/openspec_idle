import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize, isInsideRoot, resolveOpenspecRoot } from './workspace.js';

let dir: string;

beforeEach(() => {
  dir = canonicalize(mkdtempSync(join(tmpdir(), 'osi-workspace-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('поиск корня OpenSpec', () => {
  it('находит корень, когда openspec/ лежит в самом каталоге', () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });
    const result = resolveOpenspecRoot(dir);
    expect(result.kind).toBe('found');
    expect(result.kind === 'found' && result.root).toBe(dir);
  });

  it('поднимается вверх по дереву из вложенного каталога', () => {
    mkdirSync(join(dir, 'openspec'), { recursive: true });
    const nested = join(dir, 'packages', 'server', 'src');
    mkdirSync(nested, { recursive: true });

    const result = resolveOpenspecRoot(nested);
    expect(result.kind).toBe('found');
    expect(result.kind === 'found' && result.root).toBe(dir);
  });

  it('сообщает о ненайденном корне и перечисляет просмотренные каталоги', () => {
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });

    const result = resolveOpenspecRoot(nested);
    expect(result.kind).toBe('not-found');
    expect(result.kind === 'not-found' && result.searched).toContain(nested);
    expect(result.kind === 'not-found' && result.searched.length).toBeGreaterThan(1);
  });

  it('не принимает файл с именем openspec за корень', () => {
    writeFileSync(join(dir, 'openspec'), 'не каталог');
    expect(resolveOpenspecRoot(dir).kind).toBe('not-found');
  });
});

describe('канонизация путей и проверка принадлежности корню', () => {
  it('корень принадлежит сам себе', () => {
    expect(isInsideRoot(dir, dir)).toBe(true);
  });

  it('вложенный путь принадлежит корню', () => {
    const nested = join(dir, 'openspec', 'changes', 'x', 'proposal.md');
    expect(isInsideRoot(dir, nested)).toBe(true);
  });

  it('переход выше корня отклоняется', () => {
    expect(isInsideRoot(dir, join(dir, '..', 'elsewhere.md'))).toBe(false);
  });

  it('каталог-сосед с общим префиксом имени не считается вложенным', () => {
    expect(isInsideRoot(join(dir, 'proj'), join(dir, 'proj-evil', 'file.md'))).toBe(false);
  });

  it('символическая ссылка наружу отклоняется после разрешения', () => {
    const outside = join(dir, 'outside');
    const root = join(dir, 'root');
    mkdirSync(outside, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outside, 'secret.md'), 'секрет');
    symlinkSync(join(outside, 'secret.md'), join(root, 'link.md'));

    expect(isInsideRoot(root, join(root, 'link.md'))).toBe(false);
  });

  it('канонизирует ещё не существующий путь через существующего предка', () => {
    const planned = join(dir, 'openspec', 'changes', 'new', 'proposal.md');
    expect(canonicalize(planned)).toBe(planned);
  });
});
