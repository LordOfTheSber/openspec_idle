import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize } from './fs/workspace.js';
import { OpenspecClient } from './openspec/client.js';
import { SchemaOperationError, SchemaRegistry, parseSchemaText } from './schemaRegistry.js';

const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

let root: string;

function registry(fixture: string): SchemaRegistry {
  const source = fileURLToPath(new URL(`../../../tests/fixtures/${fixture}`, import.meta.url));
  cpSync(source, root, { recursive: true });
  return new SchemaRegistry(new OpenspecClient({ root, bin: OPENSPEC_BIN }), OPENSPEC_BIN);
}

function writeSchema(name: string, text: string): void {
  const dir = join(root, 'openspec/schemas', name);
  mkdirSync(join(dir, 'templates'), { recursive: true });
  writeFileSync(join(dir, 'schema.yaml'), text);
  for (const [, template] of text.matchAll(/template: (\S+)/g)) {
    writeFileSync(join(dir, 'templates', template!), `# ${template}\n`);
  }
}

const CYCLIC = `name: cyclic
version: 1
description: Цикл
artifacts:
  - id: a
    generates: specs/**/*.md
    description: a
    template: a.md
    instruction: Опиши требования.
    requires: [b]
  - id: b
    generates: b.md
    description: b
    template: b.md
    instruction: Опиши b.
    requires: [a]
apply:
  requires: [b]
  tracks: b.md
`;

const NO_SPECS = `name: no-specs
version: 1
description: Без контракта
artifacts:
  - id: plan
    generates: plan.md
    description: План
    template: plan.md
    instruction: Разбей работу на пункты.
    requires: []
apply:
  requires: [plan]
  tracks: plan.md
`;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-schemas-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('реестр схем', () => {
  it('в проекте без собственных схем показаны только встроенные', async () => {
    const entries = await registry('full-change').list();

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.source === 'package')).toBe(true);
    const spec = entries.find((entry) => entry.name === 'spec-driven');
    expect(spec?.isDefault).toBe(true);
    expect(spec?.readable).toBe(true);
    expect(spec?.conformance?.assignable).toBe(true);
  });

  it('проектная схема стоит первой и отмечена схемой по умолчанию', async () => {
    const entries = await registry('custom-schema').list();

    expect(entries[0]?.name).toBe('team-flow');
    expect(entries[0]?.source).toBe('project');
    expect(entries[0]?.isDefault).toBe(true);
    expect(entries.find((entry) => entry.name === 'spec-driven')?.isDefault).toBe(false);
  });

  it('проектная схема, затеняющая встроенную, помечена и называет затенённую', async () => {
    const schemas = registry('full-change');
    await schemas.create('spec-driven', 'spec-driven');
    const entries = await schemas.list();

    const own = entries.filter((entry) => entry.name === 'spec-driven');
    expect(own).toHaveLength(1);
    expect(own[0]?.source).toBe('project');
    expect(own[0]?.shadows).toHaveLength(1);
    expect(own[0]?.shadows[0]?.source).toBe('package');
  });

  it('схема с некорректным YAML нечитаема, остальные доступны', async () => {
    const schemas = registry('custom-schema');
    writeSchema('broken', 'name: broken\nartifacts:\n  - id: a\n   generates: [\n');
    const entries = await schemas.list();

    const broken = entries.find((entry) => entry.name === 'broken');
    expect(broken?.readable).toBe(false);
    expect(broken?.parseError).toMatch(/строка \d+, столбец \d+/);
    expect(broken?.conformance).toBeNull();
    expect(entries.find((entry) => entry.name === 'team-flow')?.readable).toBe(true);
    expect(entries.find((entry) => entry.name === 'spec-driven')?.readable).toBe(true);
  });

  it('схема, которую CLI отверг, показана с ошибкой CLI и не назначается', async () => {
    const schemas = registry('custom-schema');
    writeSchema('cyclic', CYCLIC);
    const entry = (await schemas.list()).find((item) => item.name === 'cyclic');

    expect(entry?.readable).toBe(true);
    expect(entry?.cliError).toMatch(/Cyclic/);
    expect(entry?.conformance?.assignable).toBe(false);
  });
});

describe('создание схемы', () => {
  it('с нуля — через schema init, схема появляется в реестре', async () => {
    const schemas = registry('full-change');
    const created = await schemas.create('fresh', null);

    expect(created.source).toBe('project');
    expect(created.document?.artifacts.map((artifact) => artifact.id)).toEqual([
      'proposal',
      'specs',
      'design',
      'tasks',
    ]);
    expect((await schemas.list()).some((entry) => entry.name === 'fresh')).toBe(true);
    // `--no-default`: схема проекта не меняется.
    expect(await schemas.defaultSchema()).toBe('spec-driven');
  });

  it('форком — артефакты, шаблоны и инструкции перенесены', async () => {
    const schemas = registry('custom-schema');
    const created = await schemas.create('team-copy', 'team-flow');

    const research = created.document?.artifacts.find((artifact) => artifact.id === 'research');
    expect(research?.instruction).toMatch(/Опиши, что известно о проблеме/);
    expect(created.document?.apply.tracks).toBe('plan.md');
    expect(existsSync(join(root, 'openspec/schemas/team-copy/templates/plan.md'))).toBe(true);
  });

  it('занятое имя отклоняется до вызова CLI', async () => {
    const schemas = registry('custom-schema');
    const before = readFileSync(join(root, 'openspec/schemas/team-flow/schema.yaml'), 'utf8');

    await expect(schemas.create('team-flow', 'spec-driven')).rejects.toThrow(/уже существует/);
    expect(readFileSync(join(root, 'openspec/schemas/team-flow/schema.yaml'), 'utf8')).toBe(before);
  });

  it('недопустимое имя отклоняется', async () => {
    await expect(registry('empty').create('Моя схема', null)).rejects.toBeInstanceOf(SchemaOperationError);
  });
});

describe('двухслойная проверка', () => {
  it('цикл зависимостей — запись структурного слоя, назначение заблокировано', async () => {
    const schemas = registry('custom-schema');
    writeSchema('cyclic', CYCLIC);
    const check = await schemas.check('cyclic');

    expect(check.structural.valid).toBe(false);
    expect(check.structural.issues.some((issue) => /Cyclic/.test(issue.message))).toBe(true);
    expect(check.assignable).toBe(false);
  });

  it('схема без спеков — структура в порядке, слой SDD блокирует', async () => {
    const schemas = registry('custom-schema');
    writeSchema('no-specs', NO_SPECS);
    const check = await schemas.check('no-specs');

    expect(check.structural.valid).toBe(true);
    expect(check.sdd.violations.some((violation) => violation.rule === 'sdd/behaviour-contract')).toBe(true);
    expect(check.assignable).toBe(false);
  });

  it('схема, проходящая оба слоя, готова к назначению', async () => {
    const check = await registry('custom-schema').check('team-flow');

    expect(check.structural.valid).toBe(true);
    expect(check.sdd.errors).toBe(0);
    expect(check.assignable).toBe(true);
  });

  it('объявленный, но отсутствующий шаблон — ошибка структурного слоя у артефакта', async () => {
    const schemas = registry('custom-schema');
    unlinkSync(join(root, 'openspec/schemas/team-flow/templates/research.md'));
    const source = await schemas.read('team-flow');
    const check = await schemas.check('team-flow');

    expect(source.templates.find((item) => item.artifact === 'research')?.exists).toBe(false);
    const issue = check.structural.issues.find((item) => item.artifact === 'research');
    expect(issue?.level).toBe('error');
    expect(issue?.message).toMatch(/research\.md/);
    expect(check.assignable).toBe(false);
  });
});

describe('правка схемы и шаблонов', () => {
  it('некорректный YAML не сохраняется, ошибка указывает место', async () => {
    const schemas = registry('custom-schema');
    const path = join(root, 'openspec/schemas/team-flow/schema.yaml');
    const before = readFileSync(path, 'utf8');

    const error = await schemas.save('team-flow', 'name: x\n  bad: [').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaOperationError);
    expect((error as SchemaOperationError).details[0]).toMatch(/строка \d+/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('несоответствующая SDD схема сохраняется и помечается в реестре', async () => {
    const schemas = registry('custom-schema');
    writeSchema('draft', NO_SPECS.replace('no-specs', 'draft'));
    await schemas.save('draft', NO_SPECS.replace('no-specs', 'draft').replace('План', 'План работ'));

    const entry = (await schemas.list()).find((item) => item.name === 'draft');
    expect(readFileSync(join(root, 'openspec/schemas/draft/schema.yaml'), 'utf8')).toMatch(/План работ/);
    expect(entry?.conformance?.assignable).toBe(false);
    expect(entry?.conformance?.errors).toBeGreaterThan(0);
  });

  it('встроенную схему править нельзя', async () => {
    await expect(registry('empty').save('spec-driven', 'name: spec-driven\n')).rejects.toThrow(/форк/);
  });

  it('отсутствующий шаблон создаётся, выход за каталог шаблонов запрещён', async () => {
    const schemas = registry('custom-schema');
    unlinkSync(join(root, 'openspec/schemas/team-flow/templates/research.md'));
    await schemas.writeTemplate('team-flow', 'research.md', '# Исследование\n');

    expect(await schemas.readTemplate('team-flow', 'research.md')).toBe('# Исследование\n');
    expect((await schemas.read('team-flow')).templates.find((item) => item.artifact === 'research')?.exists).toBe(true);
    await expect(schemas.writeTemplate('team-flow', '../schema.yaml', 'x')).rejects.toThrow();
  });
});

describe('назначение схемы', () => {
  it('меняется только строка schema в настройках проекта', async () => {
    const schemas = registry('custom-schema');
    const configPath = join(root, 'openspec/config.yaml');
    const before = readFileSync(configPath, 'utf8');
    const result = await schemas.assign('spec-driven');

    const after = readFileSync(configPath, 'utf8');
    expect(after).toBe(before.replace('schema: team-flow', 'schema: spec-driven'));
    expect(result.previous).toBe('team-flow');
    expect(result.activeChanges).toBe(1);
  });

  it('несоответствующая схема не назначается, перечислены нарушения', async () => {
    const schemas = registry('custom-schema');
    writeSchema('no-specs', NO_SPECS);
    const configPath = join(root, 'openspec/config.yaml');
    const before = readFileSync(configPath, 'utf8');

    const error = await schemas.assign('no-specs').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaOperationError);
    expect((error as SchemaOperationError).details.join('\n')).toMatch(/sdd\/behaviour-contract/);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('схема только с предупреждениями назначается, предупреждения возвращаются', async () => {
    const schemas = registry('custom-schema');
    await schemas.create('quiet', null);
    const result = await schemas.assign('quiet');

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.every((warning) => warning.startsWith('sdd/artifact-instruction'))).toBe(true);
    expect(await schemas.defaultSchema()).toBe('quiet');
  });

  it('changes без явной схемы сохраняют прежнюю', async () => {
    const schemas = registry('full-change');
    unlinkSync(join(root, 'openspec/changes/full-feature/.openspec.yaml'));
    await schemas.create('flow', 'spec-driven');
    const result = await schemas.assign('flow');

    expect(result.pinned).toEqual(['full-feature']);
    expect(readFileSync(join(root, 'openspec/changes/full-feature/.openspec.yaml'), 'utf8')).toMatch(
      /^schema: spec-driven$/m,
    );
  });
});

describe('предпросмотр процесса', () => {
  it('колонки идут по зависимостям, отмечен отслеживаемый артефакт', async () => {
    const schemas = registry('custom-schema');
    const { document } = await schemas.read('team-flow');
    const preview = schemas.preview(document!);

    expect(preview.order[0]).toBe('research');
    expect(preview.order.at(-1)).toBe('plan');
    expect(preview.trackedArtifact).toBe('plan');
    expect(preview.warning).toBeNull();
  });

  it('без отслеживаемого артефакта — предупреждение о неизмеримом прогрессе', () => {
    const { document } = parseSchemaText(NO_SPECS.replace('  tracks: plan.md\n', ''), 'x');
    const preview = registry('empty').preview(document!);

    expect(preview.trackedArtifact).toBeNull();
    expect(preview.warning).toMatch(/измеряться не будет/);
  });
});
