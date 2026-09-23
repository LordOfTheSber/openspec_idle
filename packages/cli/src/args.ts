/** Разобранные аргументы командной строки `openspec-ide`. */
export interface CliOptions {
  /** Каталог, с которого начинается поиск корня OpenSpec. */
  readonly path: string;
  /** Явно запрошенный порт; при отсутствии берётся свободный. */
  readonly port: number | null;
  /** Открывать ли браузер после запуска. */
  readonly open: boolean;
  /** Режим разработки: страница берётся у Vite, а не из собранных файлов. */
  readonly dev: boolean;
  /** Показать справку и выйти. */
  readonly help: boolean;
  /** Показать версию и выйти. */
  readonly version: boolean;
}

/** Ошибка разбора аргументов — текст предназначен пользователю. */
export class ArgsError extends Error {}

const HELP = `openspec-ide — локальная среда для работы по OpenSpec

Использование:
  openspec-ide [путь] [опции]

Аргументы:
  путь                 каталог проекта (по умолчанию текущий)

Опции:
  --port <номер>       порт сервера; по умолчанию выбирается свободный
  --no-open            не открывать браузер после запуска
  --dev                режим разработки: страницу отдаёт Vite
  -h, --help           показать эту справку
  -v, --version        показать версию
`;

export function helpText(): string {
  return HELP;
}

/** Разбирает аргументы без внешних зависимостей. */
export function parseArgs(argv: readonly string[]): CliOptions {
  let path: string | null = null;
  let port: number | null = null;
  let open = true;
  let dev = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--no-open') {
      open = false;
    } else if (arg === '--open') {
      open = true;
    } else if (arg === '--dev') {
      dev = true;
    } else if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1];
      if (value === undefined) throw new ArgsError('Опция --port требует номер порта');
      port = parsePort(value);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      port = parsePort(arg.slice('--port='.length));
    } else if (arg.startsWith('-')) {
      throw new ArgsError(`Неизвестная опция: ${arg}`);
    } else if (path === null) {
      path = arg;
    } else {
      throw new ArgsError(`Лишний аргумент: ${arg}. Путь к проекту указывается один раз`);
    }
  }

  return { path: path ?? '.', port, open, dev, help, version };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ArgsError(`Недопустимый порт: ${value}. Ожидается целое число от 1 до 65535`);
  }
  return port;
}
