import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, RunOutcome } from '@openspec-ide/core';
import { IDE_DIR } from '../config.js';
import type { RunTarget } from './prompt.js';

/** Запись о запуске агента. */
export interface AgentRunRecord {
  readonly runId: string;
  readonly change: string;
  readonly target: RunTarget;
  readonly label: string;
  /** Промпт, с которым запуск ушёл в CLI, — с вырезанными секретами. */
  readonly prompt: string;
  readonly approvalMode: string;
  readonly model: string | null;
  readonly format: string;
  readonly streaming: boolean;
  /** Команда для показа: промпт заменён пометкой. */
  readonly command: string;
  readonly limits: { readonly maxWallTime: string; readonly maxToolCalls: number };
  readonly startedAt: string;
  readonly state: 'running' | 'finished';
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: RunOutcome | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly toolCalls: number;
  /** Затронутые файлы относительно корня рабочего пространства. */
  readonly files: readonly string[];
  readonly finalText: string | null;
  readonly error: string | null;
  readonly stderr: string;
  readonly sessionId: string | null;
  readonly unknownEvents: number;
}

/** Событие запуска с моментом получения. */
export interface StoredAgentEvent {
  readonly at: string;
  readonly event: AgentEvent;
}

const AGENT_DIR = 'agent';
const HISTORY_FILE = 'history.jsonl';

/**
 * Вырезает значения секретов из всего, что уходит на диск или в интерфейс.
 *
 * Секрет — значение переменной окружения, помеченной в настройках. Имя
 * переменной остаётся в метке: по ней видно, что было скрыто.
 */
export class Redactor {
  readonly #secrets: readonly { readonly name: string; readonly value: string }[];

  constructor(names: readonly string[], env: NodeJS.ProcessEnv) {
    this.#secrets = names
      .map((name) => ({ name, value: env[name] ?? '' }))
      // Короткое значение совпало бы со случайными словами текста.
      .filter((secret) => secret.value.length >= 6)
      .sort((a, b) => b.value.length - a.value.length);
  }

  text(value: string): string {
    let result = value;
    for (const secret of this.#secrets) result = result.split(secret.value).join(`[скрыто: $${secret.name}]`);
    return result;
  }

  /** Вырезает секреты из любого сериализуемого значения. */
  value<T>(value: T): T {
    if (this.#secrets.length === 0) return value;
    return JSON.parse(this.text(JSON.stringify(value))) as T;
  }
}

/** Журнал запусков: история по changes и события каждого запуска. */
export class AgentRunStore {
  readonly #dir: string;

  constructor(root: string) {
    this.#dir = join(root, IDE_DIR, AGENT_DIR);
  }

  async #ensure(): Promise<void> {
    await mkdir(join(this.#dir, 'runs'), { recursive: true });
    // Каталог IDE целиком вне git: журнал — локальные данные разработчика.
    const ignore = join(this.#dir, '..', '.gitignore');
    try {
      await stat(ignore);
    } catch {
      await writeFile(ignore, '*\n', 'utf8');
    }
  }

  async appendEvents(runId: string, events: readonly StoredAgentEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.#ensure();
    await appendFile(
      join(this.#dir, 'runs', `${runId}.jsonl`),
      events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      'utf8',
    );
  }

  async finish(record: AgentRunRecord): Promise<void> {
    await this.#ensure();
    await appendFile(join(this.#dir, HISTORY_FILE), `${JSON.stringify(record)}\n`, 'utf8');
  }

  async history(): Promise<AgentRunRecord[]> {
    let text: string;
    try {
      text = await readFile(join(this.#dir, HISTORY_FILE), 'utf8');
    } catch {
      return [];
    }
    const records: AgentRunRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line) as AgentRunRecord);
      } catch {
        // Оборванная строка после сбоя не должна прятать остальную историю.
      }
    }
    return records;
  }

  async events(runId: string): Promise<StoredAgentEvent[]> {
    if (!/^[\w-]+$/.test(runId)) return [];
    let text: string;
    try {
      text = await readFile(join(this.#dir, 'runs', `${runId}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as StoredAgentEvent];
        } catch {
          return [];
        }
      });
  }
}
