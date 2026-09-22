import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseTrackedDocument } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { canonicalize } from './fs/workspace.js';
import { OpenspecClient } from './openspec/client.js';
import { SchemaReader } from './schemaDefinition.js';

const execFileAsync = promisify(execFile);
const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

function fixtureRoot(name: string): string {
  return canonicalize(fileURLToPath(new URL(`../../../tests/fixtures/${name}`, import.meta.url)));
}

interface CliChange {
  readonly name: string;
  readonly completedTasks: number;
  readonly totalTasks: number;
}

async function cliChanges(fixture: string): Promise<CliChange[]> {
  const { stdout } = await execFileAsync(OPENSPEC_BIN, ['list', '--json'], {
    cwd: fixtureRoot(fixture),
    env: { ...process.env, NO_COLOR: '1' },
  });
  return (JSON.parse(stdout) as { changes: CliChange[] }).changes;
}

/**
 * Разбор пунктов — единственное место, где IDE дублирует логику CLI: ей нужны
 * отдельные пункты с позициями, а CLI отдаёт только счётчики. Поэтому
 * расхождение должно ловиться автоматически, а не всплывать в интерфейсе.
 */
describe('разбор пунктов совпадает с подсчётом CLI', () => {
  for (const fixture of ['full-change', 'custom-schema', 'messy-tasks', 'bare-change']) {
    it(`на фикстуре ${fixture}`, async () => {
      const root = fixtureRoot(fixture);
      const client = new OpenspecClient({ root, bin: OPENSPEC_BIN });
      const schemas = new SchemaReader(client);

      for (const change of await cliChanges(fixture)) {
        const status = await client.status(change.name);
        expect(status.ok).toBe(true);
        if (!status.ok) continue;

        const definition = await schemas.read(status.data.schemaName);
        const tracks = definition?.tracks ?? null;
        if (tracks === null) {
          expect(change.totalTasks).toBe(0);
          continue;
        }

        const path = join(status.data.changeRoot, tracks);
        let text: string;
        try {
          text = await readFile(path, 'utf8');
        } catch {
          expect(change.totalTasks).toBe(0);
          continue;
        }

        const parsed = parseTrackedDocument(text);
        expect(parsed.total, `${fixture}/${change.name}: всего`).toBe(change.totalTasks);
        expect(parsed.complete, `${fixture}/${change.name}: выполнено`).toBe(
          change.completedTasks,
        );
      }
    });
  }
});
