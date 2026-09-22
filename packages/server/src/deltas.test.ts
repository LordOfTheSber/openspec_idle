import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DeltaReader, capabilityFromPath } from './deltas.js';
import { canonicalize } from './fs/workspace.js';
import { OpenspecClient } from './openspec/client.js';
import { WorkspaceReader } from './workspace.js';

const execFileAsync = promisify(execFile);
const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

function fixtureRoot(name: string): string {
  return canonicalize(fileURLToPath(new URL(`../../../tests/fixtures/${name}`, import.meta.url)));
}

function reader(fixture: string): DeltaReader {
  const client = new OpenspecClient({ root: fixtureRoot(fixture), bin: OPENSPEC_BIN });
  return new DeltaReader(client, new WorkspaceReader(client));
}

/** Число дельт, как его видит сам CLI, — для сверки с нашим разбором. */
async function cliDeltaCount(fixture: string, change: string): Promise<number> {
  const { stdout } = await execFileAsync(
    OPENSPEC_BIN,
    ['show', change, '--json', '--deltas-only'],
    { cwd: fixtureRoot(fixture), env: { ...process.env, NO_COLOR: '1' } },
  );
  return (JSON.parse(stdout) as { deltaCount: number }).deltaCount;
}

describe('путь capability из пути файла дельты', () => {
  it('сохраняет вложенность пути', () => {
    expect(
      capabilityFromPath('/p/openspec/changes/x/specs/identity/user-auth/spec.md'),
    ).toBe('identity/user-auth');
  });

  it('плоский путь остаётся плоским', () => {
    expect(capabilityFromPath('/p/openspec/changes/x/specs/data-export/spec.md')).toBe(
      'data-export',
    );
  });
});

describe('чтение дельт change', () => {
  it('число требований совпадает с числом дельт по CLI', async () => {
    const deltas = await reader('delta-ops').readChangeDeltas('rework-export');
    const total = deltas.views.reduce((sum, view) => sum + view.requirementCount, 0);

    expect(total).toBe(await cliDeltaCount('delta-ops', 'rework-export'));
  });

  it('группирует требования по всем операциям дельты', async () => {
    const deltas = await reader('delta-ops').readChangeDeltas('rework-export');
    const view = deltas.views.find((item) => item.capability === 'data-export');

    expect(view?.groups.map((group) => group.operation)).toEqual([
      'MODIFIED',
      'REMOVED',
      'RENAMED',
    ]);
  });

  it('удалённое требование несёт причину и миграцию', async () => {
    const deltas = await reader('delta-ops').readChangeDeltas('rework-export');
    const removed = deltas.views[0]?.groups.find((group) => group.operation === 'REMOVED');

    expect(removed?.requirements[0]?.reason).toContain('Заменена');
    expect(removed?.requirements[0]?.missingFields).toEqual([]);
  });

  it('переименование несёт прежнее и новое имя', async () => {
    const deltas = await reader('delta-ops').readChangeDeltas('rework-export');
    const renamed = deltas.views[0]?.groups.find((group) => group.operation === 'RENAMED');

    expect(renamed?.requirements[0]?.renamedFrom).toBe('Кодировка файла');
    expect(renamed?.requirements[0]?.renamedTo).toBe('Кодировка выгрузки');
  });

  it('change без дельт даёт пустой набор', async () => {
    const deltas = await reader('bare-change').readChangeDeltas('bare-feature');
    expect(deltas.views).toHaveLength(0);
  });
});

/** Число требований и сценариев, как их видит CLI. */
async function cliSpecCounts(
  fixture: string,
  capability: string,
): Promise<{ requirements: number; scenarios: number }> {
  const { stdout } = await execFileAsync(
    OPENSPEC_BIN,
    ['show', capability, '--type', 'spec', '--json'],
    { cwd: fixtureRoot(fixture), env: { ...process.env, NO_COLOR: '1' } },
  );
  const parsed = JSON.parse(stdout) as {
    requirementCount: number;
    requirements: { scenarios: unknown[] }[];
  };
  return {
    requirements: parsed.requirementCount,
    scenarios: parsed.requirements.reduce((sum, item) => sum + item.scenarios.length, 0),
  };
}

describe('структурный просмотр основного спека', () => {
  it('число требований и сценариев совпадает с выводом CLI', async () => {
    const spec = await reader('delta-ops').readSpec('data-export');
    const counts = await cliSpecCounts('delta-ops', 'data-export');

    expect(spec?.requirements).toHaveLength(counts.requirements);
    expect(spec?.scenarioCount).toBe(counts.scenarios);
  });

  it('отдаёт назначение capability и сценарии каждого требования', async () => {
    const spec = await reader('delta-ops').readSpec('data-export');

    expect(spec?.purpose).toContain('переносимом формате');
    expect(spec?.purposeIsPlaceholder).toBe(false);
    const requirement = spec?.requirements.find((item) => item.name === 'Выгрузка данных');
    expect(requirement?.scenarios.map((scenario) => scenario.name)).toContain(
      'Пустой набор данных',
    );
  });

  it('требования и сценарии несут номера строк', async () => {
    const spec = await reader('delta-ops').readSpec('data-export');
    const requirement = spec?.requirements[0];

    expect(requirement?.line).toBeGreaterThan(0);
    expect(requirement?.scenarios[0]?.line).toBeGreaterThan(requirement?.line ?? 0);
  });

  it('заглушка назначения, оставленная архивацией, помечается', async () => {
    const spec = await reader('delta-ops').readSpec('tbd-capability');

    expect(spec?.purposeIsPlaceholder).toBe(true);
    expect(spec?.purpose).toContain('TBD');
  });

  it('несуществующая capability даёт null', async () => {
    expect(await reader('delta-ops').readSpec('такой-нет')).toBeNull();
  });
});

describe('сравнение требования с основным спеком', () => {
  it('показывает потерянный при копировании сценарий', async () => {
    const comparison = await reader('delta-ops').compare(
      'rework-export',
      'data-export',
      'Выгрузка данных',
    );

    expect(comparison?.missingInMainSpec).toBe(false);
    expect(comparison?.removedScenarios).toContain('Пустой набор данных');
    expect(comparison?.keptScenarios).toContain('Успешная выгрузка');
  });

  it('показывает изменение текста требования', async () => {
    const comparison = await reader('delta-ops').compare(
      'rework-export',
      'data-export',
      'Выгрузка данных',
    );

    expect(comparison?.description.some((line) => line.kind === 'added')).toBe(true);
    expect(comparison?.description.some((line) => line.kind === 'removed')).toBe(true);
  });

  it('несуществующее требование даёт null, а не пустое сравнение', async () => {
    const comparison = await reader('delta-ops').compare(
      'rework-export',
      'data-export',
      'Такого требования нет',
    );

    expect(comparison).toBeNull();
  });
});

describe('карта связей', () => {
  it('одна capability под двумя changes помечает пересекающееся требование', async () => {
    const map = await reader('delta-ops').buildMap();
    const node = map.nodes.find((item) => item.capability === 'data-export');

    expect(node?.links.map((link) => link.change).sort()).toEqual([
      'add-limits',
      'rework-export',
    ]);
    expect(node?.links[0]?.conflictingRequirements).toContain('Выгрузка данных');
  });

  it('требование, которое меняет только один change, конфликтом не помечено', async () => {
    const map = await reader('delta-ops').buildMap();
    const node = map.nodes.find((item) => item.capability === 'data-export');
    const limits = node?.links.find((link) => link.change === 'add-limits');

    expect(limits?.conflictingRequirements).not.toContain('Ограничение объёма');
  });

  it('capability без активных changes показана без связей', async () => {
    const map = await reader('archived').buildMap();
    const node = map.nodes.find((item) => item.capability === 'data-export');

    expect(node?.exists).toBe(true);
    expect(node?.links).toEqual([]);
  });
});
