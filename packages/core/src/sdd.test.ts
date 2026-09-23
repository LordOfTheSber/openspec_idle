import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type SchemaDocument,
  addArtifact,
  schemaFromPlain,
  setWaiver,
  updateApply,
  updateArtifact,
} from './schemaDocument.js';
import { checkConformance } from './sdd.js';

function load(relative: string): SchemaDocument {
  const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  return schemaFromPlain(parse(text)).document;
}

const SPEC_DRIVEN = '../../../node_modules/@fission-ai/openspec/schemas/spec-driven/schema.yaml';
const TEAM_FLOW = '../../../tests/fixtures/custom-schema/openspec/schemas/team-flow/schema.yaml';

/** Схема «идея → список дел», которую `schema validate` считает валидной. */
const NO_SPECS: SchemaDocument = schemaFromPlain({
  name: 'no-specs',
  artifacts: [
    { id: 'idea', generates: 'idea.md', instruction: 'Опиши идею', requires: [] },
    { id: 'todo', generates: 'todo.md', instruction: 'Список дел', requires: ['idea'] },
  ],
  apply: { requires: ['todo'], tracks: 'todo.md' },
}).document;

function ids(document: SchemaDocument): string[] {
  return checkConformance(document).violations.map((violation) => violation.rule);
}

describe('правила SDD на эталонных схемах', () => {
  it('встроенная spec-driven не нарушает ничего', () => {
    const report = checkConformance(load(SPEC_DRIVEN));

    expect(report.violations).toEqual([]);
    expect(report.assignable).toBe(true);
    expect(report.passed.map((rule) => rule.id)).toHaveLength(6);
  });

  it('собственная team-flow тоже проходит все правила', () => {
    expect(checkConformance(load(TEAM_FLOW)).violations).toEqual([]);
  });

  it('схема из schema init даёт только предупреждения об инструкциях', () => {
    // Так выглядит результат `openspec schema init`: артефакты без инструкций.
    const init = schemaFromPlain({
      name: 'my-process',
      version: 1,
      artifacts: [
        { id: 'proposal', generates: 'proposal.md', template: 'proposal.md', requires: [] },
        { id: 'specs', generates: 'specs/**/*.md', template: 'specs/spec.md', requires: ['proposal'] },
        { id: 'design', generates: 'design.md', template: 'design.md', requires: ['specs'] },
        { id: 'tasks', generates: 'tasks.md', template: 'tasks.md', requires: ['design'] },
      ],
      apply: { requires: ['tasks'], tracks: 'tasks.md' },
    }).document;
    const report = checkConformance(init);

    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(4);
    expect(report.violations.every((violation) => violation.rule === 'sdd/artifact-instruction')).toBe(
      true,
    );
    expect(report.assignable).toBe(true);
  });
});

describe('правила уровня «ошибка»', () => {
  it('процесс без артефакта-контракта не спек-ориентирован', () => {
    const report = checkConformance(NO_SPECS);
    const violation = report.violations.find((item) => item.rule === 'sdd/behaviour-contract');

    expect(violation?.level).toBe('error');
    expect(violation?.message).toContain('контракта поведения');
    expect(violation?.fix).toContain('generates: specs/');
    expect(report.assignable).toBe(false);
  });

  it('без контракта правило зависимости от него неприменимо, а не «пройдено»', () => {
    const report = checkConformance(NO_SPECS);

    expect(report.notApplicable.map((item) => item.rule.id)).toContain('sdd/code-after-contract');
    expect(report.passed.map((rule) => rule.id)).not.toContain('sdd/code-after-contract');
  });

  it('работа, не зависящая от контракта, — ошибка с найденной цепочкой', () => {
    const document = schemaFromPlain({
      name: 'parallel',
      artifacts: [
        { id: 'proposal', generates: 'proposal.md', instruction: 'x', requires: [] },
        { id: 'specs', generates: 'specs/**/*.md', instruction: 'x', requires: ['proposal'] },
        { id: 'plan', generates: 'plan.md', instruction: 'x', requires: ['proposal'] },
      ],
      apply: { requires: ['plan'], tracks: 'plan.md' },
    }).document;
    const violation = checkConformance(document).violations.find(
      (item) => item.rule === 'sdd/code-after-contract',
    );

    expect(violation?.artifact).toBe('plan');
    expect(violation?.message).toContain('plan ← proposal');
  });

  it('пустое начало работ — ошибка', () => {
    const document = updateApply(load(TEAM_FLOW), { requires: [] });
    expect(ids(document)).toContain('sdd/code-after-contract');
  });

  it('не объявленный отслеживаемый артефакт — ошибка', () => {
    const document = updateApply(load(TEAM_FLOW), { tracks: null });
    const violation = checkConformance(document).violations.find(
      (item) => item.rule === 'sdd/tracked-artifact',
    );

    expect(violation?.field).toBe('apply.tracks');
  });

  it('отслеживаемый артефакт, которого нет, — ошибка с его именем', () => {
    const document = updateApply(load(TEAM_FLOW), { tracks: 'tasks.md' });
    const violation = checkConformance(document).violations.find(
      (item) => item.rule === 'sdd/tracked-artifact',
    );

    expect(violation?.message).toContain('tasks.md');
  });

  it('артефакт с несуществующей зависимостью недостижим', () => {
    const document = updateArtifact(load(TEAM_FLOW), 'design', { requires: ['нет-такого'] });
    const violation = checkConformance(document).violations.find(
      (item) => item.rule === 'sdd/reachable' && item.artifact === 'design',
    );

    expect(violation?.message).toContain('нет-такого');
  });

  it('артефакты в цикле недостижимы', () => {
    const document = schemaFromPlain({
      name: 'cycle',
      artifacts: [
        { id: 'proposal', generates: 'proposal.md', instruction: 'x', requires: [] },
        { id: 'a', generates: 'specs/**/*.md', instruction: 'x', requires: ['proposal', 'b'] },
        { id: 'b', generates: 'b.md', instruction: 'x', requires: ['a'] },
      ],
      apply: { requires: ['b'], tracks: 'b.md' },
    }).document;
    const unreachable = checkConformance(document)
      .violations.filter((item) => item.rule === 'sdd/reachable')
      .map((item) => item.artifact);

    expect(unreachable.sort()).toEqual(['a', 'b']);
  });
});

describe('правила уровня «предупреждение»', () => {
  it('контракт без мотивации — предупреждение, назначение не блокируется', () => {
    const document = updateArtifact(load(TEAM_FLOW), 'specs', { requires: [] });
    const report = checkConformance(document);
    const violation = report.violations.find((item) => item.rule === 'sdd/motivation-first');

    expect(violation?.level).toBe('warning');
    expect(violation?.artifact).toBe('specs');
  });

  it('артефакт без инструкции — предупреждение с его именем', () => {
    const document = addArtifact(load(TEAM_FLOW), { id: 'notes', requires: ['proposal'] });
    const violation = checkConformance(document).violations.find(
      (item) => item.rule === 'sdd/artifact-instruction',
    );

    expect(violation?.artifact).toBe('notes');
    expect(violation?.field).toBe('instruction');
  });
});

describe('отчёт', () => {
  it('ошибки идут выше предупреждений', () => {
    const document = schemaFromPlain({
      name: 'mixed',
      artifacts: [{ id: 'idea', generates: 'idea.md', requires: [] }],
      apply: { requires: ['idea'], tracks: 'idea.md' },
    }).document;
    const levels = checkConformance(document).violations.map((item) => item.level);

    expect(levels.indexOf('warning')).toBeGreaterThan(levels.lastIndexOf('error'));
  });

  it('пройденные правила перечислены отдельно', () => {
    const report = checkConformance(NO_SPECS);

    expect(report.passed.map((rule) => rule.id)).toContain('sdd/tracked-artifact');
    expect(report.passed.map((rule) => rule.id)).toContain('sdd/reachable');
  });
});

describe('адресный отказ от правила', () => {
  it('отказ с причиной снимает блокировку и показывается отклонённым', () => {
    const document = setWaiver(
      NO_SPECS,
      'sdd/behaviour-contract',
      'Процесс для инфраструктурных изменений: поведение не меняется',
    );
    const report = checkConformance(document);

    expect(report.assignable).toBe(true);
    expect(report.waived[0]?.rule.id).toBe('sdd/behaviour-contract');
    expect(report.waived[0]?.reason).toContain('инфраструктурных');
    expect(report.waived[0]?.violations).toHaveLength(1);
  });

  it('отказ без причины не применяется и правило продолжает блокировать', () => {
    const report = checkConformance(setWaiver(NO_SPECS, 'sdd/behaviour-contract', '  '));

    expect(report.assignable).toBe(false);
    expect(report.waived).toHaveLength(0);
    expect(report.violations.some((item) => item.rule === 'sdd/waiver-without-reason')).toBe(true);
  });

  it('отказ снимает только названное правило', () => {
    const document = updateApply(
      setWaiver(NO_SPECS, 'sdd/behaviour-contract', 'Инфраструктура'),
      { tracks: null },
    );
    const report = checkConformance(document);

    expect(report.assignable).toBe(false);
    expect(report.violations.map((item) => item.rule)).toContain('sdd/tracked-artifact');
  });

  it('отказ от неизвестного правила даёт предупреждение', () => {
    const report = checkConformance(setWaiver(load(TEAM_FLOW), 'sdd/no-such-rule', 'просто так'));
    const notice = report.violations.find((item) => item.rule === 'sdd/unknown-waiver');

    expect(notice?.level).toBe('warning');
    expect(notice?.message).toContain('sdd/no-such-rule');
  });
});
