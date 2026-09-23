import { addArtifact, updateArtifact } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { designerReducer, initialDesigner, isDirty } from './designerState.js';
import { parseSchemaYaml } from './schemaYaml.js';

const TEXT = `name: flow
version: 1
description: Процесс
artifacts:
  - id: proposal
    generates: proposal.md
    description: Зачем
    template: proposal.md
    instruction: Объясни зачем.
    requires: []
  - id: specs
    generates: specs/**/*.md
    description: Контракт
    template: spec.md
    instruction: Опиши требования.
    requires: [proposal]
apply:
  requires: [specs]
  tracks: tasks.md
`;

describe('конструктор: три синхронных представления', () => {
  it('артефакт, добавленный на графе, появляется в YAML с зависимостью и открывается в форме', () => {
    const start = initialDesigner('flow', TEXT);
    const next = designerReducer(start, {
      type: 'edit-model',
      change: (document) => addArtifact(document, { id: 'tasks', requires: ['specs'] }),
      select: 'tasks',
    });

    const reparsed = parseSchemaYaml(next.text, 'flow').document;
    expect(reparsed?.artifacts.find((artifact) => artifact.id === 'tasks')?.requires).toEqual(['specs']);
    expect(next.selected).toBe('tasks');
    expect(next.textRevision).toBe(start.textRevision + 1);
    expect(isDirty(next)).toBe(true);
  });

  it('правка поля формы попадает в YAML и в граф', () => {
    const start = initialDesigner('flow', TEXT);
    const next = designerReducer(start, {
      type: 'edit-model',
      change: (document) => updateArtifact(document, 'specs', { generates: 'specs/**/spec.md' }),
    });

    expect(next.text).toMatch(/generates: specs\/\*\*\/spec\.md/);
    expect(next.document?.artifacts[1]?.generates).toBe('specs/**/spec.md');
  });

  it('ручная правка YAML перестраивает модель графа и формы', () => {
    const start = initialDesigner('flow', TEXT);
    const next = designerReducer(start, {
      type: 'edit-text',
      text: TEXT.replace('requires: [proposal]', 'requires: []'),
    });

    expect(next.stale).toBe(false);
    expect(next.document?.artifacts[1]?.requires).toEqual([]);
    // Текст пришёл из редактора — подставлять его обратно не нужно.
    expect(next.textRevision).toBe(start.textRevision);
  });

  it('некорректный YAML: модель — последнее корректное состояние, помечена устаревшей', () => {
    const start = initialDesigner('flow', TEXT);
    const broken = designerReducer(start, { type: 'edit-text', text: `${TEXT}  - id: [\n` });

    expect(broken.stale).toBe(true);
    expect(broken.yamlError?.line).toBeGreaterThan(0);
    expect(broken.document).toBe(start.document);

    const ignored = designerReducer(broken, {
      type: 'edit-model',
      change: (document) => addArtifact(document, { id: 'x' }),
    });
    expect(ignored).toBe(broken);

    const fixed = designerReducer(broken, { type: 'edit-text', text: TEXT });
    expect(fixed.stale).toBe(false);
    expect(fixed.yamlError).toBeNull();
  });

  it('отказ правки модели сообщается, состояние не меняется', () => {
    const start = initialDesigner('flow', TEXT);
    const next = designerReducer(start, {
      type: 'edit-model',
      change: (document) => updateArtifact(document, 'specs', { id: 'proposal' }),
    });

    expect(next.editError).toMatch(/уже есть/);
    expect(next.text).toBe(TEXT);
  });

  it('после сохранения правок нет', () => {
    const edited = designerReducer(initialDesigner('flow', TEXT), {
      type: 'edit-text',
      text: TEXT.replace('Процесс', 'Процесс команды'),
    });
    expect(isDirty(edited)).toBe(true);
    expect(isDirty(designerReducer(edited, { type: 'saved', text: edited.text }))).toBe(false);
  });
});
