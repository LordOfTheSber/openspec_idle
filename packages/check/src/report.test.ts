import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckReport } from '@openspec-ide/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from '../../../tests/fixtures.js';
// @ts-expect-error — модуль сборки на JavaScript без объявлений типов.
import { bundleCheck } from '../bundle.mjs';
import { main } from './cli.js';
import { exitCode, formatGithub, formatJson, formatText, parseArgs } from './report.js';

const REPORT: CheckReport = {
  root: '/p',
  findings: [
    { check: 'coverage', level: 'warning', file: 'openspec/changes/a/specs/x/spec.md', line: 12, message: 'Сценарий не покрыт' },
    { check: 'authoring', level: 'error', file: 'openspec/changes/a/specs/x/spec.md', line: 5, message: 'Нет требования:\nвторая строка, 100%' },
    { check: 'validate', level: 'info', file: null, line: null, message: 'Сведение' },
  ],
  checks: [
    { check: 'authoring', status: 'failed', reason: null, errors: 1, warnings: 0, infos: 0 },
    { check: 'coverage', status: 'passed', reason: null, errors: 0, warnings: 1, infos: 0 },
    { check: 'structure', status: 'skipped', reason: 'нет openspec/structure.yaml', errors: 0, warnings: 0, infos: 0 },
  ],
};

describe('аргументы команды', () => {
  it('разбирает параметры с пробелом и через =', () => {
    expect(parseArgs(['--only', 'structure,context', '--format=github', '--fail-on', 'warning', '--root', 'x'])).toMatchObject({
      only: ['structure', 'context'],
      format: 'github',
      failOn: 'warning',
      root: 'x',
    });
  });

  it('неизвестный параметр, формат или проверка — ошибка запуска', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Неизвестный параметр/);
    expect(() => parseArgs(['--format', 'xml'])).toThrow(/Неизвестный формат/);
    expect(() => parseArgs(['--skip', 'lint'])).toThrow(/Неизвестная проверка/);
    expect(() => parseArgs(['--only'])).toThrow(/нужно значение/);
  });
});

describe('отчёт и код завершения', () => {
  it('код 1 при ошибке, при одних предупреждениях — только с --fail-on warning', () => {
    expect(exitCode(REPORT, 'error')).toBe(1);
    const warningsOnly = { ...REPORT, findings: REPORT.findings.filter((finding) => finding.level !== 'error') };
    expect(exitCode(warningsOnly, 'error')).toBe(0);
    expect(exitCode(warningsOnly, 'warning')).toBe(1);
    expect(exitCode({ ...REPORT, findings: [] }, 'info')).toBe(0);
  });

  it('text: ошибки первыми, путь:строка, итог по проверкам', () => {
    const text = formatText(REPORT, 'error');
    const lines = text.split('\n');
    expect(lines[0]).toBe('openspec/changes/a/specs/x/spec.md:5: ошибка: Нет требования: вторая строка, 100% [authoring]');
    expect(lines[1]).toBe('openspec/changes/a/specs/x/spec.md:12: предупреждение: Сценарий не покрыт [coverage]');
    expect(lines[2]).toBe('(проект): сведение: Сведение [validate]');
    expect(text).toContain('structure  пропущена — нет openspec/structure.yaml');
    expect(text).toContain('Ошибок: 1, предупреждений: 1, сведений: 1. Порог --fail-on error: проверка не пройдена.');
  });

  it('text: метрики проверки качества — строкой под её итогом', () => {
    const report: CheckReport = {
      ...REPORT,
      checks: [
        {
          check: 'quality',
          status: 'passed',
          reason: null,
          errors: 0,
          warnings: 0,
          infos: 0,
          metrics: { errorCodeTraceability: 1, branchCoverage: 0.5, boundaryCoverage: null, ambiguityDensity: 0.25 },
        },
      ],
    };
    expect(formatText(report, 'error')).toContain(
      'quality  пройдена\n           трассируемость кодов ошибок 100 %, покрытие ветвлений 50 %, покрытие границ —, расплывчатых слов на 100 0,25',
    );
  });

  it('github: аннотации с файлом и строкой, перевод строки и % экранированы, итог со счётчиками', () => {
    const lines = formatGithub(REPORT, 'error').split('\n');
    expect(lines[0]).toBe(
      '::error file=openspec/changes/a/specs/x/spec.md,line=5,title=openspec-ide/authoring::Нет требования:%0Aвторая строка, 100%25',
    );
    expect(lines[1]).toBe('::warning file=openspec/changes/a/specs/x/spec.md,line=12,title=openspec-ide/coverage::Сценарий не покрыт');
    expect(lines[2]).toBe('::notice title=openspec-ide/validate::Сведение');
    expect(lines.join('\n')).toContain('Ошибок: 1, предупреждений: 1');
  });

  it('json: один объект с замечаниями, итогом и кодом', () => {
    const parsed = JSON.parse(formatJson(REPORT, 'warning')) as { findings: unknown[]; checks: unknown[]; exitCode: number; failOn: string };
    expect(parsed.findings).toHaveLength(3);
    expect(parsed.checks).toHaveLength(3);
    expect(parsed).toMatchObject({ exitCode: 1, failOn: 'warning' });
  });
});

describe('команда целиком', () => {
  let bundleDir: string;
  let project: string;

  beforeAll(async () => {
    bundleDir = mkdtempSync(join(tmpdir(), 'osi-check-bundle-'));
    await bundleCheck(join(bundleDir, 'openspec-ide-check.mjs'));
    project = mkdtempSync(join(tmpdir(), 'osi-check-project-'));
    cpSync(join(FIXTURES_ROOT, 'full-change'), project, { recursive: true });
    writeFileSync(
      join(project, 'openspec/structure.yaml'),
      'version: 1\nstructure:\n  openspec:\n    structure.yaml: file\n    config.yaml: file\n    changes: "*"\n    specs: "*"\n',
    );
  }, 120_000);

  afterAll(() => {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('собранный файл вне репозитория проверяет проект: 0 без нарушений, 1 с нарушением', () => {
    const run = (): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [join(bundleDir, 'openspec-ide-check.mjs'), '--only', 'structure'], {
        cwd: project,
        encoding: 'utf8',
        timeout: 60_000,
      });

    const clean = run();
    expect(clean.status, String(clean.stderr)).toBe(0);
    expect(String(clean.stdout)).toContain('structure  пройдена');

    writeFileSync(join(project, 'openspec/draft.txt'), 'черновик\n');
    const broken = run();
    expect(broken.status).toBe(1);
    expect(String(broken.stdout)).toContain('openspec/draft.txt: ошибка:');
  }, 120_000);

  it('--help — справка и код 0, ошибка запуска — код 2', async () => {
    let out = '';
    expect(await main(['--help'], project, (text) => (out += text))).toBe(0);
    expect(out).toContain('Код завершения');
    expect(await main(['--format', 'xml'], project, () => undefined)).toBe(2);
  });
});
