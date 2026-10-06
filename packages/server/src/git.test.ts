import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize } from './fs/workspace.js';
import { GitHistory } from './git.js';

let root: string;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-git-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
}

describe('снимок состояния git', () => {
  it('тот же без изменений, другой после коммита и после git add', async () => {
    git('init', '-q');
    writeFileSync(join(root, 'a.txt'), '1');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const history = new GitHistory(root);

    const first = await history.snapshot();
    expect(first).not.toBeNull();
    expect(await history.snapshot()).toBe(first);

    writeFileSync(join(root, 'a.txt'), '2');
    // Правка рабочего дерева без git add индекс не трогает.
    expect(await history.snapshot()).toBe(first);

    git('add', '.');
    const staged = await history.snapshot();
    expect(staged).not.toBe(first);

    git('commit', '-q', '-m', 'second');
    const committed = await history.snapshot();
    expect(committed).not.toBe(staged);
    expect(committed?.split(' ')[0]).not.toBe(first?.split(' ')[0]);
  });

  it('каталог без git и репозиторий без коммитов — null', async () => {
    expect(await new GitHistory(root).snapshot()).toBeNull();
    git('init', '-q');
    expect(await new GitHistory(root).snapshot()).toBeNull();
  });
});
