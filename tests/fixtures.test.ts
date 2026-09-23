import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FIXTURES, fixturePath } from './fixtures.js';

const execFileAsync = promisify(execFile);

const OPENSPEC_BIN = fileURLToPath(
  new URL('../node_modules/.bin/openspec', import.meta.url),
);

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function openspec(cwd: string, args: readonly string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(OPENSPEC_BIN, [...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('фикстурные OpenSpec-проекты', () => {
  it('каталог каждой фикстуры существует', () => {
    for (const fixture of FIXTURES) {
      expect(existsSync(`${fixturePath(fixture.dir)}/openspec`), fixture.dir).toBe(true);
    }
  });

  for (const fixture of FIXTURES) {
    describe(`${fixture.dir} — ${fixture.about}`, () => {
      it('CLI разрешает корень на каталоге фикстуры', async () => {
        const { code, stdout } = await openspec(fixturePath(fixture.dir), ['list', '--json']);
        expect(code).toBe(0);
        const parsed = JSON.parse(stdout) as { root: { path: string } | null };
        expect(parsed.root?.path).toBe(fixturePath(fixture.dir));
      });

      if (fixture.change) {
        it('схема change совпадает с ожидаемой', async () => {
          const { code, stdout } = await openspec(fixturePath(fixture.dir), [
            'status',
            '--change',
            fixture.change,
            '--json',
          ]);
          expect(code).toBe(0);
          const parsed = JSON.parse(stdout) as { schemaName: string };
          expect(parsed.schemaName).toBe(fixture.schema);
        });

        it(`validate --strict ${fixture.validates ? 'проходит' : 'не проходит'}`, async () => {
          const { code } = await openspec(fixturePath(fixture.dir), [
            'validate',
            fixture.change,
            '--strict',
          ]);
          expect(code === 0).toBe(fixture.validates);
        });
      }

      if (fixture.tasks) {
        it('прогресс по отслеживаемому артефакту совпадает с ожидаемым', async () => {
          const { code, stdout } = await openspec(fixturePath(fixture.dir), ['list', '--json']);
          expect(code).toBe(0);
          const parsed = JSON.parse(stdout) as {
            changes: { name: string; completedTasks: number; totalTasks: number }[];
          };
          const entry = parsed.changes.find((c) => c.name === fixture.change);
          expect(entry).toBeDefined();
          expect(entry?.completedTasks).toBe(fixture.tasks?.complete);
          expect(entry?.totalTasks).toBe(fixture.tasks?.total);
        });
      }
    });
  }

  it('фикстура собственной схемы объявляет артефакты, которых нет во встроенной', async () => {
    const { code, stdout } = await openspec(fixturePath('custom-schema'), [
      'status',
      '--change',
      'team-feature',
      '--json',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { artifacts: { id: string }[] };
    const ids = parsed.artifacts.map((a) => a.id);
    expect(ids).toContain('research');
    expect(ids).toContain('spec-review');
    expect(ids).not.toContain('tasks');
  });

  it('собственная схема проходит структурную проверку CLI', async () => {
    const { code } = await openspec(fixturePath('custom-schema'), [
      'schema',
      'validate',
      'team-flow',
    ]);
    expect(code).toBe(0);
  });
});
