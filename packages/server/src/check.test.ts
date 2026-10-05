import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from '../../../tests/fixtures.js';
import { CheckUsageError, parseCheckList, runCheck } from './check.js';
import { canonicalize } from './fs/workspace.js';

let root: string | null = null;

afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

function copy(fixture: string): string {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-check-')));
  cpSync(join(FIXTURES_ROOT, fixture), root, { recursive: true });
  return root;
}

describe('проверка проекта для CI', () => {
  it('лишний файл в строгой папке — ошибка structure на самом файле', async () => {
    const dir = copy('full-change');
    writeFileSync(
      join(dir, 'openspec/structure.yaml'),
      'version: 1\nstructure:\n  openspec:\n    structure.yaml: file\n    config.yaml: file\n    changes: "*"\n    specs: "*"\n',
    );
    writeFileSync(join(dir, 'openspec/draft.txt'), 'черновик\n');

    const report = await runCheck({ cwd: join(dir, 'openspec', 'changes'), only: ['structure'] });

    expect(report.root).toBe(dir);
    expect(report.checks).toEqual([expect.objectContaining({ check: 'structure', status: 'failed', errors: 1 })]);
    expect(report.findings[0]).toMatchObject({ check: 'structure', level: 'error', file: 'openspec/draft.txt' });
  });

  it('без описания структуры и без контекста проверки пропускаются', async () => {
    const report = await runCheck({ cwd: copy('full-change'), only: ['structure', 'context', 'schemas'] });

    expect(report.checks.map((check) => [check.check, check.status])).toEqual([
      ['structure', 'skipped'],
      ['context', 'skipped'],
      ['schemas', 'skipped'],
    ]);
    expect(report.checks[0]?.reason).toContain('openspec/structure.yaml');
    expect(report.findings).toEqual([]);
  });

  it('карта контекста: неописанный модуль — ошибка на строке index.md', async () => {
    const report = await runCheck({ cwd: copy('context-map'), only: ['context'] });
    const errors = report.findings.filter((finding) => finding.level === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((finding) => finding.check === 'context' && finding.file?.endsWith('.md'))).toBe(true);
  });

  it('контроль контекста: пустой контекст и пропавший путь — предупреждения, модуль без кода — сведение', async () => {
    const dir = copy('context-map');
    writeFileSync(join(dir, 'openspec/context/modules/master/context.md'), '# sds-master\n\nХранилище — `sds-master/src/main/java/Store.java`.\n');
    writeFileSync(join(dir, 'openspec/context/modules/sds-impl/index.md'), '---\nmodule: sds-impl\ndomains: [replication]\n---\n');

    const report = await runCheck({ cwd: dir, only: ['context'] });

    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: 'warning', file: 'openspec/context/modules/master/context.md', line: 3 }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: 'warning', file: 'openspec/context/modules/sds-impl/context.md', line: null }),
    );
    expect(report.findings).toContainEqual(expect.objectContaining({ level: 'info', file: 'openspec/context/modules/sds-impl/index.md' }));
    expect(report.checks).toEqual([expect.objectContaining({ check: 'context', status: 'passed', infos: 1 })]);
  });

  it('дельты и план: несуществующее требование, непокрытый сценарий и пересечение', async () => {
    const report = await runCheck({ cwd: copy('delta-ops'), only: ['authoring', 'coverage', 'drift'] });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        check: 'authoring',
        level: 'error',
        file: 'openspec/changes/rework-export/specs/data-export/spec.md',
        line: 16,
      }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ check: 'coverage', level: 'warning', file: 'openspec/changes/add-limits/specs/data-export/spec.md' }),
    );
    expect(report.findings.filter((finding) => finding.check === 'drift' && finding.message.includes('Выгрузка данных'))).toHaveLength(2);
    expect(report.checks.find((check) => check.check === 'coverage')?.status).toBe('passed');
  });

  it('quality: замечания качества с правилом, реестр кодов, порог метрики и метрики в итоге', async () => {
    const dir = copy('full-change');
    writeFileSync(
      join(dir, 'openspec/changes/full-feature/specs/data-export/spec.md'),
      [
        '# Spec Delta: data-export',
        '',
        '## ADDED Requirements',
        '',
        '### Requirement: Выгрузка данных',
        '',
        'Система ДОЛЖНА (SHALL) выгружать данные в валидном формате CSV и отклонять выгрузку чужих данных с кодом `EXPORT_FORBIDDEN`.',
        '',
        '#### Scenario: Успешная выгрузка',
        '',
        '- **WHEN** пользователь запрашивает выгрузку',
        '- **THEN** отдаётся файл CSV со всеми его данными',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'ErrorCode.txt'), 'EXPORT_FORBIDDEN\nEXPORT_TOO_LARGE\n');
    writeFileSync(
      join(dir, 'openspec/quality.yaml'),
      'version: 1\nerrorCodes:\n  registry: [ErrorCode.txt]\nthresholds:\n  errorCodeTraceability: 1\n',
    );

    const report = await runCheck({ cwd: dir, only: ['quality'] });
    const delta = 'openspec/changes/full-feature/specs/data-export/spec.md';

    expect(report.findings).toContainEqual(
      expect.objectContaining({ check: 'quality', level: 'warning', file: delta, line: 7, message: expect.stringMatching(/«валидном».*\(vague-wording\)$/) }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ check: 'quality', level: 'warning', file: delta, line: 7, message: expect.stringMatching(/EXPORT_FORBIDDEN.*\(error-code-trace\)$/) }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ check: 'quality', level: 'info', file: 'ErrorCode.txt', line: 2, message: expect.stringContaining('EXPORT_TOO_LARGE') }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ check: 'quality', level: 'error', file: 'openspec/quality.yaml', line: 5, message: expect.stringContaining('ниже порога 100 %') }),
    );
    expect(report.checks).toEqual([
      expect.objectContaining({ check: 'quality', status: 'failed', metrics: expect.objectContaining({ errorCodeTraceability: 0 }) }),
    ]);
  });

  it('quality: ошибка в настройках — на строке ключа', async () => {
    const dir = copy('full-change');
    writeFileSync(join(dir, 'openspec/quality.yaml'), 'version: 1\nrules:\n  nope: warning\n');
    const report = await runCheck({ cwd: dir, only: ['quality'] });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: 'error', file: 'openspec/quality.yaml', line: 3, message: expect.stringContaining('неизвестное правило «nope»') }),
    );
  });

  it('validate: замечания changes и основных спеков со строками', async () => {
    const report = await runCheck({ cwd: copy('delta-ops'), only: ['validate'] });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ check: 'validate', level: 'error', file: 'openspec/changes/rework-export/specs/data-export/spec.md', line: 5 }),
    );
  });

  it('ошибки запуска: неизвестная проверка, нет корня OpenSpec, нет CLI', async () => {
    expect(() => parseCheckList('structure,nope')).toThrow(CheckUsageError);
    const empty = canonicalize(mkdtempSync(join(tmpdir(), 'osi-check-none-')));
    try {
      await expect(runCheck({ cwd: empty })).rejects.toThrow(/нет каталога openspec/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const dir = copy('full-change');
    await expect(runCheck({ cwd: dir, only: ['validate'], cliPath: join(dir, 'нет-cli') })).rejects.toThrow(/Не найден CLI OpenSpec/);
    // Проверкам по файлам CLI не нужен.
    const report = await runCheck({ cwd: dir, only: ['structure'], cliPath: join(dir, 'нет-cli') });
    expect(report.checks[0]?.status).toBe('skipped');
  });
});
