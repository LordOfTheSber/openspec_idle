import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@openspec-ide/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateOpenspecCli, missingCliNotice } from './locate.js';

let dir: string;

beforeEach(() => {
  dir = canonicalize(mkdtempSync(join(tmpdir(), 'osi-locate-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeExecutable(at: string): void {
  mkdirSync(join(at, '..'), { recursive: true });
  writeFileSync(at, '#!/bin/sh\necho ok\n');
  chmodSync(at, 0o755);
}

describe('поиск CLI OpenSpec', () => {
  it('предпочитает исполняемый файл из node_modules проекта', () => {
    const bin = join(dir, 'node_modules', '.bin', 'openspec');
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    makeExecutable(bin);

    const found = locateOpenspecCli(dir, { PATH: '' });
    expect(found.kind).toBe('found');
    expect(found.kind === 'found' && found.source).toBe('project');
    expect(found.kind === 'found' && found.bin).toBe(bin);
  });

  it('находит CLI, установленный выше по дереву', () => {
    const nested = join(dir, 'packages', 'server');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    makeExecutable(join(dir, 'node_modules', '.bin', 'openspec'));

    const found = locateOpenspecCli(nested, { PATH: '' });
    expect(found.kind === 'found' && found.source).toBe('project');
    expect(found.kind === 'found' && found.bin).toBe(join(dir, 'node_modules', '.bin', 'openspec'));
  });

  it('падает обратно на PATH, когда в проекте CLI нет', () => {
    const elsewhere = join(dir, 'bin');
    mkdirSync(elsewhere, { recursive: true });
    makeExecutable(join(elsewhere, 'openspec'));

    const found = locateOpenspecCli(dir, { PATH: elsewhere });
    expect(found.kind === 'found' && found.source).toBe('path');
  });

  it('с пустым PATH и без CLI в проекте сообщает о ненайденном инструменте', () => {
    const missing = locateOpenspecCli(dir, { PATH: '' });

    expect(missing.kind).toBe('not-found');
    if (missing.kind !== 'not-found') return;
    expect(missing.searched.some((p) => p.includes('node_modules/.bin/openspec'))).toBe(true);
  });

  it('уведомление называет инструмент, команду установки и просмотренные пути', () => {
    const missing = locateOpenspecCli(dir, { PATH: '' });
    if (missing.kind !== 'not-found') throw new Error('ожидался not-found');

    const notice = missingCliNotice(missing);
    expect(notice.tool).toBe('@fission-ai/openspec');
    expect(notice.install).toContain('npm install');
    expect(notice.searched.length).toBeGreaterThan(0);
  });

  it('неисполняемый файл с нужным именем за CLI не принимается', () => {
    const binDir = join(dir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'openspec'), 'не исполняемый');
    chmodSync(join(binDir, 'openspec'), 0o644);

    expect(locateOpenspecCli(dir, { PATH: '' }).kind).toBe('not-found');
  });
});
