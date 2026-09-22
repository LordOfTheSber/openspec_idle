import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@openspec-ide/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OutsideWorkspaceError, resolveInsideWorkspace } from './paths.js';

let root: string;
let outside: string;

beforeEach(() => {
  const base = canonicalize(mkdtempSync(join(tmpdir(), 'osi-paths-')));
  root = join(base, 'project');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'openspec'), { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('операции над файлами ограничены рабочим пространством', () => {
  it('относительный путь внутри корня разрешается', () => {
    const resolved = resolveInsideWorkspace(root, 'openspec/config.yaml');
    expect(resolved).toBe(join(root, 'openspec', 'config.yaml'));
  });

  it('абсолютный путь внутри корня разрешается', () => {
    const target = join(root, 'openspec', 'changes', 'x', 'proposal.md');
    expect(resolveInsideWorkspace(root, target)).toBe(target);
  });

  it('переход выше корня отклоняется', () => {
    expect(() => resolveInsideWorkspace(root, '../outside/secret.md')).toThrow(
      OutsideWorkspaceError,
    );
  });

  it('абсолютный путь вне корня отклоняется', () => {
    expect(() => resolveInsideWorkspace(root, join(outside, 'secret.md'))).toThrow(
      /за пределами рабочего пространства/,
    );
  });

  it('символическая ссылка наружу отклоняется после разрешения', () => {
    writeFileSync(join(outside, 'secret.md'), 'секрет');
    symlinkSync(join(outside, 'secret.md'), join(root, 'link.md'));

    expect(() => resolveInsideWorkspace(root, 'link.md')).toThrow(OutsideWorkspaceError);
  });

  it('каталог-сосед с общим префиксом имени не считается вложенным', () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling, { recursive: true });
    expect(() => resolveInsideWorkspace(root, join(sibling, 'file.md'))).toThrow(
      OutsideWorkspaceError,
    );
  });
});
