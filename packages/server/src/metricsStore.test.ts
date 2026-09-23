import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetricEvent } from '@openspec-ide/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize } from './fs/workspace.js';
import { MetricsStore } from './metricsStore.js';

let root: string;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-store-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const BASELINE: MetricEvent = {
  type: 'baseline',
  at: '2026-03-01T10:00:00.000Z',
  change: 'c',
  items: [
    { key: '1.1', text: 'Первая задача и проверить тестом', done: false },
    { key: '1.2', text: 'Вторая задача и проверить тестом', done: false },
  ],
};

const RUN: MetricEvent = {
  type: 'run-finished',
  at: '2026-03-01T10:05:00.000Z',
  change: 'c',
  item: '1.1',
  runId: 'r1',
  outcome: 'success',
  startedAt: '2026-03-01T10:04:00.000Z',
  durationMs: 60_000,
  tokensIn: 100,
  tokensOut: 50,
  toolCalls: 3,
  files: [],
};

describe('хранилище метрик', () => {
  it('запись события дописывает журнал и не трогает файлы openspec/', async () => {
    mkdirSync(join(root, 'openspec'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
    const store = new MetricsStore(root);

    await store.append([BASELINE, RUN]);

    const journal = readFileSync(store.journalPath, 'utf8').trim().split('\n');
    expect(journal).toHaveLength(2);
    expect(JSON.parse(journal[1] ?? '{}')).toMatchObject({ type: 'run-finished', item: '1.1' });
    expect(readFileSync(join(root, 'openspec', 'config.yaml'), 'utf8')).toBe(
      'schema: spec-driven\n',
    );
  });

  it('первое создание каталога исключает его из системы контроля версий', async () => {
    const messages: string[] = [];
    const store = new MetricsStore(root, (message) => messages.push(message));

    await store.append([BASELINE]);

    expect(readFileSync(join(root, '.openspec-ide', '.gitignore'), 'utf8')).toBe('*\n');
    expect(messages.some((message) => message.includes('исключён'))).toBe(true);
  });

  it('снимок пересобирается из журнала, если его нет', async () => {
    await new MetricsStore(root).append([BASELINE, RUN]);
    rmSync(join(root, '.openspec-ide', 'metrics.json'));

    const store = new MetricsStore(root);
    const state = await store.state();

    expect(store.lastLoad?.recovered).toBe(true);
    expect(state.changes.get('c')?.items.get('1.1')?.runs).toHaveLength(1);
    expect(existsSync(join(root, '.openspec-ide', 'metrics.json'))).toBe(true);
  });

  it('повреждённый снимок пересобирается из журнала', async () => {
    await new MetricsStore(root).append([BASELINE, RUN]);
    writeFileSync(join(root, '.openspec-ide', 'metrics.json'), '{ битый json');

    const store = new MetricsStore(root);
    const state = await store.state();

    expect(store.lastLoad?.recovered).toBe(true);
    expect(state.changes.get('c')?.items.get('1.1')?.runs).toHaveLength(1);
  });

  it('битые строки журнала пропускаются, остальные события применяются', async () => {
    mkdirSync(join(root, '.openspec-ide'), { recursive: true });
    writeFileSync(
      join(root, '.openspec-ide', 'runs.jsonl'),
      [JSON.stringify(BASELINE), '{ оборванная запись', 'не json вовсе', JSON.stringify(RUN)].join(
        '\n',
      ),
    );
    const messages: string[] = [];

    const store = new MetricsStore(root, (message) => messages.push(message));
    const state = await store.state();

    expect(store.lastLoad?.skippedLines).toBe(2);
    expect(state.changes.get('c')?.items.get('1.1')?.runs).toHaveLength(1);
    expect(messages.filter((message) => message.includes('пропущена'))).toHaveLength(2);
  });

  it('отставший снимок догоняется по журналу', async () => {
    const first = new MetricsStore(root);
    await first.append([BASELINE]);
    // Имитация сбоя между дозаписью журнала и обновлением снимка.
    const snapshot = readFileSync(join(root, '.openspec-ide', 'metrics.json'), 'utf8');
    await first.append([RUN]);
    writeFileSync(join(root, '.openspec-ide', 'metrics.json'), snapshot);

    const state = await new MetricsStore(root).state();

    expect(state.changes.get('c')?.items.get('1.1')?.runs).toHaveLength(1);
  });

  it('параллельные дозаписи не перемешивают строки журнала', async () => {
    const store = new MetricsStore(root);
    await store.append([BASELINE]);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append([{ ...RUN, runId: `r${index}`, at: `2026-03-01T11:${String(index).padStart(2, '0')}:00.000Z` }]),
      ),
    );

    const lines = readFileSync(store.journalPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(21);
    expect(lines.every((line) => JSON.parse(line) !== null)).toBe(true);
    const state = await new MetricsStore(root).state();
    expect(state.changes.get('c')?.items.get('1.1')?.runs).toHaveLength(20);
  });

  it('пустое хранилище даёт пустое состояние без восстановления', async () => {
    const store = new MetricsStore(root);
    const state = await store.state();

    expect(state.changes.size).toBe(0);
    expect(store.lastLoad?.recovered).toBe(false);
  });
});
