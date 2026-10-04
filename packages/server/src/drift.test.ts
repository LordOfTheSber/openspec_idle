import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriftReport } from '@openspec-ide/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from '../../../tests/fixtures.js';
import { createEmbeddedBackend } from './embedded.js';
import { canonicalize } from './fs/workspace.js';

let root: string | null = null;

afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

function project(): string {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-drift-')));
  cpSync(join(FIXTURES_ROOT, 'delta-ops'), root, { recursive: true });
  return root;
}

function git(dir: string, args: string[], date = '2026-09-20T10:00:00Z'): void {
  execFileSync('git', args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Тест',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Тест',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
    stdio: 'ignore',
  });
}

async function report(dir: string): Promise<DriftReport> {
  const backend = await createEmbeddedBackend({ root: dir, watch: false });
  try {
    const reply = await backend.request('GET', '/api/drift');
    expect(reply.status).toBe(200);
    return reply.body as DriftReport;
  } finally {
    await backend.close();
  }
}

const SPEC = 'openspec/specs/data-export/spec.md';

describe('пересечения и устаревание через API', () => {
  it('основной спек изменился после коммита дельты — требование устарело; пересечение двух change', async () => {
    const dir = project();
    git(dir, ['init', '-q']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'начало'], '2026-09-20T10:00:00Z');
    writeFileSync(join(dir, SPEC), readFileSync(join(dir, SPEC), 'utf8').replace('со всеми его данными', 'со всеми его данными и заголовком'));
    git(dir, ['commit', '-q', '-am', 'правка спека'], '2026-09-22T10:00:00Z');

    const body = await report(dir);

    expect(body.git).toBe(true);
    const stale = body.changes['add-limits']?.stale.find((item) => item.requirement === 'Выгрузка данных');
    expect(stale).toMatchObject({ certainty: 'stale', changedScenarios: ['Успешная выгрузка'] });
    expect(stale?.since?.startsWith('2026-09-20T10:00:00')).toBe(true);
    expect(stale?.after).toContain('и заголовком');
    expect(body.overlaps.map((overlap) => [overlap.requirement, overlap.touches.map((touch) => touch.change)])).toEqual([
      ['Выгрузка данных', ['add-limits', 'rework-export']],
    ]);
    expect(body.changes['add-limits']?.overlaps[0]?.others[0]?.change).toBe('rework-export');
  });

  it('незакоммиченная дельта не устарела, активность change — сейчас', async () => {
    const dir = project();
    git(dir, ['init', '-q']);
    git(dir, ['add', 'openspec/specs', 'openspec/config.yaml']);
    git(dir, ['commit', '-q', '-m', 'спеки'], '2026-09-20T10:00:00Z');
    writeFileSync(join(dir, SPEC), readFileSync(join(dir, SPEC), 'utf8').replace('со всеми его данными', 'иначе'));

    const body = await report(dir);

    expect(body.changes['add-limits']?.stale).toEqual([]);
    const activity = Date.parse(body.changes['add-limits']?.lastActivity ?? '');
    expect(Date.now() - activity).toBeLessThan(5 * 60_000);
  });

  it('без git — «возможно устарела» по архиву после даты создания', async () => {
    const dir = project();
    mkdirSync(join(dir, 'openspec/changes/add-limits'), { recursive: true });
    writeFileSync(join(dir, 'openspec/changes/add-limits/.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-09-20\n');
    const archived = join(dir, 'openspec/changes/archive/2026-09-25-tune-export/specs/data-export');
    mkdirSync(archived, { recursive: true });
    writeFileSync(
      join(archived, 'spec.md'),
      '## MODIFIED Requirements\n\n### Requirement: Выгрузка данных\nТекст.\n\n#### Scenario: С\n- **WHEN** a\n- **THEN** b\n',
    );

    const body = await report(dir);

    expect(body.git).toBe(false);
    expect(body.changes['add-limits']?.created).toBe('2026-09-20');
    expect(body.changes['add-limits']?.stale).toEqual([
      expect.objectContaining({ certainty: 'possible', requirement: 'Выгрузка данных', archivedAfter: ['2026-09-25-tune-export'] }),
    ]);
  });
});
