import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { useEffect, useRef } from 'react';
import { openspecDecorations, openspecTheme } from '../lib/openspecHighlight.js';

interface EditorProps {
  /** Содержимое, подставляемое при смене ключа документа. */
  readonly content: string;
  /**
   * Ключ документа. Меняется только когда содержимое пришло извне: файл
   * открыт, взята версия с диска, артефакт создан.
   *
   * Буфером владеет редактор. Подставлять в него значение из состояния React
   * на каждую правку нельзя: правка приходит туда асинхронно, и к моменту
   * перерисовки документ уже ушёл вперёд — замена вернула бы его назад,
   * перемешав набранный текст.
   */
  readonly documentKey: number;
  readonly onChange: (content: string) => void;
  readonly onSave: () => void;
  /** Подсветка формата OpenSpec — только для артефактов, порождающих спеки. */
  readonly openspecFormat: boolean;
  /** Строка, к которой нужно прокрутить редактор. */
  readonly revealLine: number | null;
}

export function Editor({
  content,
  documentKey,
  onChange,
  onSave,
  openspecFormat,
  revealLine,
}: EditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const contentRef = useRef(content);
  contentRef.current = content;

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (host.current === null) return;

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown(),
      EditorView.lineWrapping,
      openspecTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
      ...(openspecFormat ? [openspecDecorations] : []),
    ];

    const instance = new EditorView({
      state: EditorState.create({ doc: contentRef.current, extensions }),
      parent: host.current,
    });
    view.current = instance;

    return () => {
      instance.destroy();
      view.current = null;
    };
    // Пересоздание только при смене режима подсветки: набор расширений
    // фиксируется при создании состояния, а содержимое читается через ref.
  }, [openspecFormat]);

  // Содержимое подставляется только при смене ключа документа: открыт другой
  // файл, взята версия с диска, создан артефакт.
  useEffect(() => {
    const instance = view.current;
    if (instance === null) return;
    const next = contentRef.current;
    if (instance.state.doc.toString() === next) return;
    instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: next } });
  }, [documentKey]);

  useEffect(() => {
    const instance = view.current;
    if (instance === null || revealLine === null) return;
    if (revealLine < 1 || revealLine > instance.state.doc.lines) return;

    const line = instance.state.doc.line(revealLine);
    instance.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    instance.focus();
  }, [revealLine]);

  return <div className="editor-host" ref={host} data-testid="editor" />;
}
