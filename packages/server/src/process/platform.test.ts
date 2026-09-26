import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UnsafeShellArgumentError,
  executableCandidates,
  parseShim,
  resolveCommand,
  shimTarget,
  spawnPlan,
  spawnShell,
  spawnTree,
  toPosixPath,
} from './platform.js';

/** Обёртка, которую npm (cmd-shim) кладёт в node_modules/.bin на Windows. */
const NPM_BIN_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\@fission-ai\\openspec\\bin\\openspec.js" %*
`;

let dir: string | null = null;

afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('запуск на Windows', () => {
  it('из обёртки npm извлекается запускаемый скрипт', () => {
    expect(shimTarget('C:\\work\\proj\\node_modules\\.bin\\openspec.cmd', NPM_BIN_SHIM)).toBe(
      'C:\\work\\proj\\node_modules\\@fission-ai\\openspec\\bin\\openspec.js',
    );
  });

  it('глобальная обёртка npm тоже разбирается', () => {
    const global = NPM_BIN_SHIM.replace(
      '%dp0%\\..\\@fission-ai\\openspec\\bin\\openspec.js',
      '%dp0%\\node_modules\\@gigacode\\cli\\dist\\index.js',
    );
    expect(shimTarget('C:\\Users\\me\\AppData\\Roaming\\npm\\gigacode.cmd', global)).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@gigacode\\cli\\dist\\index.js',
    );
  });

  it('обёртка без скрипта не распознаётся', () => {
    expect(shimTarget('C:\\x\\tool.cmd', '@echo off\r\ntool.exe %*')).toBeNull();
  });

  it('обёртка установщика со своим node.exe и %~dp0 без косой черты', () => {
    const shim = '@echo off\r\nsetlocal\r\n"%~dp0node\\node.exe" --no-warnings "%~dp0lib\\cli.js" --channel stable %*\r\n';
    expect(parseShim('C:\\Program Files\\GigaCLI\\gigacode.cmd', shim)).toEqual({
      kind: 'node',
      node: 'C:\\Program Files\\GigaCLI\\node\\node.exe',
      args: ['--no-warnings', 'C:\\Program Files\\GigaCLI\\lib\\cli.js', '--channel', 'stable'],
    });
  });

  it('переменные из SET и путь без кавычек', () => {
    const shim = [
      '@ECHO OFF',
      'SET "GIGA_HOME=%~dp0"',
      'set NODE_EXE=%GIGA_HOME%\\runtime\\node.exe',
      'REM запуск',
      '%NODE_EXE% %GIGA_HOME%\\app\\index.mjs %*',
    ].join('\r\n');
    expect(parseShim('C:\\Tools\\Giga\\gigacode.cmd', shim)).toEqual({
      kind: 'node',
      node: 'C:\\Tools\\Giga\\runtime\\node.exe',
      args: ['C:\\Tools\\Giga\\app\\index.mjs'],
    });
  });

  it('обёртка, вызывающая .exe, запускает его напрямую', () => {
    const shim = '@echo off\r\ncall "%~dp0bin\\gigacode.exe" %*\r\nexit /b %ERRORLEVEL%';
    expect(parseShim('C:\\Program Files\\GigaCLI\\gigacode.cmd', shim)).toEqual({
      kind: 'exe',
      exe: 'C:\\Program Files\\GigaCLI\\bin\\gigacode.exe',
      args: [],
    });
  });

  it('скрипт через node из PATH и неизвестная переменная', () => {
    expect(parseShim('C:\\g\\g.cmd', 'node "%~dp0\\dist\\cli.cjs" %*')).toEqual({
      kind: 'node',
      node: null,
      args: ['C:\\g\\dist\\cli.cjs'],
    });
    expect(parseShim('C:\\g\\g.cmd', '"%UNKNOWN_HOME%\\cli.js" %*')).toBeNull();
    expect(parseShim('C:\\g\\g.cmd', 'powershell -File "%~dp0g.ps1" %*')).toBeNull();
  });

  it('нераспознанная обёртка запускается через cmd.exe с закавыченными аргументами', () => {
    dir = mkdtempSync(join(tmpdir(), 'osi-shim-'));
    const shim = join(dir, 'odd tool.cmd');
    writeFileSync(shim, '@echo off\r\npowershell -File "%~dp0g.ps1" %*\r\n');

    const plan = spawnPlan(shim, ['Follow the task.', '--approval-mode', 'plan', 'a&b'], 'win32');
    expect(plan.verbatim).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]).toBe(`""${shim}" "Follow the task." --approval-mode plan "a&b""`);
    expect(() => spawnPlan(shim, ['строка 1\nстрока 2'], 'win32')).toThrow(UnsafeShellArgumentError);
    expect(() => spawnPlan(shim, ['100%'], 'win32')).toThrow(UnsafeShellArgumentError);
  });

  it('имя дополняется расширениями PATHEXT, файл без расширения не предлагается', () => {
    expect(executableCandidates('C:\\bin', 'gigacode', 'win32', '.EXE;.CMD')).toEqual([
      'C:\\bin\\gigacode.exe',
      'C:\\bin\\gigacode.cmd',
    ]);
    expect(executableCandidates('C:\\bin', 'gigacode.cmd', 'win32', '.EXE;.CMD')).toEqual(['C:\\bin\\gigacode.cmd']);
    expect(executableCandidates('/usr/bin', 'gigacode', 'linux')).toEqual(['/usr/bin/gigacode']);
  });

  it('обёртка .cmd запускается через Node без cmd.exe', () => {
    dir = mkdtempSync(join(tmpdir(), 'osi-shim-'));
    const shim = join(dir, 'openspec.cmd');
    writeFileSync(shim, NPM_BIN_SHIM);
    const resolved = resolveCommand(shim, 'win32');
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.prefix[0]).toMatch(/@fission-ai\\openspec\\bin\\openspec\.js$/);
  });
});

describe('запуск на любой платформе', () => {
  it('js-файл запускается текущим Node', () => {
    expect(resolveCommand('/opt/tool/cli.mjs')).toEqual({ command: process.execPath, prefix: ['/opt/tool/cli.mjs'] });
  });

  it('многострочный аргумент доходит до скрипта целиком', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osi-spawn-'));
    const script = join(dir, 'echo.mjs');
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    chmodSync(script, 0o755);
    const child = spawnTree(script, ['строка 1\nстрока "2"', '--flag'], { cwd: dir, env: process.env });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    await new Promise((resolve) => child.on('close', resolve));
    expect(JSON.parse(out)).toEqual(['строка 1\nстрока "2"', '--flag']);
  });

  it('текст для стандартного ввода доходит до программы целиком', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osi-spawn-'));
    const script = join(dir, 'cat.mjs');
    writeFileSync(script, 'let t = "";process.stdin.on("data", (c) => (t += c)).on("end", () => process.stdout.write(t));');
    const child = spawnTree(script, [], { cwd: dir, env: process.env, stdin: 'строка 1\nстрока "2" 100%' });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    await new Promise((resolve) => child.on('close', resolve));
    expect(out).toBe('строка 1\nстрока "2" 100%');
  });

  it('команда оболочки выполняется оболочкой платформы', async () => {
    const child = spawnShell('echo ok', { cwd: tmpdir(), env: process.env });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(out.trim()).toBe('ok');
  });

  it('пути для интерфейса — с прямыми слэшами', () => {
    expect(toPosixPath('specs/a/spec.md')).toBe('specs/a/spec.md');
  });
});
