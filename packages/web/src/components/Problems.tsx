/** Одно замечание валидации, как его отдаёт сервер. */
export interface ValidationEntry {
  readonly level: 'ERROR' | 'WARNING' | 'INFO';
  readonly message: string;
  readonly file: string | null;
  readonly line: number | null;
}

/** Состояние панели проверок. */
export interface ValidationState {
  readonly entries: readonly ValidationEntry[];
  readonly valid: boolean;
  readonly error: string | null;
  /** Результат относится к уже устаревшему содержимому. */
  readonly stale: boolean;
  readonly running: boolean;
}

const LEVEL_CLASS: Record<ValidationEntry['level'], string> = {
  ERROR: 'e',
  WARNING: 'w',
  INFO: 'i',
};

const LEVEL_LABEL: Record<ValidationEntry['level'], string> = {
  ERROR: 'ОШ',
  WARNING: 'ПРЕД',
  INFO: 'ИНФ',
};

export function Problems({
  state,
  onOpen,
}: {
  readonly state: ValidationState;
  readonly onOpen: (file: string, line: number | null) => void;
}) {
  if (state.error !== null) {
    return (
      <p className="notice error" role="alert" data-testid="validation-error">
        {state.error}
      </p>
    );
  }

  if (state.entries.length === 0) {
    // Зелёным окрашивается только пройденная проверка: «ещё не выполнялась» и
    // «выполняется» — это отсутствие результата, а не успех.
    return (
      <p
        className={state.valid && !state.running ? 'notice ok' : 'empty'}
        data-testid="validation-clean"
      >
        {state.running
          ? 'Проверка выполняется…'
          : state.valid
            ? 'Проверки пройдены без замечаний.'
            : 'Проверка ещё не выполнялась.'}
      </p>
    );
  }

  return (
    <ul
      className={state.stale ? 'problems stale' : 'problems'}
      data-testid="validation-entries"
      data-stale={state.stale}
    >
      {state.entries.map((entry, position) => (
        <li key={`${entry.level}-${entry.line ?? position}-${position}`}>
          <span className={`sev ${LEVEL_CLASS[entry.level]}`}>{LEVEL_LABEL[entry.level]}</span>
          {entry.file === null ? (
            <span>{entry.message}</span>
          ) : (
            <button
              type="button"
              className="problem-link"
              onClick={() => onOpen(entry.file as string, entry.line)}
            >
              {entry.message}
              <span className="where">
                {entry.file}
                {entry.line === null ? '' : `:${entry.line}`}
              </span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
