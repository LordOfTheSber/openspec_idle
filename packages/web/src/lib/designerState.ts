import type { SchemaDocument } from '@openspec-ide/core';
import { type YamlProblem, parseSchemaYaml, stringifySchema } from './schemaYaml.js';

/**
 * Состояние конструктора схемы.
 *
 * Источник истины — текст YAML: его сохраняют на диск и его понимает CLI.
 * Граф и форма работают с моделью, разобранной из текста; их правка
 * пересобирает текст. Пока текст не разбирается, модель — последнее корректное
 * состояние, помеченное устаревшим, и правка графом и формой запрещена:
 * она затёрла бы то, что человек сейчас набирает в YAML.
 */
export interface DesignerState {
  readonly name: string;
  readonly text: string;
  /** Последнее корректное состояние модели. */
  readonly document: SchemaDocument | null;
  /** Текст не разбирается: модель устарела относительно текста. */
  readonly stale: boolean;
  readonly yamlError: YamlProblem | null;
  /** Выбранный артефакт — открыт в форме и выделен на графе. */
  readonly selected: string | null;
  /**
   * Счётчик замен текста моделью. Редактор YAML владеет своим буфером и
   * подставляет текст извне только при смене этого счётчика.
   */
  readonly textRevision: number;
  /** Текст, совпадающий с файлом на диске. */
  readonly savedText: string;
  /** Отказ правки модели — например, занятый идентификатор. */
  readonly editError: string | null;
}

export type DesignerAction =
  | { readonly type: 'load'; readonly name: string; readonly text: string }
  | { readonly type: 'edit-text'; readonly text: string }
  | {
      readonly type: 'edit-model';
      readonly change: (document: SchemaDocument) => SchemaDocument;
      /** Артефакт, который выбрать после правки. */
      readonly select?: string | null | undefined;
    }
  | { readonly type: 'select'; readonly artifact: string | null }
  | { readonly type: 'saved'; readonly text: string };

export function initialDesigner(name: string, text: string): DesignerState {
  const { document, error } = parseSchemaYaml(text, name);
  return {
    name,
    text,
    document,
    stale: error !== null,
    yamlError: error,
    selected: document?.artifacts[0]?.id ?? null,
    textRevision: 0,
    savedText: text,
    editError: null,
  };
}

export function designerReducer(state: DesignerState, action: DesignerAction): DesignerState {
  switch (action.type) {
    case 'load':
      return { ...initialDesigner(action.name, action.text), textRevision: state.textRevision + 1 };

    case 'edit-text': {
      const { document, error } = parseSchemaYaml(action.text, state.name);
      if (document === null) {
        return { ...state, text: action.text, stale: true, yamlError: error, editError: null };
      }
      const selected =
        state.selected !== null && document.artifacts.some((artifact) => artifact.id === state.selected)
          ? state.selected
          : (document.artifacts[0]?.id ?? null);
      return {
        ...state,
        text: action.text,
        document,
        stale: false,
        yamlError: null,
        selected,
        editError: null,
      };
    }

    case 'edit-model': {
      if (state.stale || state.document === null) return state;
      let document: SchemaDocument;
      try {
        document = action.change(state.document);
      } catch (error) {
        return { ...state, editError: error instanceof Error ? error.message : String(error) };
      }
      return {
        ...state,
        document,
        text: stringifySchema(document),
        textRevision: state.textRevision + 1,
        selected: action.select === undefined ? state.selected : action.select,
        editError: null,
      };
    }

    case 'select':
      return { ...state, selected: action.artifact };

    case 'saved':
      return { ...state, savedText: action.text };
  }
}

/** Есть несохранённые правки. */
export function isDirty(state: DesignerState): boolean {
  return state.text !== state.savedText;
}
