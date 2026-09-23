import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { loadConfig, saveConfig, SecretInConfigError } from './config.js';
import { EventBus, encodeSse } from './events.js';
import { SESSION_HEADER, SESSION_QUERY, SessionToken } from './http/session.js';
import { OutsideWorkspaceError } from './http/paths.js';
import { injectToken, placeholderPage, readBuiltPage } from './http/page.js';
import { OpenspecClient } from './openspec/client.js';
import { type CliLocation, locateOpenspecCli, missingCliNotice } from './openspec/locate.js';
import { runCli } from './openspec/exec.js';
import type { AgentRunRecord } from './agent/store.js';
import { WorkspaceWatcher } from './watcher.js';
import { ModuleService } from './modules/service.js';
import { ModuleMapError, type ModuleInput } from './modules/mapStore.js';
import { writeChangeModules } from './modules/changeMeta.js';
import { MODULE_KINDS, type ModuleKind, type ModuleOverlay } from '@openspec-ide/core';
import { WorkspaceReader } from './workspace.js';
import { DeltaReader } from './deltas.js';
import { BoardService, ChangeOperationError } from './board.js';
import { SchemaReader } from './schemaDefinition.js';
import { SchemaOperationError, SchemaRegistry } from './schemaRegistry.js';
import { MetricsService, UnknownItemError } from './metrics.js';
import { MetricsStore } from './metricsStore.js';
import { ArtifactCreationError, SNIPPETS, createArtifact } from './artifacts.js';
import { StaleWriteError, WriteFailedError, readArtifactFile, saveArtifactFile } from './files.js';
import { ValidationRunner } from './validation.js';
import { PromptBuilder, PromptError, type RunTarget } from './agent/prompt.js';
import {
  APPROVAL_MODES,
  AgentBlockedError,
  AgentBusyError,
  AgentConsentError,
  AgentService,
  type ApprovalMode,
} from './agent/runner.js';

/** Адрес, на котором сервер принимает соединения. Только петлевой интерфейс. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Настройки запуска сервера. */
export interface ServerOptions {
  /** Корень рабочего пространства — каталог, содержащий `openspec/`. */
  readonly root: string | null;
  /** Запрошенный порт; `null` — взять свободный. */
  readonly port: number | null;
  /** Режим разработки: страницу отдаёт Vite, сервер отдаёт только API. */
  readonly dev: boolean;
  /** Не поднимать наблюдатель за файлами — нужно тестам. */
  readonly watch?: boolean;
  /** Окно объединения событий наблюдателя, мс. */
  readonly debounceMs?: number;
  /** Каталог собранной страницы SPA; по умолчанию — dist пакета web. */
  readonly webDist?: string;
  /**
   * Встроенный CLI OpenSpec: используется, если ни в репозитории, ни в PATH
   * своего нет. Десктопное приложение передаёт CLI из своей поставки.
   */
  readonly openspecFallback?: string | null;
}

/** Запущенный сервер. */
export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly root: string | null;
  readonly token: string;
  readonly events: EventBus;
  /** Выполняющиеся запуски агента — чтобы спросить перед закрытием окна. */
  activeAgentRuns(): AgentRunRecord[];
  /** Останавливает все запуски агента и ждёт их завершения. */
  stopAgentRuns(): Promise<void>;
  close(): Promise<void>;
}

/** Порт занят другим процессом. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(
      `Порт ${port} уже занят другим процессом. ` +
        'Запустите без опции --port, чтобы взять свободный порт.',
    );
    this.name = 'PortInUseError';
  }
}

interface AppParts {
  readonly app: FastifyInstance;
  readonly token: SessionToken;
  readonly events: EventBus;
  readonly watcher: WorkspaceWatcher | null;
  readonly agent: AgentService | null;
}

/** Модули владельца результата поиска: change или capability. */
function ownerModules(overlay: ModuleOverlay, owner: string): readonly string[] {
  const change = overlay.changes[owner];
  if (change !== undefined) return change;
  const capability = overlay.capabilities[owner];
  return capability === undefined || capability === null ? [] : [capability];
}

/** Проверяет модули из запроса на запись карты. */
function parseModuleInputs(value: unknown): ModuleInput[] {
  if (!Array.isArray(value)) throw new ModuleMapError('Нужен список модулей');
  return value.map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const field = (name: string): string => {
      const text = entry[name];
      if (typeof text !== 'string' || text.trim() === '') {
        throw new ModuleMapError(`Модуль ${index + 1}: не заполнено поле ${name}`);
      }
      return text.trim();
    };
    const kind = field('kind');
    if (!(MODULE_KINDS as readonly string[]).includes(kind)) {
      throw new ModuleMapError(`Модуль ${index + 1}: неизвестный вид ${kind}`);
    }
    const group = typeof entry['group'] === 'string' && entry['group'].trim() !== '' ? entry['group'].trim() : null;
    const dependsOn = Array.isArray(entry['dependsOn'])
      ? entry['dependsOn'].filter((id): id is string => typeof id === 'string' && id !== '')
      : [];
    return {
      id: field('id'),
      title: field('title'),
      kind: kind as ModuleKind,
      path: field('path'),
      specs: field('specs'),
      group,
      dependsOn,
    };
  });
}

/** Собирает приложение, не открывая сокет. */
export function createApp(options: ServerOptions): AppParts {
  const app = Fastify({ logger: false });
  const token = SessionToken.create();
  const events = new EventBus();
  const { root } = options;

  const found = root === null ? null : locateOpenspecCli(root);
  const location: CliLocation | null =
    found?.kind === 'not-found' &&
    typeof options.openspecFallback === 'string' &&
    existsSync(options.openspecFallback)
      ? { kind: 'found', bin: options.openspecFallback, source: 'bundled' }
      : found;
  let cliVersion: Promise<string | null> | null = null;
  const readCliVersion = (): Promise<string | null> => {
    if (location?.kind !== 'found' || root === null) return Promise.resolve(null);
    cliVersion ??= runCli({ bin: location.bin, cwd: root }, ['--version']).then((result) =>
      result.code === 0 ? result.stdout.trim().split('\n')[0] ?? null : null,
    );
    return cliVersion;
  };
  const client =
    root !== null && location?.kind === 'found'
      ? new OpenspecClient({ root, bin: location.bin })
      : null;
  const reader = client === null ? null : new WorkspaceReader(client);
  const deltas = client === null || reader === null ? null : new DeltaReader(client, reader);
  const schemaReader = client === null ? null : new SchemaReader(client);
  const board =
    client === null || reader === null || schemaReader === null || location?.kind !== 'found'
      ? null
      : new BoardService(client, reader, schemaReader, location.bin);
  const schemas =
    client === null || location?.kind !== 'found' ? null : new SchemaRegistry(client, location.bin);
  const metrics =
    root === null || board === null || reader === null
      ? null
      : new MetricsService({
          root,
          board,
          workspace: reader,
          store: new MetricsStore(root, (message) => console.error(`[метрики] ${message}`)),
        });
  const agent =
    root === null ? null : new AgentService({ root, events, metrics });
  const modules =
    root === null || reader === null ? null : new ModuleService({ root, workspace: reader, metrics });
  const prompts =
    root === null || client === null || schemaReader === null || metrics === null
      ? null
      : new PromptBuilder(root, client, schemaReader, metrics);
  app.addHook('onClose', async () => agent?.shutdown());

  const validation =
    root !== null && location?.kind === 'found'
      ? new ValidationRunner({ bin: location.bin, cwd: root })
      : null;

  // Проверка токена на каждом обращении к API. Loopback сам по себе не
  // защищает: обратиться к localhost может любой процесс на машине, включая
  // код в открытой вкладке браузера.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.url.startsWith('/api/session')) return;

    const header = request.headers[SESSION_HEADER];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const fromQuery = (request.query as Record<string, string> | undefined)?.[SESSION_QUERY];

    if (!token.matches(fromHeader) && !token.matches(fromQuery)) {
      await reply.code(401).send({ error: 'Требуется токен сессии' });
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof OutsideWorkspaceError) {
      await reply.code(403).send({ error: error.message });
      return;
    }
    if (error instanceof StaleWriteError) {
      await reply.code(409).send({ error: error.message, path: error.path, disk: error.disk });
      return;
    }
    if (error instanceof WriteFailedError) {
      await reply.code(500).send({ error: error.message, path: error.path });
      return;
    }
    if (error instanceof ArtifactCreationError) {
      await reply.code(400).send({ error: error.message });
      return;
    }
    if (error instanceof UnknownItemError) {
      await reply.code(404).send({ error: error.message });
      return;
    }
    if (error instanceof ChangeOperationError) {
      await reply.code(400).send({ error: error.message, output: error.output });
      return;
    }
    if (error instanceof PromptError) {
      await reply.code(400).send({ error: error.message, output: error.output });
      return;
    }
    if (error instanceof AgentBusyError) {
      await reply.code(409).send({ error: error.message, runningRunId: error.runningRunId });
      return;
    }
    if (error instanceof AgentConsentError) {
      await reply.code(400).send({ error: error.message, consentRequired: true });
      return;
    }
    if (error instanceof AgentBlockedError) {
      await reply.code(400).send({ error: error.message, details: error.details });
      return;
    }
    if (error instanceof SchemaOperationError) {
      await reply.code(400).send({ error: error.message, details: error.details });
      return;
    }
    if (error instanceof ModuleMapError) {
      await reply.code(400).send({ error: error.message });
      return;
    }
    if (error instanceof SecretInConfigError) {
      await reply.code(400).send({ error: error.message, field: error.field });
      return;
    }
    await reply.code(500).send({
      error: error instanceof Error ? error.message : String(error),
    });
  });

  app.get('/api/health', async () => ({
    status: 'ok' as const,
    root,
    dev: options.dev,
    // Какой CLI OpenSpec работает: из репозитория, из PATH или встроенный.
    cli:
      location?.kind === 'found'
        ? { source: location.source, bin: location.bin, version: await readCliVersion() }
        : null,
  }));

  app.get('/api/workspace', async () => {
    if (root === null) {
      return {
        state: 'not-initialized' as const,
        hint: 'openspec init',
        message:
          'В этом каталоге и выше по дереву нет каталога openspec/. ' +
          'Заведите проект командой openspec init.',
      };
    }
    if (location?.kind === 'not-found') {
      return { state: 'cli-missing' as const, notice: missingCliNotice(location) };
    }
    const { tree, errors } = await reader!.readTree();
    return { state: 'ready' as const, root, tree, errors, modules: await modules!.view(tree) };
  });

  app.get('/api/search', async (request) => {
    if (reader === null) return { hits: [] as const };
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const text = query['q'] ?? '';
    const kinds = (query['kinds'] ?? '')
      .split(',')
      .map((kind) => kind.trim())
      .filter((kind) => kind !== '');

    const { tree } = await reader.readTree();
    const index = await reader.buildSearchIndex(tree);
    const { overlay } = await modules!.view(tree);
    return {
      hits: index.search(text, kinds as never[]).map((hit) => ({ ...hit, modules: ownerModules(overlay, hit.owner) })),
    };
  });

  app.get('/api/board', async () => {
    if (board === null || modules === null) throw new Error('CLI OpenSpec недоступен');
    const [result, view] = await Promise.all([board.readBoard(), modules.view()]);
    return {
      ...result,
      cards: result.cards.map((card) => ({ ...card, modules: view.overlay.changes[card.change] ?? [] })),
    };
  });

  const needModules = (): ModuleService => {
    if (modules === null) throw new Error('CLI OpenSpec недоступен');
    return modules;
  };

  app.get('/api/modules', async () => needModules().view());

  app.put('/api/modules', async (request) => {
    const body = (request.body ?? {}) as { modules?: unknown };
    return needModules().save(parseModuleInputs(body.modules));
  });

  app.get('/api/modules/discover', async () => needModules().discover());

  app.get('/api/modules/impact', async (request) => {
    const change = ((request.query as Record<string, string | undefined>) ?? {})['change'];
    if (change === undefined || change === '') throw new Error('Не указано имя change');
    return needModules().impact(change);
  });

  app.get('/api/modules/metrics', async (request) => {
    const ids = (((request.query as Record<string, string | undefined>) ?? {})['ids'] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    return needModules().metrics(ids);
  });

  app.post('/api/change', async (request) => {
    if (board === null) throw new Error('CLI OpenSpec недоступен');
    const body = (request.body ?? {}) as { name?: string; schema?: string; modules?: unknown };
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw new ChangeOperationError('Не указано имя изменения', '');
    }
    const changeModules = Array.isArray(body.modules)
      ? body.modules.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : [];
    if (body.schema !== undefined && body.schema !== '' && schemas !== null) {
      // Схема, не прошедшая проверку, недоступна и для назначения change.
      try {
        await schemas.ensureAssignable(body.schema);
      } catch (error) {
        if (error instanceof SchemaOperationError) {
          throw new ChangeOperationError(error.message, error.details.join('\n'));
        }
        throw error;
      }
    }
    await board.createChange(body.name.trim(), body.schema);
    // Сквозной change начинается без дельт: модули записываются явно, в
    // порядке карты — так файл не зависит от порядка выбора.
    if (changeModules.length > 0 && root !== null) {
      const order = (await modules!.store.read()).modules.map((module) => module.id);
      const rank = (id: string): number => (order.includes(id) ? order.indexOf(id) : order.length);
      await writeChangeModules(root, body.name.trim(), [...changeModules].sort((a, b) => rank(a) - rank(b)));
    }
    return { created: body.name.trim() };
  });

  app.post('/api/archive', async (request) => {
    if (board === null) throw new Error('CLI OpenSpec недоступен');
    const body = (request.body ?? {}) as { name?: string };
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw new ChangeOperationError('Не указано имя изменения', '');
    }
    await board.archiveChange(body.name.trim());
    return { archived: body.name.trim() };
  });

  const needSchemas = (): SchemaRegistry => {
    if (schemas === null) throw new Error('CLI OpenSpec недоступен');
    return schemas;
  };
  const schemaName = (value: unknown): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new SchemaOperationError('Не указано имя схемы');
    }
    return value.trim();
  };

  app.get('/api/schemas', async () => {
    const registry = needSchemas();
    return { schemas: await registry.list(), default: await registry.defaultSchema() };
  });

  app.get('/api/schema', async (request) => {
    const query = (request.query as Record<string, string | undefined>) ?? {};
    return needSchemas().read(schemaName(query['name']));
  });

  app.put('/api/schema', async (request) => {
    const body = (request.body ?? {}) as { name?: string; text?: string };
    if (typeof body.text !== 'string') throw new SchemaOperationError('Нет текста схемы');
    return needSchemas().save(schemaName(body.name), body.text);
  });

  app.post('/api/schema', async (request) => {
    const body = (request.body ?? {}) as { name?: string; from?: string | null };
    const from = typeof body.from === 'string' && body.from.trim() !== '' ? body.from.trim() : null;
    return needSchemas().create(schemaName(body.name), from);
  });

  app.get('/api/schema/check', async (request) => {
    const query = (request.query as Record<string, string | undefined>) ?? {};
    return needSchemas().check(schemaName(query['name']));
  });

  app.post('/api/schema/assign', async (request) => {
    const body = (request.body ?? {}) as { name?: string };
    return needSchemas().assign(schemaName(body.name));
  });

  app.get('/api/schema/template', async (request) => {
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const template = query['template'];
    if (template === undefined || template === '') throw new SchemaOperationError('Не указан шаблон');
    const content = await needSchemas().readTemplate(schemaName(query['name']), template);
    return { template, content, exists: content !== null };
  });

  app.put('/api/schema/template', async (request) => {
    const body = (request.body ?? {}) as { name?: string; template?: string; content?: string };
    if (typeof body.template !== 'string' || body.template === '' || typeof body.content !== 'string') {
      throw new SchemaOperationError('Нужны путь шаблона и его содержимое');
    }
    await needSchemas().writeTemplate(schemaName(body.name), body.template, body.content);
    return { template: body.template, saved: true };
  });

  app.get('/api/items', async (request) => {
    if (board === null) throw new Error('CLI OpenSpec недоступен');
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const change = query['change'];
    if (change === undefined || change === '') throw new Error('Не указано имя change');
    return board.readTrackedItems(change);
  });

  app.put('/api/items', async (request) => {
    if (board === null) throw new Error('CLI OpenSpec недоступен');
    const body = (request.body ?? {}) as { change?: string; line?: number; done?: boolean };
    if (typeof body.change !== 'string' || typeof body.line !== 'number') {
      throw new Error('Нужны имя change и номер строки пункта');
    }
    return board.toggleItem(body.change, body.line, body.done === true);
  });

  app.get('/api/metrics', async (request) => {
    if (metrics === null) throw new Error('CLI OpenSpec недоступен');
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const change = query['change'];
    if (change === undefined || change === '') throw new Error('Не указано имя change');
    return metrics.view(change);
  });

  app.post('/api/metrics/start', async (request) => {
    if (metrics === null) throw new Error('CLI OpenSpec недоступен');
    const body = (request.body ?? {}) as { change?: string; key?: string };
    if (typeof body.change !== 'string' || typeof body.key !== 'string') {
      throw new Error('Нужны имя change и ключ пункта');
    }
    await metrics.start(body.change, body.key);
    return metrics.view(body.change);
  });

  app.put('/api/metrics/acceptance', async (request) => {
    if (metrics === null) throw new Error('CLI OpenSpec недоступен');
    const body = (request.body ?? {}) as { change?: string; key?: string; command?: string };
    if (
      typeof body.change !== 'string' ||
      typeof body.key !== 'string' ||
      typeof body.command !== 'string' ||
      body.command.trim() === ''
    ) {
      throw new Error('Нужны имя change, ключ пункта и команда проверки');
    }
    await metrics.bindAcceptance(body.change, body.key, body.command.trim());
    return metrics.view(body.change);
  });

  app.post('/api/metrics/acceptance/run', async (request) => {
    if (metrics === null) throw new Error('CLI OpenSpec недоступен');
    const body = (request.body ?? {}) as { change?: string; key?: string };
    if (typeof body.change !== 'string' || typeof body.key !== 'string') {
      throw new Error('Нужны имя change и ключ пункта');
    }
    const result = await metrics.runAcceptance(body.change, body.key);
    return { result, view: await metrics.view(body.change) };
  });

  app.get('/api/metrics/export', async (request) => {
    if (metrics === null) throw new Error('CLI OpenSpec недоступен');
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const change = query['change'];
    return metrics.export(change === undefined || change === '' ? undefined : change);
  });

  app.get('/api/deltas', async (request) => {
    if (deltas === null) throw new Error('CLI OpenSpec недоступен');
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const change = query['change'];
    if (change === undefined || change === '') throw new Error('Не указано имя change');
    return deltas.readChangeDeltas(change);
  });

  app.get('/api/spec', async (request) => {
    if (deltas === null) throw new Error('CLI OpenSpec недоступен');
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const capability = query['capability'];
    if (capability === undefined || capability === '') {
      throw new Error('Не указан путь capability');
    }
    return { spec: await deltas.readSpec(capability) };
  });

  app.get('/api/compare', async (request) => {
    if (deltas === null) throw new Error('CLI OpenSpec недоступен');
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const { change, capability, requirement } = query;
    if (change === undefined || capability === undefined || requirement === undefined) {
      throw new Error('Нужны change, capability и requirement');
    }
    return { comparison: await deltas.compare(change, capability, requirement) };
  });

  app.get('/api/capability-map', async () => {
    if (deltas === null) throw new Error('CLI OpenSpec недоступен');
    return deltas.buildMap();
  });

  app.get('/api/file', async (request) => {
    if (root === null) throw new Error('Рабочее пространство не определено');
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const path = query['path'];
    if (path === undefined || path === '') throw new Error('Не указан путь файла');
    return readArtifactFile(root, path);
  });

  app.put('/api/file', async (request) => {
    if (root === null) throw new Error('Рабочее пространство не определено');
    const body = (request.body ?? {}) as {
      path?: string;
      content?: string;
      baseVersion?: string | null;
    };
    if (typeof body.path !== 'string' || typeof body.content !== 'string') {
      throw new Error('Нужны путь файла и его содержимое');
    }
    return saveArtifactFile(root, body.path, body.content, body.baseVersion ?? null);
  });

  app.post('/api/artifact', async (request) => {
    if (client === null) throw new Error('CLI OpenSpec недоступен');
    const body = (request.body ?? {}) as {
      change?: string;
      artifact?: string;
      capabilityPath?: string;
    };
    if (typeof body.change !== 'string' || typeof body.artifact !== 'string') {
      throw new ArtifactCreationError('Нужны имя change и идентификатор артефакта');
    }
    return createArtifact(client, {
      change: body.change,
      artifact: body.artifact,
      capabilityPath: body.capabilityPath,
    });
  });

  app.get('/api/snippets', async () => SNIPPETS);

  app.get('/api/validate', async (request) => {
    if (validation === null) throw new Error('CLI OpenSpec недоступен');
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const change = query['change'];
    if (change === undefined || change === '') throw new Error('Не указано имя change');
    return validation.run(change);
  });

  app.get('/api/config', async () => {
    if (root === null) throw new Error('Рабочее пространство не определено');
    return loadConfig(root);
  });

  app.put('/api/config', async (request) => {
    if (root === null) throw new Error('Рабочее пространство не определено');
    return { config: await saveConfig(root, request.body) };
  });

  const needAgent = (): { agent: AgentService; prompts: PromptBuilder } => {
    if (agent === null || prompts === null) throw new Error('CLI OpenSpec недоступен');
    return { agent, prompts };
  };
  const readTarget = (value: unknown): RunTarget => {
    const target = (value ?? {}) as { kind?: string; artifact?: string; key?: string };
    if (target.kind === 'artifact' && typeof target.artifact === 'string') {
      return { kind: 'artifact', artifact: target.artifact };
    }
    if (target.kind === 'item' && typeof target.key === 'string') return { kind: 'item', key: target.key };
    throw new PromptError('Не указана цель запуска: артефакт или пункт плана');
  };
  const readChange = (value: unknown): string => {
    if (typeof value !== 'string' || value.trim() === '') throw new PromptError('Не указано имя change');
    return value.trim();
  };

  app.get('/api/agent/status', async () => {
    const { agent: service } = needAgent();
    return { ...(await service.status()), effective: await service.effective() };
  });

  app.post('/api/agent/probe', async () => {
    const { agent: service } = needAgent();
    await service.probe();
    return { ...(await service.status()), effective: await service.effective() };
  });

  app.get('/api/agent/targets', async (request) => {
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const change = readChange(query['change']);
    const { agent: service, prompts: builder } = needAgent();
    return { ...(await builder.targets(change)), running: service.running(change) };
  });

  app.post('/api/agent/prompt', async (request) => {
    const body = (request.body ?? {}) as { change?: string; target?: unknown };
    const { agent: service, prompts: builder } = needAgent();
    const built = await builder.build(readChange(body.change), readTarget(body.target));
    return { ...built, effective: await service.effective() };
  });

  app.post('/api/agent/run', async (request) => {
    const body = (request.body ?? {}) as {
      change?: string;
      target?: unknown;
      prompt?: string;
      approvalMode?: string;
      confirmYolo?: boolean;
    };
    const { agent: service, prompts: builder } = needAgent();
    const built = await builder.build(readChange(body.change), readTarget(body.target));
    const mode = body.approvalMode;
    if (mode !== undefined && !(APPROVAL_MODES as readonly string[]).includes(mode)) {
      throw new AgentBlockedError(`Неизвестный режим подтверждения «${mode}»`);
    }
    return service.start({
      built,
      prompt: typeof body.prompt === 'string' ? body.prompt : built.prompt,
      ...(mode === undefined ? {} : { approvalMode: mode as ApprovalMode }),
      confirmYolo: body.confirmYolo === true,
    });
  });

  app.post('/api/agent/stop', async (request) => {
    const body = (request.body ?? {}) as { runId?: string };
    const { agent: service } = needAgent();
    return { stopped: typeof body.runId === 'string' && service.stop(body.runId) };
  });

  app.get('/api/agent/runs', async (request) => {
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const { agent: service } = needAgent();
    return { runs: await service.history(readChange(query['change'])) };
  });

  app.get('/api/agent/run', async (request, reply) => {
    const query = (request.query as Record<string, string | undefined>) ?? {};
    const { agent: service } = needAgent();
    const found = await service.run(query['id'] ?? '');
    if (found === null) {
      await reply.code(404).send({ error: `Запуск «${query['id'] ?? ''}» не найден` });
      return;
    }
    return found;
  });

  app.get('/api/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(encodeSse({ type: 'connected', payload: { root } }));

    let id = 0;
    const unsubscribe = events.subscribe((event) => {
      id += 1;
      reply.raw.write(encodeSse(event, id));
    });

    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // Страница отдаётся только в собранном виде: в режиме разработки её отдаёт
  // Vite, а сервер занимается одним API.
  if (!options.dev) {
    const distDir =
      options.webDist ??
      fileURLToPath(new URL('../../web/dist/', import.meta.url));

    void app.register(fastifyStatic, { root: distDir, wildcard: false, index: false });

    app.get('/', async (_request, reply) => {
      const html = await readBuiltPage(distDir);
      await reply
        .type('text/html; charset=utf-8')
        .send(
          html === null
            ? placeholderPage('Собранная страница не найдена.')
            : injectToken(html, token.value),
        );
    });
  }

  const watcher =
    root !== null && options.watch !== false
      ? new WorkspaceWatcher(
          options.debounceMs === undefined
            ? { root }
            : { root, debounceMs: options.debounceMs },
          (batch) => {
            client?.invalidate();
            schemaReader?.invalidate();
            // Отметки, поставленные в обход IDE, попадают в журнал с моментом,
            // когда их заметил наблюдатель, а не при следующем открытии метрик.
            void metrics?.reconcileAll().catch((error: unknown) =>
              console.error(`[метрики] ${error instanceof Error ? error.message : String(error)}`),
            );
            events.emit({ type: 'workspace-changed', payload: batch });
          },
        )
      : null;

  return { app, token, events, watcher, agent };
}

/** Поднимает сервер на петлевом интерфейсе. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { app, token, events, watcher, agent } = createApp(options);

  try {
    await app.listen({ host: LOOPBACK_HOST, port: options.port ?? 0 });
  } catch (error) {
    await app.close().catch(() => undefined);
    if (isAddressInUse(error) && options.port !== null) {
      throw new PortInUseError(options.port);
    }
    throw error;
  }

  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('Не удалось определить порт, на котором запущен сервер');
  }

  await watcher?.start();

  return {
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    port: address.port,
    root: options.root,
    token: token.value,
    events,
    activeAgentRuns: () => agent?.activeRuns() ?? [],
    stopAgentRuns: async () => {
      if (agent === null) return;
      await Promise.all(
        agent.activeRuns().map(async (run) => {
          agent.stop(run.runId);
          await agent.waitFor(run.runId);
        }),
      );
    },
    close: async () => {
      await watcher?.stop();
      await app.close();
    },
  };
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}
