import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '../fs/workspace.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configuredCandidates, globalBinDirs, locateOpenspecCli, missingCliNotice } from './locate.js';

let dir: string;
/** Ни PATH, ни глобальных каталогов: результат не зависит от машины. */
const bare = { env: { PATH: '' }, globalDirs: [] } as const;

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

    const found = locateOpenspecCli(dir, bare);
    expect(found.kind).toBe('found');
    expect(found.kind === 'found' && found.source).toBe('project');
    expect(found.kind === 'found' && found.bin).toBe(bin);
  });

  it('находит CLI, установленный выше по дереву', () => {
    const nested = join(dir, 'packages', 'server');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    makeExecutable(join(dir, 'node_modules', '.bin', 'openspec'));

    const found = locateOpenspecCli(nested, bare);
    expect(found.kind === 'found' && found.source).toBe('project');
    expect(found.kind === 'found' && found.bin).toBe(join(dir, 'node_modules', '.bin', 'openspec'));
  });

  it('падает обратно на PATH, когда в проекте CLI нет', () => {
    const elsewhere = join(dir, 'bin');
    mkdirSync(elsewhere, { recursive: true });
    makeExecutable(join(elsewhere, 'openspec'));

    const found = locateOpenspecCli(dir, { env: { PATH: elsewhere }, globalDirs: [] });
    expect(found.kind === 'found' && found.source).toBe('path');
  });

  it('с пустым PATH и без CLI в проекте сообщает о ненайденном инструменте', () => {
    const missing = locateOpenspecCli(dir, bare);

    expect(missing.kind).toBe('not-found');
    if (missing.kind !== 'not-found') return;
    expect(missing.searched.some((p) => p.includes('node_modules/.bin/openspec'))).toBe(true);
  });

  it('уведомление называет инструмент, команду установки и просмотренные пути', () => {
    const missing = locateOpenspecCli(dir, bare);
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

    expect(locateOpenspecCli(dir, bare).kind).toBe('not-found');
  });

  it('находит глобальную установку, которой нет в PATH процесса', () => {
    const global = join(dir, 'AppData', 'Roaming', 'npm');
    makeExecutable(join(global, 'openspec'));

    const found = locateOpenspecCli(dir, { env: { PATH: '' }, globalDirs: [global] });
    expect(found.kind === 'found' && found.source).toBe('global');
    expect(found.kind === 'found' && found.bin).toBe(join(global, 'openspec'));
  });

  it('явный путь к файлу важнее CLI проекта', () => {
    makeExecutable(join(dir, 'node_modules', '.bin', 'openspec'));
    const own = join(dir, 'tools', 'openspec');
    makeExecutable(own);

    const found = locateOpenspecCli(dir, { ...bare, configured: own });
    expect(found.kind === 'found' && found.source).toBe('configured');
    expect(found.kind === 'found' && found.bin).toBe(own);
  });

  it('явный путь может указывать на каталог, быть в кавычках и относительным', () => {
    makeExecutable(join(dir, 'tools', 'openspec'));

    expect(locateOpenspecCli(dir, { ...bare, configured: join(dir, 'tools') }).kind).toBe('found');
    expect(locateOpenspecCli(dir, { ...bare, configured: `"${join(dir, 'tools', 'openspec')}"` }).kind).toBe('found');
    expect(locateOpenspecCli(dir, { ...bare, configured: 'tools/openspec' }).kind).toBe('found');
  });

  it('путь из переменной OPENSPEC_CLI работает как настройка', () => {
    const own = join(dir, 'tools', 'openspec');
    makeExecutable(own);

    const found = locateOpenspecCli(dir, { env: { PATH: '', OPENSPEC_CLI: own }, globalDirs: [] });
    expect(found.kind === 'found' && found.source).toBe('configured');
  });

  it('неверный явный путь не подменяется найденным в другом месте', () => {
    makeExecutable(join(dir, 'node_modules', '.bin', 'openspec'));

    const missing = locateOpenspecCli(dir, { ...bare, configured: join(dir, 'нет', 'openspec') });
    expect(missing.kind).toBe('not-found');
    if (missing.kind !== 'not-found') return;
    expect(missing.configured).toBe(join(dir, 'нет', 'openspec'));
    const notice = missingCliNotice(missing);
    expect(notice.title).toContain('по заданному пути');
    expect(notice.hint).toContain('openspec.cliPath');
  });

  it('без явного пути подсказка объясняет PATH редактора и называет настройку', () => {
    const missing = locateOpenspecCli(dir, bare);
    if (missing.kind !== 'not-found') throw new Error('ожидался not-found');

    const notice = missingCliNotice(missing);
    expect(notice.configured).toBeNull();
    expect(notice.hint).toContain('Перезапустите VS Code');
    expect(notice.hint).toContain('openspec.cliPath');
  });

  it('скрипт .js принимается без признака исполняемости — его запускает Node', () => {
    const script = join(dir, 'cli', 'bin', 'openspec.js');
    mkdirSync(join(script, '..'), { recursive: true });
    writeFileSync(script, 'console.log(1)\n');
    chmodSync(script, 0o644);

    expect(locateOpenspecCli(dir, { ...bare, configured: script }).kind).toBe('found');
  });
});

describe('пути для Windows', () => {
  const windows = { env: { USERPROFILE: 'C:\\Users\\dev' }, platform: 'win32' as const, pathExt: '.EXE;.CMD' };

  it('путь Git Bash из `which openspec` переводится в путь Windows с расширениями PATHEXT', () => {
    expect(configuredCandidates('/c/Users/dev/AppData/Roaming/npm/openspec', 'D:\\proj', windows)).toEqual([
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\openspec.exe',
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\openspec.cmd',
    ]);
  });

  it('путь с расширением и в кавычках берётся как есть, ~ раскрывается', () => {
    expect(configuredCandidates('"C:\\tools\\openspec.cmd"', 'D:\\proj', windows)).toEqual(['C:\\tools\\openspec.cmd']);
    expect(configuredCandidates('~\\bin\\openspec.cmd', 'D:\\proj', windows)).toEqual(['C:\\Users\\dev\\bin\\openspec.cmd']);
  });

  it('глобальные каталоги: префикс npm, %APPDATA%\\npm, nvm-windows; имена переменных без учёта регистра', () => {
    const dirs = globalBinDirs(
      { appdata: 'C:\\Users\\dev\\AppData\\Roaming', NVM_SYMLINK: 'C:\\nvm4w\\nodejs', npm_config_prefix: 'D:\\npm' },
      'win32',
    );
    expect(dirs.slice(0, 3)).toEqual(['D:\\npm', 'C:\\Users\\dev\\AppData\\Roaming\\npm', 'C:\\nvm4w\\nodejs']);
  });

  it('на POSIX — bin префикса npm и домашние каталоги', () => {
    const dirs = globalBinDirs({ HOME: '/home/dev', npm_config_prefix: '/opt/npm' }, 'linux');
    expect(dirs).toContain('/opt/npm/bin');
    expect(dirs).toContain('/home/dev/.npm-global/bin');
    expect(dirs).toContain('/home/dev/.volta/bin');
  });
});
