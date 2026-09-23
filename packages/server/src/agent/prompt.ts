import { relative } from 'node:path';
import type { MetricsService } from '../metrics.js';
import { toPosixPath } from '../process/platform.js';
import type { OpenspecClient } from '../openspec/client.js';
import type { SchemaReader } from '../schemaDefinition.js';

/** Цель запуска: артефакт схемы или пункт плана. */
export type RunTarget =
  | { readonly kind: 'artifact'; readonly artifact: string }
  | { readonly kind: 'item'; readonly key: string };

/** Отказ в сборке промпта; `output` — вывод команды OpenSpec, если он был. */
export class PromptError extends Error {
  constructor(
    message: string,
    readonly output: string = '',
  ) {
    super(message);
    this.name = 'PromptError';
  }
}

/** Что можно запустить по change. */
export interface RunTargets {
  readonly change: string;
  readonly schema: string | null;
  /** Артефакты схемы change — в её порядке, а не из фиксированного списка. */
  readonly artifacts: readonly {
    readonly id: string;
    readonly available: boolean;
    /** Почему запуск недоступен. */
    readonly reason: string | null;
  }[];
  readonly items: readonly {
    readonly key: string;
    readonly text: string;
    readonly done: boolean;
  }[];
}

/** Собранный промпт. */
export interface BuiltPrompt {
  readonly change: string;
  readonly target: RunTarget;
  /** Подпись цели для журнала и интерфейса. */
  readonly label: string;
  readonly prompt: string;
}

function rel(root: string, path: string): string {
  const value = relative(root, path);
  return value === '' ? '.' : toPosixPath(value);
}

/**
 * Собирает промпт запуска из инструкций OpenSpec.
 *
 * IDE промпт не сочиняет: основа — вывод `openspec instructions`, то есть то,
 * что схема процесса предписывает для артефакта. К нему добавляется контекст
 * пункта плана, если запуск по задаче.
 */
export class PromptBuilder {
  readonly #root: string;
  readonly #client: OpenspecClient;
  readonly #schemas: SchemaReader;
  readonly #metrics: MetricsService;

  constructor(root: string, client: OpenspecClient, schemas: SchemaReader, metrics: MetricsService) {
    this.#root = root;
    this.#client = client;
    this.#schemas = schemas;
    this.#metrics = metrics;
  }

  async targets(change: string): Promise<RunTargets> {
    const status = await this.#client.status(change);
    if (!status.ok) throw new PromptError(`Не удалось прочитать состояние «${change}»`, status.message);
    const definition = await this.#schemas.read(status.data.schemaName);

    const artifacts = status.data.artifacts.map((artifact) => {
      const declared = definition?.artifacts.find((item) => item.id === artifact.id);
      const available = declared?.hasInstruction ?? false;
      return {
        id: artifact.id,
        available,
        reason: available
          ? null
          : `Схема «${status.data.schemaName}» не описала, что делать с артефактом «${artifact.id}»: у него нет инструкции.`,
      };
    });

    const view = await this.#metrics.view(change);
    return {
      change,
      schema: status.data.schemaName,
      artifacts,
      // Схема без отслеживаемого артефакта: запуск по пунктам недоступен.
      items: view.tracked
        ? view.items.map((item) => ({ key: item.key, text: item.text, done: item.state === 'done' }))
        : [],
    };
  }

  async build(change: string, target: RunTarget): Promise<BuiltPrompt> {
    return target.kind === 'artifact' ? this.#forArtifact(change, target.artifact) : this.#forItem(change, target.key);
  }

  async #forArtifact(change: string, artifact: string): Promise<BuiltPrompt> {
    this.#client.invalidate();
    const result = await this.#client.instructions(artifact, change);
    if (!result.ok) {
      throw new PromptError(
        `Команда «openspec instructions ${artifact} --change ${change}» завершилась ошибкой`,
        `${result.message}\n${result.stdout}\n${result.stderr}`.trim(),
      );
    }
    const data = result.data;
    const instruction = data.instruction?.trim() ?? '';
    if (instruction === '') {
      throw new PromptError(
        `Схема «${data.schemaName ?? '?'}» не описала, что делать с артефактом «${artifact}»: у него нет инструкции.`,
      );
    }

    const output = data.resolvedOutputPath ?? data.outputPath ?? null;
    const sections = [
      `# Артефакт «${artifact}» изменения «${change}»`,
      data.description === undefined ? '' : data.description,
      `## Инструкция схемы «${data.schemaName ?? ''}»\n\n${instruction}`,
      output === null ? '' : `## Куда писать\n\nСоздай или обнови файл \`${rel(this.#root, output)}\`.`,
      (data.dependencies ?? []).length === 0
        ? ''
        : `## Контекст\n\nОпирайся на уже готовые артефакты:\n${(data.dependencies ?? [])
            .map((dependency) => `- ${dependency.id}${dependency.path === undefined ? '' : `: \`${rel(this.#root, dependency.path)}\``}`)
            .join('\n')}`,
      (data.rules ?? []).length === 0 ? '' : `## Правила проекта\n\n${(data.rules ?? []).map((rule) => `- ${rule}`).join('\n')}`,
      data.template === undefined || data.template.trim() === ''
        ? ''
        : `## Шаблон\n\n\`\`\`markdown\n${data.template.trim()}\n\`\`\``,
    ];

    return {
      change,
      target: { kind: 'artifact', artifact },
      label: `артефакт ${artifact}`,
      prompt: sections.filter((section) => section !== '').join('\n\n'),
    };
  }

  async #forItem(change: string, key: string): Promise<BuiltPrompt> {
    const view = await this.#metrics.view(change);
    if (!view.tracked) throw new PromptError(view.reason);
    const item = view.items.find((candidate) => candidate.key === key);
    if (item === undefined) throw new PromptError(`В плане «${change}» нет пункта «${key}»`);

    this.#client.invalidate();
    const result = await this.#client.applyInstructions(change);
    if (!result.ok) {
      throw new PromptError(
        `Команда «openspec instructions apply --change ${change}» завершилась ошибкой`,
        `${result.message}\n${result.stdout}\n${result.stderr}`.trim(),
      );
    }
    const data = result.data;
    const context = Object.entries(data.contextFiles ?? {}).flatMap(([artifact, files]) =>
      files.map((file) => `- ${artifact}: \`${rel(this.#root, file)}\``),
    );
    const criterion = item.acceptance.criterion;
    const command = item.acceptance.command;

    const sections = [
      `# Пункт ${key} плана изменения «${change}»`,
      `## Задача\n\n${item.work}`,
      `## Критерий приёмки\n\n${
        criterion ?? 'В тексте пункта критерий не указан — сформулируй, как проверить результат, и проверь его.'
      }${command === null ? '' : `\n\nПроверка: команда \`${command}\` должна завершиться с кодом 0.`}`,
      data.instruction === undefined || data.instruction.trim() === '' ? '' : `## Как работать\n\n${data.instruction.trim()}`,
      `Работай только над этим пунктом. Когда критерий приёмки выполнен, отметь пункт выполненным в отслеживаемом файле плана.`,
      context.length === 0 ? '' : `## Артефакты change\n\n${context.join('\n')}`,
    ];

    return {
      change,
      target: { kind: 'item', key },
      label: `пункт ${key}`,
      prompt: sections.filter((section) => section !== '').join('\n\n'),
    };
  }
}
