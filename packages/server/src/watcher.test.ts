import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from './fs/workspace.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FileChangeBatch, WorkspaceWatcher } from './watcher.js';

let root: string;
let watcher: WorkspaceWatcher | null = null;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-watch-')));
  mkdirSync(join(root, 'openspec', 'changes'), { recursive: true });
});

afterEach(async () => {
  await watcher?.stop();
  watcher = null;
  rmSync(root, { recursive: true, force: true });
});

/** Ждёт ближайшего объединённого обновления. */
function nextBatch(timeoutMs = 5000): {
  promise: Promise<FileChangeBatch>;
  onBatch: (batch: FileChangeBatch) => void;
} {
  let resolve!: (batch: FileChangeBatch) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FileChangeBatch>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => reject(new Error('обновление не пришло')), timeoutMs);
  return {
    promise,
    onBatch: (batch) => {
      clearTimeout(timer);
      resolve(batch);
    },
  };
}

describe('наблюдение за файлами рабочего пространства', () => {
  it('сообщает об изменении файла в openspec/', async () => {
    const { promise, onBatch } = nextBatch();
    watcher = new WorkspaceWatcher({ root, debounceMs: 50 }, onBatch);
    await watcher.start();

    writeFileSync(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');

    const batch = await promise;
    expect(batch.paths).toContain('openspec/config.yaml');
  });

  it('десятки изменений подряд дают одно объединённое обновление', async () => {
    const batches: FileChangeBatch[] = [];
    watcher = new WorkspaceWatcher({ root, debounceMs: 120 }, (batch) => batches.push(batch));
    await watcher.start();

    const dir = join(root, 'openspec', 'changes', 'many');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      writeFileSync(join(dir, `file-${i}.md`), `# ${i}\n`);
    }

    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(batches).toHaveLength(1);
    expect(batches[0]?.count).toBeGreaterThanOrEqual(40);
    expect(batches[0]?.paths.length).toBeGreaterThanOrEqual(40);
  });

  it('появление нового каталога change замечается', async () => {
    const { promise, onBatch } = nextBatch();
    watcher = new WorkspaceWatcher({ root, debounceMs: 50 }, onBatch);
    await watcher.start();

    mkdirSync(join(root, 'openspec', 'changes', 'added-later'), { recursive: true });

    const batch = await promise;
    expect(batch.paths.some((p) => p.includes('added-later'))).toBe(true);
  });

  it('после остановки обновления не приходят', async () => {
    const batches: FileChangeBatch[] = [];
    watcher = new WorkspaceWatcher({ root, debounceMs: 50 }, (batch) => batches.push(batch));
    await watcher.start();
    await watcher.stop();
    watcher = null;

    writeFileSync(join(root, 'openspec', 'after-stop.md'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(batches).toHaveLength(0);
  });
});
