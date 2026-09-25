import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from '../../../tests/fixtures.js';
import { canonicalize } from './fs/workspace.js';
import { StructureExistsError, StructureService, parseStructureYaml, watchedStructureDirs } from './structure.js';

let root: string;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-structure-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content = ''): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

const DESCRIPTION = `version: 1
structure:
  openspec:
    structure.yaml: file
    config.yaml: file
    specs: "*"
    changes: "*"
  docs:
    context:
      README.md: file
      "*.md": file
      adr: "*"
`;

describe('разбор описания со строками', () => {
  it('каждое правило знает свою строку', () => {
    const parsed = parseStructureYaml(DESCRIPTION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const docs = parsed.spec.entries.find((entry) => entry.name === 'docs');
    expect(docs?.line).toBe(8);
    const context = docs?.rule.kind === 'dir' ? docs.rule.entries[0] : undefined;
    expect(context?.line).toBe(9);
  });

  it('ошибка YAML — со строкой', () => {
    const parsed = parseStructureYaml('structure:\n  docs: [\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]?.message).toContain('не разбирается как YAML');
    expect(parsed.errors[0]?.line).toBeGreaterThan(0);
  });
});

describe('проверка структуры на диске', () => {
  it('без описания проверка не настроена и ничего не сообщает', async () => {
    const report = await new StructureService(root).check();
    expect(report).toMatchObject({ configured: false, issues: [], errors: [], ok: true });
  });

  it('лишний файл, отсутствующий файл и файл вместо папки — со строками правил', async () => {
    write('openspec/structure.yaml', DESCRIPTION);
    write('openspec/config.yaml');
    mkdirSync(join(root, 'openspec/specs'));
    mkdirSync(join(root, 'openspec/changes'));
    write('docs/context/glossary.md');
    write('docs/context/adr');
    write('docs/context/draft.txt');
    write('src/index.ts');

    const report = await new StructureService(root).check();

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => [issue.kind, issue.path, issue.line])).toEqual([
      ['missing', 'docs/context/README.md', 10],
      ['wrong-type', 'docs/context/adr', 12],
      ['unexpected', 'docs/context/draft.txt', 9],
    ]);
  });

  it('ошибки описания отменяют проверку', async () => {
    write('openspec/structure.yaml', 'version: 1\nstructure:\n  docs/context: "*"\n');

    const report = await new StructureService(root).check();

    expect(report.errors).toEqual([expect.objectContaining({ line: 3 })]);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it('созданное описание проходит проверку на фикстуре и не создаётся повторно', async () => {
    cpSync(join(FIXTURES_ROOT, 'full-change'), root, { recursive: true });
    const service = new StructureService(root);

    const report = await service.init();

    expect(report).toMatchObject({ configured: true, ok: true, errors: [], issues: [] });
    const text = readFileSync(join(root, 'openspec/structure.yaml'), 'utf8');
    expect(text).toContain('config.yaml: file');
    expect(text).toContain('specs: "*"');
    await expect(service.init()).rejects.toBeInstanceOf(StructureExistsError);
  });

  it('наблюдатель получает папки первого уровня из описания', () => {
    write('openspec/structure.yaml', DESCRIPTION);
    mkdirSync(join(root, 'docs'));
    expect(watchedStructureDirs(root)).toEqual(['docs']);
  });
});
