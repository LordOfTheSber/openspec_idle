import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '@openspec-ide/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenspecClient } from './client.js';
import { runCliJson } from './exec.js';

const OPENSPEC_BIN = fileURLToPath(
  new URL('../../../../node_modules/.bin/openspec', import.meta.url),
);

function fixture(name: string): string {
  return canonicalize(fileURLToPath(new URL(`../../../../tests/fixtures/${name}`, import.meta.url)));
}

function client(name: string, extra: { cacheTtlMs?: number } = {}): OpenspecClient {
  return new OpenspecClient({ root: fixture(name), bin: OPENSPEC_BIN, ...extra });
}

let tmp: string;

beforeEach(() => {
  tmp = canonicalize(mkdtempSync(join(tmpdir(), 'osi-client-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('обёртка над CLI: успешные вызовы', () => {
  it('list отдаёт разобранный список changes', async () => {
    const result = await client('full-change').listChanges();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.changes.map((c) => c.name)).toContain('full-feature');
    expect(result.data.changes[0]?.totalTasks).toBe(4);
  });

  it('list --specs отдаёт основные спеки', async () => {
    const result = await client('archived').listSpecs();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.specs.map((s) => s.id)).toContain('data-export');
  });

  it('status отдаёт схему и артефакты именно этого change', async () => {
    const result = await client('custom-schema').status('team-feature');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.schemaName).toBe('team-flow');
    expect(result.data.artifacts.map((a) => a.id)).toEqual([
      'research',
      'proposal',
      'specs',
      'spec-review',
      'design',
      'plan',
    ]);
    expect(Object.keys(result.data.artifactPaths)).toContain('spec-review');
  });

  it('templates отдаёт пути шаблонов собственной схемы', async () => {
    const result = await client('custom-schema').templates('team-flow');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data)).toContain('spec-review');
    expect(result.data['spec-review']?.path).toMatch(/team-flow\/templates\/review\.md$/);
  });

  it('schemas перечисляет встроенные и проектные схемы с источником', async () => {
    const result = await client('custom-schema').listSchemas();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = new Map(result.data.map((s) => [s.name, s]));
    expect(byName.get('team-flow')?.source).toBe('project');
    expect(byName.get('spec-driven')?.source).toBe('package');
  });

  it('schema which отдаёт путь разрешения проектной схемы', async () => {
    const result = await client('custom-schema').schemaWhich('team-flow');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source).toBe('project');
    expect(result.data.path).toContain('openspec/schemas/team-flow');
  });

  it('instructions отдаёт инструкцию артефакта собственной схемы', async () => {
    const result = await client('custom-schema').instructions('spec-review', 'team-feature');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instruction ?? '').toContain('ревью');
  });
});

describe('обёртка над CLI: валидация', () => {
  it('на валидном change отдаёт отчёт без замечаний', async () => {
    const result = await client('full-change').validate('full-feature');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.valid).toBe(true);
    expect(result.data.items[0]?.issues).toHaveLength(0);
  });

  it('ненулевой код валидации отдаётся как отчёт, а не как отказ', async () => {
    const result = await client('bare-change').validate('bare-feature');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.valid).toBe(false);
    expect(result.data.items[0]?.issues[0]?.level).toBe('ERROR');
    expect(result.data.items[0]?.issues[0]?.message).toContain('delta');
  });
});

describe('обёртка над CLI: отказы', () => {
  it('ненулевой код возврата отдаётся с кодом и текстом stderr', async () => {
    const result = await client('full-change').status('нет-такого-change');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('exit-code');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('невалидный JSON отдаётся как ошибка разбора с сохранённым выводом', async () => {
    const fake = join(tmp, 'fake-openspec');
    writeFileSync(fake, '#!/bin/sh\necho "не json"\n');
    chmodSync(fake, 0o755);

    const result = await runCliJson({ bin: fake, cwd: tmp }, ['list', '--json']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('parse');
    expect(result.stdout).toContain('не json');
  });

  it('ответ, не соответствующий схеме, не выдаётся за результат', async () => {
    const fake = join(tmp, 'fake-openspec');
    writeFileSync(fake, '#!/bin/sh\necho \'{"changes":"строка вместо массива"}\'\n');
    chmodSync(fake, 0o755);
    mkdirSync(join(tmp, 'openspec'), { recursive: true });

    const result = await new OpenspecClient({ root: tmp, bin: fake }).listChanges();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('parse');
    expect(result.message).toContain('не соответствует ожидаемой схеме');
    expect(result.message).toContain('changes');
  });

  it('отсутствие исполняемого файла отдаётся отдельным видом отказа', async () => {
    mkdirSync(join(tmp, 'openspec'), { recursive: true });
    const result = await new OpenspecClient({
      root: tmp,
      bin: join(tmp, 'нет-такого-бинаря'),
    }).listChanges();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('not-found');
    expect(result.message).toContain('Не удалось запустить');
  });

  it('проба доступности отличает установленный CLI от отсутствующего', async () => {
    const present = await client('empty').probe();
    expect(present.available).toBe(true);
    if (present.available) expect(present.version).toMatch(/^\d+\.\d+\.\d+/);

    mkdirSync(join(tmp, 'openspec'), { recursive: true });
    const absent = await new OpenspecClient({ root: tmp, bin: join(tmp, 'нет') }).probe();
    expect(absent.available).toBe(false);
  });
});

describe('обёртка над CLI: кэш', () => {
  it('повторный запрос без правок не порождает нового процесса', async () => {
    const instance = client('full-change');
    const first = await instance.listChanges();
    const second = await instance.listChanges();

    expect(first.ok && second.ok).toBe(true);
    expect(second).toBe(first);
    expect(instance.cacheSize).toBe(1);
  });

  it('правка файла в openspec/ сбрасывает кэш', async () => {
    mkdirSync(join(tmp, 'openspec', 'changes', 'archive'), { recursive: true });
    mkdirSync(join(tmp, 'openspec', 'specs'), { recursive: true });
    writeFileSync(join(tmp, 'openspec', 'config.yaml'), 'schema: spec-driven\n');

    const instance = new OpenspecClient({ root: tmp, bin: OPENSPEC_BIN });
    const first = await instance.listChanges();
    expect(first.ok).toBe(true);

    mkdirSync(join(tmp, 'openspec', 'changes', 'added-later'), { recursive: true });
    writeFileSync(
      join(tmp, 'openspec', 'changes', 'added-later', '.openspec.yaml'),
      'schema: spec-driven\ncreated: 2026-03-01\n',
    );

    const second = await instance.listChanges();
    expect(second).not.toBe(first);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.changes.map((c) => c.name)).toContain('added-later');
  });

  it('явный сброс очищает кэш', async () => {
    const instance = client('full-change');
    await instance.listChanges();
    expect(instance.cacheSize).toBe(1);
    instance.invalidate();
    expect(instance.cacheSize).toBe(0);
  });
});
