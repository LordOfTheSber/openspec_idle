import { type SchemaDocument, schemaFromPlain, schemaToPlain } from '@openspec-ide/core';
import { LineCounter, parseDocument, stringify } from 'yaml';

/** Ошибка разбора YAML с местом, где она случилась. */
export interface YamlProblem {
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
}

/** Разбирает текст схемы; при ошибке сообщает строку и столбец. */
export function parseSchemaYaml(
  text: string,
  fallbackName: string,
): { document: SchemaDocument | null; error: YamlProblem | null } {
  const counter = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: counter, prettyErrors: false });
  const first = parsed.errors[0];
  if (first !== undefined) {
    const position = counter.linePos(first.pos[0]);
    return {
      document: null,
      error: {
        message: first.message.split('\n')[0] ?? first.message,
        line: position.line,
        column: position.col,
      },
    };
  }
  return { document: schemaFromPlain(parsed.toJS(), fallbackName).document, error: null };
}

/**
 * Текст схемы по модели.
 *
 * Правка на графе или в форме пересобирает YAML целиком: порядок ключей
 * стабилен, неизвестные ключи сохранены, но комментарии теряются — поэтому
 * их стоит писать в описаниях и инструкциях, а не в YAML.
 */
export function stringifySchema(document: SchemaDocument): string {
  return stringify(schemaToPlain(document), { lineWidth: 0 });
}

export function formatProblem(problem: YamlProblem): string {
  return problem.line === null
    ? problem.message
    : `строка ${problem.line}, столбец ${problem.column}: ${problem.message}`;
}
