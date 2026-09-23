import type { IdeConfig } from '../config.js';

/** Настройки агента из конфигурации. */
export type AgentConfig = IdeConfig['agent'];

/** Значения, подставляемые в шаблон аргументов. */
export interface LaunchValues {
  readonly prompt: string;
  readonly format: string;
  readonly approvalMode: string;
  readonly maxWallTime: string;
  readonly maxToolCalls: number;
  readonly model: string | null;
  readonly extraArgs: readonly string[];
}

const PLACEHOLDER = /^\{([a-zA-Z]+)\}$/;

/**
 * Собирает аргументы запуска по шаблону.
 *
 * `{name}` заменяется значением. Если значения нет (`null` или пустая строка),
 * выпадает и сам шаблон, и флаг перед ним: `--model {model}` без модели не
 * должен превращаться в `--model` без аргумента. `{extraArgs}` раскрывается в
 * несколько аргументов.
 */
export function buildArgs(template: readonly string[], values: LaunchValues): string[] {
  const lookup: Record<string, string | readonly string[] | null> = {
    // Промпт, начинающийся с дефиса, CLI принял бы за флаг.
    prompt: values.prompt.startsWith('-') ? ` ${values.prompt}` : values.prompt,
    format: values.format,
    approvalMode: values.approvalMode,
    maxWallTime: values.maxWallTime,
    maxToolCalls: String(values.maxToolCalls),
    model: values.model === null || values.model.trim() === '' ? null : values.model,
    extraArgs: values.extraArgs,
  };

  const args: string[] = [];
  for (const token of template) {
    const match = PLACEHOLDER.exec(token);
    if (match === null) {
      args.push(token);
      continue;
    }
    const value = lookup[match[1] ?? ''];
    if (Array.isArray(value)) {
      args.push(...value);
    } else if (typeof value === 'string') {
      args.push(value);
    } else if (args.length > 0 && (args.at(-1) ?? '').startsWith('-')) {
      args.pop();
    }
  }
  return args;
}

/** Флаги шаблона — для сверки с выводом `--help` установленной сборки. */
export function templateFlags(template: readonly string[]): string[] {
  return template.filter((token) => /^--?[a-z]/i.test(token));
}

/** Переводит предел времени вида `90`, `30s`, `15m`, `1.5h` в миллисекунды. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000;
  return Math.round(value * factor);
}

/** Команда запуска для показа: промпт заменён пометкой, чтобы не дублировать его. */
export function displayCommand(command: string, args: readonly string[], prompt: string): string {
  const quoted = args.map((arg) => {
    if (arg === prompt || arg === ` ${prompt}`) return '"<промпт>"';
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
  });
  return [command, ...quoted].join(' ');
}
