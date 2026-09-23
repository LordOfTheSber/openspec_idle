import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  WAIVERS_KEY,
  addArtifact,
  dependentsOf,
  removeArtifact,
  schemaFromPlain,
  schemaToPlain,
  setWaiver,
  updateArtifact,
} from './schemaDocument.js';

const SPEC_DRIVEN = fileURLToPath(
  new URL('../../../node_modules/@fission-ai/openspec/schemas/spec-driven/schema.yaml', import.meta.url),
);

describe('модель схемы', () => {
  it('разбор и обратная запись встроенной схемы не теряют содержимого', () => {
    const plain = parse(readFileSync(SPEC_DRIVEN, 'utf8')) as Record<string, unknown>;
    const { document, problems } = schemaFromPlain(plain);

    expect(problems).toEqual([]);
    expect(document.artifacts.map((artifact) => artifact.id)).toEqual([
      'proposal',
      'specs',
      'design',
      'tasks',
    ]);
    const again = schemaFromPlain(schemaToPlain(document)).document;
    expect(again).toEqual(document);
  });

  it('незнакомые ключи сохраняются при записи', () => {
    const { document } = schemaFromPlain({
      name: 'x',
      будущееПоле: { a: 1 },
      artifacts: [{ id: 'a', generates: 'a.md', requires: [], свояМетка: true }],
      apply: { requires: ['a'], tracks: 'a.md' },
    });
    const plain = schemaToPlain(document);

    expect(plain['будущееПоле']).toEqual({ a: 1 });
    expect((plain['artifacts'] as Record<string, unknown>[])[0]?.['свояМетка']).toBe(true);
  });

  it('отказы записываются под своим ключом', () => {
    const { document } = schemaFromPlain({ name: 'x', artifacts: [], apply: { requires: [] } });
    const plain = schemaToPlain(setWaiver(document, 'sdd/motivation-first', 'Причина'));

    expect(plain[WAIVERS_KEY]).toEqual([{ rule: 'sdd/motivation-first', reason: 'Причина' }]);
  });

  it('артефакт без идентификатора пропускается с объяснением', () => {
    const { document, problems } = schemaFromPlain({
      name: 'x',
      artifacts: [{ generates: 'a.md' }, { id: 'b', generates: 'b.md' }],
    });

    expect(document.artifacts.map((artifact) => artifact.id)).toEqual(['b']);
    expect(problems[0]).toContain('без идентификатора');
  });
});

describe('правки схемы', () => {
  const base = schemaFromPlain({
    name: 'flow',
    artifacts: [
      { id: 'proposal', generates: 'proposal.md', requires: [] },
      { id: 'specs', generates: 'specs/**/*.md', requires: ['proposal'] },
      { id: 'plan', generates: 'plan.md', requires: ['specs', 'proposal'] },
    ],
    apply: { requires: ['plan'], tracks: 'plan.md' },
  }).document;

  it('добавление артефакта с зависимостью', () => {
    const next = addArtifact(base, { id: 'review', requires: ['specs'] });
    const review = next.artifacts.find((artifact) => artifact.id === 'review');

    expect(review?.requires).toEqual(['specs']);
    expect(review?.generates).toBe('review.md');
    // CLI требует описание у каждого артефакта.
    expect(review?.description).not.toBeNull();
  });

  it('повторный идентификатор отклоняется', () => {
    expect(() => addArtifact(base, { id: 'specs' })).toThrow(/уже есть/);
  });

  it('переименование обновляет зависимости и начало работ', () => {
    const next = updateArtifact(base, 'plan', { id: 'tasks' });

    expect(next.artifacts.map((artifact) => artifact.id)).toEqual(['proposal', 'specs', 'tasks']);
    expect(next.apply.requires).toEqual(['tasks']);

    const renamed = updateArtifact(base, 'proposal', { id: 'why' });
    expect(renamed.artifacts.find((artifact) => artifact.id === 'specs')?.requires).toEqual(['why']);
  });

  it('артефакт не может зависеть от самого себя', () => {
    const next = updateArtifact(base, 'specs', { requires: ['proposal', 'specs'] });
    expect(next.artifacts.find((artifact) => artifact.id === 'specs')?.requires).toEqual([
      'proposal',
    ]);
  });

  it('до удаления виден список зависящих артефактов', () => {
    expect(dependentsOf(base, 'proposal').sort()).toEqual(['plan', 'specs']);
    expect(dependentsOf(base, 'plan')).toEqual([]);
  });

  it('удаление снимает зависимости от удалённого', () => {
    const next = removeArtifact(base, 'proposal');

    expect(next.artifacts.map((artifact) => artifact.id)).toEqual(['specs', 'plan']);
    expect(next.artifacts.find((artifact) => artifact.id === 'specs')?.requires).toEqual([]);
    expect(next.artifacts.find((artifact) => artifact.id === 'plan')?.requires).toEqual(['specs']);
  });

  it('удаление артефакта начала работ убирает его из apply.requires', () => {
    expect(removeArtifact(base, 'plan').apply.requires).toEqual([]);
  });
});
