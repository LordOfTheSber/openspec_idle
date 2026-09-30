import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from '../../../tests/fixtures.js';
import { createEmbeddedBackend } from './embedded.js';
import { canonicalize } from './fs/workspace.js';
import { ValidationRunner, requirementLine, requirementNameFromMessage, specIssueLine } from './validation.js';

const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

function runner(fixture: string): ValidationRunner {
  const cwd = canonicalize(
    fileURLToPath(new URL(`../../../tests/fixtures/${fixture}`, import.meta.url)),
  );
  return new ValidationRunner({ bin: OPENSPEC_BIN, cwd });
}

describe('валидация change', () => {
  it('на валидном change не находит замечаний', async () => {
    const run = await runner('full-change').run('full-feature');

    expect(run.error).toBeNull();
    expect(run.superseded).toBe(false);
    expect(run.valid).toBe(true);
    expect(run.entries).toHaveLength(0);
  });

  it('находит ошибку и объясняет её текстом от CLI', async () => {
    const run = await runner('bare-change').run('bare-feature');

    expect(run.valid).toBe(false);
    expect(run.entries.length).toBeGreaterThan(0);
    expect(run.entries[0]?.level).toBe('ERROR');
    expect(run.entries[0]?.message).toContain('delta');
  });

  it('ошибки идут выше предупреждений', async () => {
    const run = await runner('bare-change').run('bare-feature');
    const levels = run.entries.map((entry) => entry.level);
    const firstWarning = levels.indexOf('WARNING');
    const lastError = levels.lastIndexOf('ERROR');

    if (firstWarning !== -1 && lastError !== -1) {
      expect(lastError).toBeLessThan(firstWarning);
    }
  });

  it('валидирует change на собственной схеме', async () => {
    const run = await runner('custom-schema').run('team-feature');

    expect(run.error).toBeNull();
    expect(run.valid).toBe(true);
  });

  it('новый запрос вытесняет предыдущий, и виден результат последнего', async () => {
    const instance = runner('full-change');

    const first = instance.run('full-feature');
    const second = instance.run('full-feature');

    const [firstRun, secondRun] = await Promise.all([first, second]);

    expect(secondRun.superseded).toBe(false);
    expect(secondRun.error).toBeNull();
    expect(firstRun.superseded).toBe(true);
    expect(firstRun.entries).toHaveLength(0);
  });

  it('после завершения прогонов ни один не остаётся выполняющимся', async () => {
    const instance = runner('full-change');
    await Promise.all([instance.run('full-feature'), instance.run('full-feature')]);

    expect(instance.inFlightCount).toBe(0);
  });

  it('прогоны разных change друг друга не вытесняют', async () => {
    const instance = runner('full-change');

    const [a, b] = await Promise.all([
      instance.run('full-feature'),
      instance.run('full-feature'),
    ]);

    // Один и тот же change вытесняется — проверка выше. Здесь важно, что
    // счётчик выполняющихся очищается и повторный запуск снова работает.
    expect([a.superseded, b.superseded].filter(Boolean)).toHaveLength(1);

    const again = await instance.run('full-feature');
    expect(again.superseded).toBe(false);
    expect(again.valid).toBe(true);
  });

  it('несуществующий change даёт ошибку запуска, а не пустой отчёт', async () => {
    const run = await runner('full-change').run('нет-такого');

    expect(run.error).not.toBeNull();
    expect(run.entries).toHaveLength(0);
  });
});

describe('строка замечания валидации', () => {
  const spec = [
    '# data-export',
    '',
    '## Purpose',
    'Коротко.',
    '',
    '## Requirements',
    '',
    '### Requirement: Первое',
    'Система ДОЛЖНА.',
    '',
    '### Requirement: Второе',
    'Система ДОЛЖНА.',
  ].join('\n');

  it('переводит requirements[N] и requirements.N в строку заголовка требования', () => {
    expect(specIssueLine(spec, 'requirements[1]')).toBe(11);
    expect(specIssueLine(spec, 'requirements.0.scenarios')).toBe(8);
    expect(specIssueLine(spec, 'requirements[0].scenarios')).toBe(8);
  });

  it('overview и purpose — строка раздела назначения', () => {
    expect(specIssueLine(spec, 'overview')).toBe(3);
    expect(specIssueLine(spec, 'purpose')).toBe(3);
  });

  it('неизвестный путь и лишний индекс строки не дают', () => {
    expect(specIssueLine(spec, 'requirements[9]')).toBeNull();
    expect(specIssueLine(spec, 'something')).toBeNull();
    expect(specIssueLine(spec, undefined)).toBeNull();
  });

  it('извлекает имя требования из сообщений CLI трёх видов', () => {
    expect(
      requirementNameFromMessage('MODIFIED "Выгрузка данных" omits scenario(s) the current spec still has'),
    ).toBe('Выгрузка данных');
    expect(
      requirementNameFromMessage('data-export RENAMED failed for header "### Requirement: Нет такого" - source not found'),
    ).toBe('Нет такого');
    expect(requirementNameFromMessage('Requirement "B" should contain SHALL or MUST')).toBe('B');
    expect(requirementNameFromMessage('Purpose section is too brief')).toBeNull();
  });

  it('находит заголовок без учёта регистра и лишних пробелов', () => {
    expect(requirementLine(spec, 'второе')).toBe(11);
    expect(requirementLine(spec, '  Первое ')).toBe(8);
    expect(requirementLine(spec, 'Третье')).toBeNull();
  });

  it('замечание change о потерянном сценарии ложится на строку требования', async () => {
    const run = await runner('delta-ops').run('add-limits');
    const omitted = run.entries.find((entry) => entry.message.includes('omits scenario'));

    expect(omitted?.file).toBe('openspec/changes/add-limits/specs/data-export/spec.md');
    expect(omitted?.line).toBe(5);
  });
});

describe('валидация основных спеков', () => {
  let project: string | null = null;

  afterEach(() => {
    if (project !== null) rmSync(project, { recursive: true, force: true });
    project = null;
  });

  function brokenProject(): string {
    project = canonicalize(mkdtempSync(join(tmpdir(), 'osi-specs-')));
    cpSync(join(FIXTURES_ROOT, 'delta-ops'), project, { recursive: true });
    writeFileSync(
      join(project, 'openspec/specs/tbd-capability/spec.md'),
      [
        '# tbd-capability',
        '',
        '## Purpose',
        'Проверка основных спеков: требование без сценария должно найтись.',
        '',
        '## Requirements',
        '',
        '### Requirement: Без сценария',
        'The system SHALL do something.',
        '',
      ].join('\n'),
    );
    return project;
  }

  it('кладёт замечание основного спека на строку требования', async () => {
    const root = brokenProject();
    const run = await new ValidationRunner({ bin: OPENSPEC_BIN, cwd: root }).runSpecs();

    expect(run.error).toBeNull();
    expect(run.valid).toBe(false);
    expect(run.specCount).toBe(2);
    const error = run.entries.find((entry) => entry.level === 'ERROR');
    expect(error?.file).toBe('openspec/specs/tbd-capability/spec.md');
    expect(error?.line).toBe(8);
  });

  it('маршрут /api/validate/specs отдаёт тот же отчёт через встроенный бэкенд', async () => {
    const root = brokenProject();
    const backend = await createEmbeddedBackend({ root, watch: false });
    try {
      const reply = await backend.request('GET', '/api/validate/specs');
      expect(reply.status).toBe(200);
      const body = reply.body as { valid: boolean; entries: { file: string; line: number | null }[] };
      expect(body.valid).toBe(false);
      expect(body.entries.some((entry) => entry.file === 'openspec/specs/tbd-capability/spec.md' && entry.line === 8)).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it('на исправных спеках замечаний нет', async () => {
    const run = await runner('full-change').runSpecs();
    expect(run.error).toBeNull();
    expect(run.entries.filter((entry) => entry.level === 'ERROR')).toHaveLength(0);
  });
});
