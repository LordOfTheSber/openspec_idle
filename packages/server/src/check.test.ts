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
