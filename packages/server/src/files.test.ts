import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from './fs/workspace.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutsideWorkspaceError } from './http/paths.js';
import {
  StaleWriteError,
  WriteFailedError,
  contentVersion,
  readArtifactFile,
  saveArtifactFile,
  type FileSystemOps,
} from './files.js';

let root: string;
const REL = 'openspec/changes/x/proposal.md';

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-files-')));
  mkdirSync(join(root, 'openspec', 'changes', 'x'), { recursive: true });
  writeFileSync(join(root, REL), '# Исходное содержимое\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function onDisk(): string {
  return readFileSync(join(root, REL), 'utf8');
}

describe('чтение артефакта', () => {
  it('отдаёт содержимое и версию', async () => {
    const file = await readArtifactFile(root, REL);

    expect(file.content).toBe('# Исходное содержимое\n');
    expect(file.version).toBe(contentVersion(file.content));
  });

  it('путь за пределами рабочего пространства отклоняется', async () => {
    await expect(readArtifactFile(root, '../снаружи.md')).rejects.toThrow(OutsideWorkspaceError);
  });
});

describe('сохранение артефакта', () => {
  it('записывает содержимое и отдаёт новую версию', async () => {
    const saved = await saveArtifactFile(root, REL, '# Новое\n', contentVersion(onDisk()));

    expect(onDisk()).toBe('# Новое\n');
    expect(saved.version).toBe(contentVersion('# Новое\n'));
  });

  it('не оставляет временных файлов рядом', async () => {
    await saveArtifactFile(root, REL, '# Новое\n', contentVersion(onDisk()));

    const leftovers = readdirSync(join(root, 'openspec', 'changes', 'x')).filter((name) =>
      name.includes('.tmp-'),
    );
    expect(leftovers).toHaveLength(0);
  });

  it('без базовой версии записывает без проверки расхождения', async () => {
    writeFileSync(join(root, REL), '# Изменено извне\n');
    await saveArtifactFile(root, REL, '# Принудительно\n', null);

    expect(onDisk()).toBe('# Принудительно\n');
  });

  it('файл, изменённый на диске, не затирается молча', async () => {
    const base = contentVersion(onDisk());
    writeFileSync(join(root, REL), '# Правка агента\n');

    const attempt = saveArtifactFile(root, REL, '# Правка в редакторе\n', base);

    await expect(attempt).rejects.toThrow(StaleWriteError);
    expect(onDisk()).toBe('# Правка агента\n');
  });

  it('при расхождении отдаётся версия с диска для сравнения', async () => {
    const base = contentVersion(onDisk());
    writeFileSync(join(root, REL), '# Правка агента\n');

    try {
      await saveArtifactFile(root, REL, '# Правка в редакторе\n', base);
      expect.unreachable('ожидалось расхождение');
    } catch (error) {
      expect(error).toBeInstanceOf(StaleWriteError);
      expect((error as StaleWriteError).disk.content).toBe('# Правка агента\n');
    }
  });

  it('сбой записи оставляет исходный файл целым', async () => {
    const failing: FileSystemOps = {
      readFile: async (path, encoding) =>
        (await import('node:fs/promises')).readFile(path, encoding),
      writeFile: async (path, data, encoding) =>
        (await import('node:fs/promises')).writeFile(path, data, encoding),
      rename: vi.fn().mockRejectedValue(new Error('EACCES: нет прав')),
      unlink: async (path) => (await import('node:fs/promises')).unlink(path),
    };

    const attempt = saveArtifactFile(
      root,
      REL,
      '# Не должно записаться\n',
      contentVersion(onDisk()),
      failing,
    );

    await expect(attempt).rejects.toThrow(WriteFailedError);
    expect(onDisk()).toBe('# Исходное содержимое\n');
    expect(failing.rename).toHaveBeenCalled();
  });

  it('после неудачной записи временный файл убирается', async () => {
    const unlink = vi.fn().mockResolvedValue(undefined);
    const failing: FileSystemOps = {
      readFile: async (path, encoding) =>
        (await import('node:fs/promises')).readFile(path, encoding),
      writeFile: async () => undefined,
      rename: async () => {
        throw new Error('сбой переименования');
      },
      unlink,
    };

    await expect(
      saveArtifactFile(root, REL, '# X\n', contentVersion(onDisk()), failing),
    ).rejects.toThrow(WriteFailedError);
    expect(unlink).toHaveBeenCalledOnce();
  });

  it('запись за пределы рабочего пространства отклоняется', async () => {
    await expect(saveArtifactFile(root, '../снаружи.md', '# X\n', null)).rejects.toThrow(
      OutsideWorkspaceError,
    );
  });
});

describe('версия содержимого', () => {
  it('различает разное содержимое и совпадает для одинакового', () => {
    expect(contentVersion('а')).toBe(contentVersion('а'));
    expect(contentVersion('а')).not.toBe(contentVersion('б'));
  });
});
