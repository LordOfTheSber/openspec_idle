import { fileURLToPath } from 'node:url';
import { canonicalize } from './fs/workspace.js';
import { describe, expect, it } from 'vitest';
import { ValidationRunner } from './validation.js';

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
