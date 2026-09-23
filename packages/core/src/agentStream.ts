/**
 * Разбор вывода агента в формате stream-json (Qwen Code и его форк GigaCode).
 *
 * Разбор нормализующий: сообщения CLI приводятся к небольшому набору событий —
 * текст модели, вызов инструмента, результат инструмента, итог. Всё, чего
 * модель не знает, сохраняется как есть и обработку не прерывает: новая сборка
 * CLI с новым типом события не должна ломать панель агента.
 */

import type { RunOutcome } from './metrics.js';

/** Расход токенов; `null` — CLI значение не сообщил. */
export interface AgentUsage {
  readonly input: number | null;
  readonly output: number | null;
}

/** Нормализованное событие запуска. */
export type AgentEvent =
  | {
      readonly kind: 'init';
      readonly sessionId: string | null;
      readonly model: string | null;
      readonly version: string | null;
      readonly mode: string | null;
    }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool-call';
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'tool-result';
      readonly id: string;
      readonly isError: boolean;
      readonly content: string;
    }
  | {
      readonly kind: 'result';
      readonly ok: boolean;
      readonly subtype: string;
      readonly text: string | null;
      readonly error: string | null;
      readonly usage: AgentUsage;
      readonly durationMs: number | null;
      readonly turns: number | null;
    }
  /** Служебное сообщение CLI, которое панели показывать не нужно. */
  | { readonly kind: 'system'; readonly subtype: string }
  /** Промежуточное событие потока (`stream_event`): учитывается, но не показывается. */
  | { readonly kind: 'partial' }
  /** Сообщение неизвестного типа — сохраняется в необработанном виде. */
  | { readonly kind: 'unknown'; readonly raw: unknown }
  /** Строка, которая не разобралась как JSON: например, оборванная последняя. */
  | { readonly kind: 'malformed'; readonly line: string };

/** Использование токенов из одного сообщения ассистента — для суммирования. */
interface UsageCarrier {
  readonly usage: AgentUsage | null;
}

/** Событие вместе с расходом сообщения, из которого оно получено. */
export type ParsedMessage = { readonly events: readonly AgentEvent[] } & UsageCarrier;

const TOOL_RESULT_LIMIT = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usageOf(value: unknown): AgentUsage | null {
  if (!isRecord(value)) return null;
  const input = num(value['input_tokens']);
  const output = num(value['output_tokens']);
  if (input === null && output === null) return null;
  return { input, output };
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : JSON.stringify(part)))
      .join('');
  }
  return value === undefined ? '' : JSON.stringify(value);
}

function clip(text: string): string {
  return text.length > TOOL_RESULT_LIMIT ? `${text.slice(0, TOOL_RESULT_LIMIT)}…` : text;
}

/** Разбирает одно сообщение CLI в нормализованные события. */
export function parseAgentMessage(value: unknown): ParsedMessage {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return { events: [{ kind: 'unknown', raw: value }], usage: null };
  }

  switch (value['type']) {
    case 'system': {
      const subtype = str(value['subtype']) ?? 'system';
      if (subtype === 'init') {
        return {
          events: [
            {
              kind: 'init',
              sessionId: str(value['session_id']),
              model: str(value['model']),
              version: str(value['qwen_code_version']) ?? str(value['version']),
              mode: str(value['permission_mode']),
            },
          ],
          usage: null,
        };
      }
      return { events: [{ kind: 'system', subtype }], usage: null };
    }

    case 'stream_event':
      return { events: [{ kind: 'partial' }], usage: null };

    case 'assistant':
    case 'user': {
      const message = value['message'];
      if (!isRecord(message)) return { events: [{ kind: 'unknown', raw: value }], usage: null };
      const content = message['content'];
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
      const events: AgentEvent[] = [];
      for (const block of blocks) {
        if (!isRecord(block)) {
          events.push({ kind: 'unknown', raw: block });
          continue;
        }
        switch (block['type']) {
          case 'text':
            // Текст из сообщения пользователя — это эхо промпта или служебная
            // вставка CLI, модель его не писала.
            if (value['type'] === 'assistant' && typeof block['text'] === 'string' && block['text'] !== '') {
              events.push({ kind: 'text', text: block['text'] });
            }
            break;
          case 'thinking':
            events.push({ kind: 'thinking', text: str(block['thinking']) ?? str(block['text']) ?? '' });
            break;
          case 'tool_use':
            events.push({
              kind: 'tool-call',
              id: str(block['id']) ?? '',
              name: str(block['name']) ?? 'неизвестный инструмент',
              input: isRecord(block['input']) ? block['input'] : {},
            });
            break;
          case 'tool_result':
            events.push({
              kind: 'tool-result',
              id: str(block['tool_use_id']) ?? '',
              isError: block['is_error'] === true,
              content: clip(contentText(block['content'])),
            });
            break;
          default:
            events.push({ kind: 'unknown', raw: block });
        }
      }
      return { events, usage: value['type'] === 'assistant' ? usageOf(message['usage']) : null };
    }

    case 'result': {
      const error = isRecord(value['error']) ? str(value['error']['message']) : str(value['error']);
      return {
        events: [
          {
            kind: 'result',
            ok: value['is_error'] !== true,
            subtype: str(value['subtype']) ?? 'result',
            text: str(value['result']),
            error,
            usage: usageOf(value['usage']) ?? { input: null, output: null },
            durationMs: num(value['duration_ms']),
            turns: num(value['num_turns']),
          },
        ],
        usage: null,
      };
    }

    default:
      return { events: [{ kind: 'unknown', raw: value }], usage: null };
  }
}

/** Разбирает строку потока. Пустые строки пропускаются. */
export function parseAgentLine(line: string): ParsedMessage {
  const trimmed = line.trim();
  if (trimmed === '') return { events: [], usage: null };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { events: [{ kind: 'malformed', line: trimmed }], usage: null };
  }
  return parseAgentMessage(value);
}

/**
 * Режет поток байтов на строки NDJSON.
 *
 * Кусок из канала может оборваться посреди строки — хвост ждёт следующего
 * куска. Хвост без перевода строки, оставшийся к концу вывода, отдаётся
 * `end()`: процесс мог быть снят посреди записи, и строка оборвана.
 */
export class NdjsonSplitter {
  #rest = '';

  push(chunk: string): string[] {
    const text = this.#rest + chunk;
    const lines = text.split('\n');
    this.#rest = lines.pop() ?? '';
    return lines.filter((line) => line.trim() !== '');
  }

  end(): string | null {
    const rest = this.#rest;
    this.#rest = '';
    return rest.trim() === '' ? null : rest;
  }
}

/** Разбирает одноразовый вывод (`--output-format json`): массив тех же сообщений. */
export function parseAgentJsonOutput(text: string): ParsedMessage[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text.trim() === '' ? [] : [{ events: [{ kind: 'malformed', line: text.trim() }], usage: null }];
  }
  const messages = Array.isArray(value) ? value : [value];
  return messages.map((message) => parseAgentMessage(message));
}

/** Инструменты, которые меняют файлы: их пути попадают в список затронутых. */
const WRITING_TOOL = /write|edit|replace|create|delete|remove|move|rename|patch/i;
const PATH_KEYS = ['file_path', 'absolute_path', 'path', 'filePath'];

/** Показатели запуска, накопленные по событиям. */
export interface RunTally {
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly toolCalls: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** Пути, которые агент менял, — как их передал CLI (обычно абсолютные). */
  readonly files: readonly string[];
  readonly finalText: string | null;
  readonly result: Extract<AgentEvent, { kind: 'result' }> | null;
  readonly unknownEvents: number;
}

export function emptyTally(): RunTally {
  return {
    sessionId: null,
    model: null,
    toolCalls: 0,
    tokensIn: null,
    tokensOut: null,
    files: [],
    finalText: null,
    result: null,
    unknownEvents: 0,
  };
}

function add(left: number | null, right: number | null): number | null {
  if (right === null) return left;
  return (left ?? 0) + right;
}

/**
 * Добавляет разобранное сообщение к показателям.
 *
 * Токены берутся из итога, если он пришёл: это полный расход. Пока итога нет —
 * например, запуск снят по бюджету, — суммируется расход отдельных сообщений,
 * чтобы собранное к обрыву не терялось.
 */
export function tallyMessage(tally: RunTally, parsed: ParsedMessage): RunTally {
  let next: RunTally = tally;
  if (parsed.usage !== null && next.result === null) {
    next = {
      ...next,
      tokensIn: add(next.tokensIn, parsed.usage.input),
      tokensOut: add(next.tokensOut, parsed.usage.output),
    };
  }
  for (const event of parsed.events) {
    switch (event.kind) {
      case 'init':
        next = { ...next, sessionId: event.sessionId, model: event.model };
        break;
      case 'text':
        next = { ...next, finalText: event.text };
        break;
      case 'tool-call': {
        const path = PATH_KEYS.map((key) => event.input[key]).find(
          (value): value is string => typeof value === 'string' && value !== '',
        );
        const writes = WRITING_TOOL.test(event.name) && path !== undefined && !next.files.includes(path);
        next = {
          ...next,
          toolCalls: next.toolCalls + 1,
          files: writes ? [...next.files, path] : next.files,
        };
        break;
      }
      case 'result':
        next = {
          ...next,
          result: event,
          tokensIn: event.usage.input ?? next.tokensIn,
          tokensOut: event.usage.output ?? next.tokensOut,
          finalText: event.text ?? next.finalText,
        };
        break;
      case 'unknown':
      case 'malformed':
        next = { ...next, unknownEvents: next.unknownEvents + 1 };
        break;
      default:
        break;
    }
  }
  return next;
}

/** Всё, что известно о завершении процесса агента. */
export interface RunEnding {
  readonly exitCode: number | null;
  /** Запуск остановил пользователь. */
  readonly stoppedByUser: boolean;
  /** Сработал сторожевой таймер IDE: CLI не уложился в свой же предел времени. */
  readonly watchdogFired: boolean;
  readonly stderr: string;
  readonly tally: RunTally;
  readonly maxToolCalls: number;
  /** Код выхода, которым CLI сообщает о превышении любого бюджета. */
  readonly budgetExitCode: number;
}

const WALL_TIME = /--max-wall-time|wall-clock budget/i;
const TOOL_CALLS = /--max-tool-calls|tool-call budget/i;

/**
 * Определяет исход запуска.
 *
 * Оба бюджета CLI завершает одним кодом, поэтому какой именно превышен,
 * берётся из текста ошибки; если текста нет — из собственного счётчика
 * вызовов инструментов.
 */
export function classifyOutcome(ending: RunEnding): RunOutcome {
  if (ending.stoppedByUser) return 'aborted';
  if (ending.watchdogFired) return 'budget-time';

  const message = `${ending.stderr}\n${ending.tally.result?.error ?? ''}`;
  if (WALL_TIME.test(message)) return 'budget-time';
  if (TOOL_CALLS.test(message)) return 'budget-tools';
  if (ending.exitCode === ending.budgetExitCode) {
    return ending.tally.toolCalls > ending.maxToolCalls ? 'budget-tools' : 'budget-time';
  }

  if (ending.exitCode === 0) return ending.tally.result?.ok === false ? 'failure' : 'success';
  return 'failure';
}
