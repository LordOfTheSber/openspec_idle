import { type EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * Подсветка и структурные проверки формата OpenSpec поверх markdown.
 *
 * Применяется только к артефактам, порождающим дельты спеков: в обычном
 * артефакте собственной схемы ни требований, ни сценариев быть не обязано, и
 * отмечать их отсутствие как нарушение было бы неверно.
 */

const deltaHeader = Decoration.line({ class: 'cm-osi-delta' });
const requirementHeader = Decoration.line({ class: 'cm-osi-requirement' });
const scenarioHeader = Decoration.line({ class: 'cm-osi-scenario' });
const stepLine = Decoration.line({ class: 'cm-osi-step' });
const problemLine = Decoration.line({ class: 'cm-osi-problem' });

const RE_DELTA = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/;
const RE_REQUIREMENT = /^###\s+Requirement:\s*\S/;
const RE_SCENARIO = /^####\s+Scenario:\s*\S/;
const RE_SCENARIO_WRONG = /^###\s+Scenario:/;
const RE_STEP = /^\s*-\s+\*\*(WHEN|THEN|AND|IF|GIVEN)\*\*/i;

/** Собирает украшения строк по содержимому документа. */
export function buildOpenspecDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (let position = 1; position <= state.doc.lines; position += 1) {
    const line = state.doc.line(position);
    const text = line.text;

    if (RE_SCENARIO_WRONG.test(text)) {
      builder.add(line.from, line.from, problemLine);
    } else if (RE_DELTA.test(text)) {
      builder.add(line.from, line.from, deltaHeader);
    } else if (RE_REQUIREMENT.test(text)) {
      builder.add(line.from, line.from, requirementHeader);
    } else if (RE_SCENARIO.test(text)) {
      builder.add(line.from, line.from, scenarioHeader);
    } else if (RE_STEP.test(text)) {
      builder.add(line.from, line.from, stepLine);
    }
  }

  return builder.finish();
}

/** Расширение подсветки: пересчитывает украшения при каждой правке документа. */
export const openspecDecorations = EditorView.decorations.compute(
  ['doc'],
  buildOpenspecDecorations,
);

/** Тема подсветки, привязанная к токенам интерфейса. */
export const openspecTheme = EditorView.theme({
  '&': { fontSize: '12.5px' },
  '.cm-content': { fontFamily: 'var(--mono)' },
  '.cm-osi-delta': { color: 'var(--accent)', fontWeight: '600' },
  '.cm-osi-requirement': { color: 'var(--text)', fontWeight: '600' },
  '.cm-osi-scenario': { color: 'var(--renamed, #2a5fa8)', fontWeight: '600' },
  '.cm-osi-step': { color: 'var(--added)' },
  '.cm-osi-problem': {
    background: 'var(--removed-soft)',
    color: 'var(--removed)',
    textDecoration: 'underline wavy',
  },
  '.cm-gutters': {
    background: 'var(--surface-2)',
    color: 'var(--muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { background: 'var(--surface-2)' },
  '.cm-activeLineGutter': { background: 'var(--surface-3)' },
});
