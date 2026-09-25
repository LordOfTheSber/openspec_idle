import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchivePreviewService, PREVIEW_DIR_PREFIX, UnknownChangeError } from './archivePreview.js';
import { canonicalize } from './fs/workspace.js';

const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

let root: string;
/** Свой каталог для копий: общий tmp меняют параллельные тесты. */
let sandboxes: string;

function project(fixture: string): ArchivePreviewService {
  const source = fileURLToPath(new URL(`../../../tests/fixtures/${fixture}`, import.meta.url));
  cpSync(source, root, { recursive: true });
  return new ArchivePreviewService(root, OPENSPEC_BIN, sandboxes);
}

/** Снимок всех файлов `openspec/` проекта: путь → содержимое. */
function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full.slice(root.length), readFileSync(full, 'utf8'));
    }
  };
  walk(join(root, 'openspec'));
  return files;
}

function previewDirs(): string[] {
  return readdirSync(sandboxes).filter((name) => name.startsWith(PREVIEW_DIR_PREFIX));
}

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-preview-')));
  sandboxes = mkdtempSync(join(tmpdir(), 'osi-preview-sandboxes-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(sandboxes, { recursive: true, force: true });
});

describe('предпросмотр архивации', () => {
  it('новая capability: архивация пройдёт, проект не меняется, копия удалена', async () => {
    const service = project('full-change');
    const before = snapshot();
    const leftovers = previewDirs();

    const preview = await service.preview('full-feature');

    expect(preview.outcome).toBe('ready');
    expect(preview.problems).toEqual([]);
    expect(preview.totals).toEqual({ added: 1, modified: 0, removed: 0, renamed: 0 });
    expect(preview.specs.map((spec) => spec.capability)).toEqual(['data-export']);

    const spec = preview.specs[0];
    expect(spec?.status).toBe('created');
    expect(spec?.before).toBeNull();
    expect(spec?.path).toBe('openspec/specs/data-export/spec.md');
    expect(spec?.requirements.map((requirement) => requirement.kind)).toEqual(['added']);
    expect(spec?.after).toContain('### Requirement: Выгрузка данных');

    expect(snapshot()).toEqual(before);
    expect(previewDirs()).toEqual(leftovers);
  });

  it('MODIFIED теряет сценарий: CLI отклонит архивацию и назовёт сценарий', async () => {
    const service = project('delta-ops');
    const before = snapshot();

    const preview = await service.preview('rework-export');

    expect(preview.outcome).toBe('refused');
    expect(preview.specs).toEqual([]);
    expect(preview.totals).toBeNull();
    expect(preview.problems.map((problem) => problem.message).join('\n')).toContain('Пустой набор данных');
    expect(preview.problems[0]?.fix).not.toBeNull();
    expect(snapshot()).toEqual(before);
  });

  it('переименование, изменение и предупреждение CLI о снятом требовании', async () => {
    const service = project('delta-ops');
    const delta = join(root, 'openspec/changes/rework-export/specs/data-export/spec.md');
    writeFileSync(
      delta,
      readFileSync(delta, 'utf8').replace(
        '- **THEN** отдаётся файл со всеми его данными\n',
        '- **THEN** отдаётся файл со всеми его данными\n\n#### Scenario: Пустой набор данных\n\n' +
          '- **WHEN** у пользователя нет данных\n- **THEN** отдаётся пустой файл\n',
      ),
    );

    const preview = await service.preview('rework-export');

    expect(preview.outcome).not.toBe('refused');
    const spec = preview.specs[0];
    expect(spec?.status).toBe('updated');
    expect(spec?.requirements.find((item) => item.name === 'Выгрузка данных')?.kind).toBe('modified');
    expect(spec?.requirements.find((item) => item.name === 'Кодировка выгрузки')).toMatchObject({
      kind: 'renamed',
      renamedFrom: 'Кодировка файла',
    });
    expect(spec?.diff.added).toBeGreaterThan(0);
    expect(preview.warnings.join('\n')).toContain('Устаревшая выгрузка');
  });

  it('change не проходит проверку: спеки показаны, исход — отказ проверкой', async () => {
    const service = project('full-change');
    appendFileSync(
      join(root, 'openspec/changes/full-feature/specs/data-export/spec.md'),
      '\n### Requirement: Без сценария\n\nСистема ДОЛЖНА (SHALL) что-то делать.\n',
    );

    const preview = await service.preview('full-feature');

    expect(preview.outcome).toBe('validation-failed');
    expect(preview.problems[0]?.code).toBe('archive_validation_failed');
    expect(preview.specs[0]?.requirements.map((item) => item.name)).toContain('Без сценария');
  });

  it('неизвестный change и имя с выходом за пределы changes', async () => {
    const service = project('full-change');

    await expect(service.preview('no-such-change')).rejects.toBeInstanceOf(UnknownChangeError);
    await expect(service.preview('../specs')).rejects.toBeInstanceOf(UnknownChangeError);
    await expect(service.preview('archive')).rejects.toBeInstanceOf(UnknownChangeError);
  });
});
