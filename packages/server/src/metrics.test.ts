import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from './board.js';
import { canonicalize } from './fs/workspace.js';
import { MetricsService, UnknownItemError } from './metrics.js';
import { MetricsStore } from './metricsStore.js';
import { OpenspecClient } from './openspec/client.js';
import { SchemaReader } from './schemaDefinition.js';
import { WorkspaceReader } from './workspace.js';

const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

let root: string;
let clock: Date;

function setup(fixture: string): { metrics: MetricsService; client: OpenspecClient } {
  const source = fileURLToPath(new URL(`../../../tests/fixtures/${fixture}`, import.meta.url));
  cpSync(source, root, { recursive: true });
  const client = new OpenspecClient({ root, bin: OPENSPEC_BIN });
  const workspace = new WorkspaceReader(client);
  const board = new BoardService(client, workspace, new SchemaReader(client), OPENSPEC_BIN);
  const metrics = new MetricsService({
    root,
    board,
    workspace,
    store: new MetricsStore(root),
    now: () => clock,
    acceptanceTimeoutMs: 5_000,
  });
  return { metrics, client };
}

function edit(relative: string, transform: (text: string) => string, client: OpenspecClient): void {
  const path = join(root, relative);
  writeFileSync(path, transform(readFileSync(path, 'utf8')));
  client.invalidate();
}

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-metrics-')));
  clock = new Date('2026-03-01T10:00:00.000Z');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('метрики пунктов на встроенной схеме', () => {
  it('отдаёт пункты tasks.md с идентификаторами change/группа.номер', async () => {
    const { metrics } = setup('full-change');
    const view = await metrics.view('full-feature');

    expect(view.tracked).toBe(true);
    if (!view.tracked) return;
    expect(view.trackedPath).toBe('openspec/changes/full-feature/tasks.md');
    expect(view.items.map((item) => item.id).sort()).toEqual([
      'full-feature/1.1',
      'full-feature/1.2',
      'full-feature/1.3',
      'full-feature/2.1',
    ]);
    expect(view.summary.complete).toBe(2);
    expect(view.summary.total).toBe(4);
    expect(view.summary.schema).toBe('spec-driven');
  });

  it('отметки, стоявшие до начала учёта, не получают выдуманного времени', async () => {
    const { metrics } = setup('full-change');
    const view = await metrics.view('full-feature');
    if (!view.tracked) return;

    const done = view.items.find((item) => item.key === '1.1');
    expect(done?.state).toBe('done');
    expect(done?.doneBeforeTracking).toBe(true);
    expect(done?.completedAt).toBeNull();
  });

  it('отметка в обход IDE попадает в журнал с моментом, когда её заметили', async () => {
    const { metrics, client } = setup('full-change');
    await metrics.view('full-feature');
    await metrics.start('full-feature', '1.3');

    clock = new Date('2026-03-01T11:30:00.000Z');
    edit(
      'openspec/changes/full-feature/tasks.md',
      (text) => text.replace('- [ ] 1.3', '- [x] 1.3'),
      client,
    );

    const view = await metrics.view('full-feature');
    if (!view.tracked) return;
    const item = view.items.find((entry) => entry.key === '1.3');

    expect(item?.state).toBe('done');
    expect(item?.completedAt).toBe('2026-03-01T11:30:00.000Z');
    expect(item?.cycleTimeMs).toBe(90 * 60_000);
  });

  it('метрики записываются в .openspec-ide и не меняют файлов openspec/', async () => {
    const { metrics } = setup('full-change');
    const before = readFileSync(join(root, 'openspec/changes/full-feature/tasks.md'), 'utf8');

    await metrics.view('full-feature');
    await metrics.start('full-feature', '1.3');

    expect(readFileSync(join(root, 'openspec/changes/full-feature/tasks.md'), 'utf8')).toBe(before);
    expect(readFileSync(join(root, '.openspec-ide/runs.jsonl'), 'utf8')).toContain('item-started');
  });

  it('неизвестный пункт даёт понятную ошибку', async () => {
    const { metrics } = setup('full-change');
    await expect(metrics.start('full-feature', '9.9')).rejects.toThrow(UnknownItemError);
  });
});

describe('устойчивость идентификатора на файле', () => {
  it('вставка задачи в начало группы переносит метрики вслед за формулировкой', async () => {
    const { metrics, client } = setup('full-change');
    await metrics.view('full-feature');
    await metrics.recordRun({
      type: 'run-finished',
      at: '2026-03-01T10:10:00.000Z',
      change: 'full-feature',
      item: '1.3',
      runId: 'r1',
      outcome: 'success',
      startedAt: '2026-03-01T10:05:00.000Z',
      durationMs: 300_000,
      tokensIn: 4000,
      tokensOut: 1000,
      toolCalls: 12,
      files: ['src/limit.ts'],
    });

    edit(
      'openspec/changes/full-feature/tasks.md',
      (text) =>
        text.replace(
          '## 1. Выгрузка\n\n',
          '## 1. Выгрузка\n\n- [ ] 1.0 Новая задача перед всеми и проверить её тестом\n',
        ),
      client,
    );

    const view = await metrics.view('full-feature');
    if (!view.tracked) return;
    const limit = view.items.find((item) => item.text.includes('Ограничить время'));
    expect(limit?.key).toBe('1.4');
    expect(limit?.tokens).toBe(5000);
    expect(limit?.files).toEqual(['src/limit.ts']);

    const journal = readFileSync(join(root, '.openspec-ide/runs.jsonl'), 'utf8');
    expect(journal).toContain('item-renumbered');
  });

  it('удалённая из файла задача сохраняет метрики отдельно и не входит в сводку', async () => {
    const { metrics, client } = setup('full-change');
    await metrics.view('full-feature');
    await metrics.recordRun({
      type: 'run-finished',
      at: '2026-03-01T10:10:00.000Z',
      change: 'full-feature',
      item: '2.1',
      runId: 'r1',
      outcome: 'success',
      startedAt: '2026-03-01T10:05:00.000Z',
      durationMs: 1000,
      tokensIn: 100,
      tokensOut: 100,
      toolCalls: 1,
      files: [],
    });

    edit(
      'openspec/changes/full-feature/tasks.md',
      (text) => text.replace(/- \[ \] 2\.1[^\n]*\n/, ''),
      client,
    );

    const view = await metrics.view('full-feature');
    if (!view.tracked) return;
    expect(view.removed).toHaveLength(1);
    expect(view.removed[0]?.tokens).toBe(200);
    expect(view.summary.total).toBe(3);
    expect(view.summary.removed).toBe(1);
    expect(view.summary.tokensTotal).toBeNull();
  });
});

describe('приёмка', () => {
  it('нулевой код возврата засчитывает приёмку, ненулевой — нет', async () => {
    const { metrics } = setup('full-change');
    await metrics.view('full-feature');

    await metrics.bindAcceptance('full-feature', '1.3', 'exit 0');
    const passed = await metrics.runAcceptance('full-feature', '1.3');
    expect(passed.exitCode).toBe(0);

    await metrics.bindAcceptance('full-feature', '1.2', 'echo упало; exit 3');
    const failed = await metrics.runAcceptance('full-feature', '1.2');
    expect(failed.exitCode).toBe(3);
    expect(failed.output).toContain('упало');

    const view = await metrics.view('full-feature');
    if (!view.tracked) return;
    expect(view.items.find((item) => item.key === '1.3')?.acceptance.passed).toBe(true);
    expect(view.items.find((item) => item.key === '1.2')?.acceptance.passed).toBe(false);
  });

  it('выполненный пункт с красной проверкой помечается расхождением', async () => {
    const { metrics } = setup('full-change');
    await metrics.view('full-feature');

    // 1.2 уже отмечен выполненным в фикстуре.
    await metrics.bindAcceptance('full-feature', '1.2', 'exit 1');
    await metrics.runAcceptance('full-feature', '1.2');

    const view = await metrics.view('full-feature');
    if (!view.tracked) return;
    expect(view.items.find((item) => item.key === '1.2')?.acceptanceMismatch).toBe(true);
    expect(view.summary.acceptanceMismatches).toBe(1);
  });

  it('проверка, превысившая предел времени, считается непройденной', async () => {
    const { metrics } = setup('full-change');
    await metrics.view('full-feature');
    await metrics.bindAcceptance('full-feature', '1.3', 'sleep 30');

    const result = await metrics.runAcceptance('full-feature', '1.3');

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 20_000);

  it('проверка выполняется в корне рабочего пространства', async () => {
    const { metrics } = setup('full-change');
    await metrics.view('full-feature');
    await metrics.bindAcceptance('full-feature', '1.3', 'test -d openspec/changes/full-feature');

    expect((await metrics.runAcceptance('full-feature', '1.3')).exitCode).toBe(0);
  });

  it('без привязанной команды проверка не запускается', async () => {
    const { metrics } = setup('full-change');
    await metrics.view('full-feature');

    await expect(metrics.runAcceptance('full-feature', '1.3')).rejects.toThrow(
      /не привязана команда/,
    );
  });
});

describe('собственная схема', () => {
  it('пункты берутся из объявленного схемой plan.md', async () => {
    const { metrics } = setup('custom-schema');
    const view = await metrics.view('team-feature');

    expect(view.tracked).toBe(true);
    if (!view.tracked) return;
    expect(view.trackedPath).toBe('openspec/changes/team-feature/plan.md');
    expect(view.summary.total).toBe(3);
    expect(view.summary.schema).toBe('team-flow');
  });

  it('схема без отслеживаемого артефакта: метрики не ведутся, причина объяснена', async () => {
    const { metrics } = setup('custom-schema');
    edit(
      'openspec/schemas/team-flow/schema.yaml',
      (text) => text.replace(/ {2}tracks: plan\.md\n/, ''),
      { invalidate: () => undefined } as unknown as OpenspecClient,
    );

    const view = await metrics.view('team-feature');

    expect(view.tracked).toBe(false);
    if (view.tracked) return;
    expect(view.reason).toContain('apply.tracks');
  });
});

describe('экспорт', () => {
  it('содержит версию схемы данных, метрики пунктов и сводку', async () => {
    const { metrics } = setup('full-change');
    const exported = await metrics.export('full-feature');

    expect(exported.schemaVersion).toBe(1);
    expect(exported.changes).toHaveLength(1);
    expect(exported.changes[0]?.summary.total).toBe(4);
    expect(exported.changes[0]?.items).toHaveLength(4);
    expect(exported.changes[0]?.archived).toBe(false);
  });

  it('по всему пространству помечает архивные changes', async () => {
    const { metrics, client } = setup('full-change');
    await metrics.view('full-feature');

    // Архивируем через CLI: события change остаются в журнале.
    edit(
      'openspec/changes/full-feature/tasks.md',
      (text) => text.replace(/- \[ \]/g, '- [x]'),
      client,
    );
    await metrics.view('full-feature');
    const { execFileSync } = await import('node:child_process');
    execFileSync(OPENSPEC_BIN, ['archive', 'full-feature', '--yes'], { cwd: root });
    client.invalidate();

    const exported = await metrics.export();
    const entry = exported.changes.find((item) => item.change === 'full-feature');

    expect(entry?.archived).toBe(true);
    expect(entry?.summary.complete).toBe(4);
  });
});
