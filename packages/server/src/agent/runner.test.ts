import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardService } from '../board.js';
import { EventBus, type IdeEvent } from '../events.js';
import { canonicalize } from '../fs/workspace.js';
import { MetricsService } from '../metrics.js';
import { MetricsStore } from '../metricsStore.js';
import { OpenspecClient } from '../openspec/client.js';
import { SchemaReader } from '../schemaDefinition.js';
import { WorkspaceReader } from '../workspace.js';
import { MAX_BRIEF_LENGTH, PromptBuilder, PromptError, normalizeBrief } from './prompt.js';
import { AgentBlockedError, AgentBusyError, AgentConsentError, AgentService } from './runner.js';

const OPENSPEC_BIN = fileURLToPath(new URL('../../../../node_modules/.bin/openspec', import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL('../../../../tests/agent/stub/fake-agent.mjs', import.meta.url));
const SECRET = 'sk-live-secret-value-4242';

let root: string;
let events: IdeEvent[];

interface Setup {
  readonly agent: AgentService;
  readonly prompts: PromptBuilder;
  readonly metrics: MetricsService;
  readonly log: string;
}

function setup(
  options: {
    scenario?: string;
    env?: Record<string, string | undefined>;
    agent?: Record<string, unknown>;
    fixture?: string;
  } = {},
): Setup {
  const source = fileURLToPath(new URL(`../../../../tests/fixtures/${options.fixture ?? 'full-change'}`, import.meta.url));
  cpSync(source, root, { recursive: true });
  chmodSync(FAKE_AGENT, 0o755);
  mkdirSync(join(root, '.openspec-ide'), { recursive: true });
  writeFileSync(
    join(root, '.openspec-ide', 'config.json'),
    JSON.stringify({ version: 1, agent: { command: FAKE_AGENT, maxWallTime: '60', maxToolCalls: 5, ...options.agent } }),
  );

  const client = new OpenspecClient({ root, bin: OPENSPEC_BIN });
  const workspace = new WorkspaceReader(client);
  const schemas = new SchemaReader(client);
  const board = new BoardService(client, workspace, schemas, OPENSPEC_BIN);
  const metrics = new MetricsService({ root, board, workspace, store: new MetricsStore(root) });
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  const log = join(root, 'agent-args.jsonl');
  const agent = new AgentService({
    root,
    events: bus,
    metrics,
    env: {
      PATH: process.env['PATH'],
      GIGACODE_API_KEY: SECRET,
      FAKE_AGENT_SCENARIO: options.scenario ?? 'read',
      FAKE_AGENT_LOG: log,
      ...options.env,
    },
    killGraceMs: 300,
    watchdogGraceMs: 200,
  });
  return { agent, prompts: new PromptBuilder(root, client, schemas, metrics), metrics, log };
}

function loggedArgs(log: string): string[] {
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  return (JSON.parse(lines.at(-1) ?? '{}') as { args: string[] }).args;
}

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-agent-')));
  events = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('настройки и проверка подключения', () => {
  it('незаданная переменная учётных данных блокирует запуск с её именем', async () => {
    const { agent, prompts } = setup({ env: { GIGACODE_API_KEY: undefined } });
    await agent.probe();
    const status = await agent.status();
    expect(status.credentials).toEqual({ env: 'GIGACODE_API_KEY', set: false });
    expect(status.blockers.join(' ')).toMatch(/GIGACODE_API_KEY/);

    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'proposal' });
    const error = await agent.start({ built, prompt: built.prompt }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentBlockedError);
    expect((error as AgentBlockedError).details.join(' ')).toMatch(/GIGACODE_API_KEY не задана/);
  });

  it('успешная проба: версия и потоковый вывод', async () => {
    const { agent } = setup();
    const probe = await agent.probe();
    expect(probe.ok).toBe(true);
    expect(probe.version).toBe('1.4.2-fake');
    expect(probe.streaming).toBe(true);
    expect((await agent.status()).blockers).toEqual([]);
  });

  it('отсутствующий исполняемый файл: перечислены проверенные пути', async () => {
    const { agent } = setup({ agent: { command: 'gigacode-not-installed' }, env: { PATH: '/opt/a:/opt/b' } });
    const probe = await agent.probe();
    expect(probe.ok).toBe(false);
    expect(probe.searched).toEqual(['/opt/a/gigacode-not-installed', '/opt/b/gigacode-not-installed']);
    expect(probe.error).toMatch(/\/opt\/a\/gigacode-not-installed/);
  });

  it('сборка без потокового вывода: переход на одноразовый с уведомлением', async () => {
    const { agent, prompts } = setup({ env: { FAKE_AGENT_LEGACY: '1' }, scenario: 'read' });
    const probe = await agent.probe();
    expect(probe.ok).toBe(true);
    expect(probe.streaming).toBe(false);
    expect(probe.format).toBe('json');
    expect(probe.notice).toMatch(/по завершении/);

    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'proposal' });
    const started = await agent.start({ built, prompt: built.prompt });
    const record = await agent.waitFor(started.runId);
    expect(record?.outcome).toBe('success');
    expect(record?.tokensIn).toBe(320);
    expect(loggedArgs(join(root, 'agent-args.jsonl'))).toContain('json');
  });
});

describe('сборка промпта', () => {
  it('по артефакту: инструкция схемы и путь, по которому его создать', async () => {
    const { prompts } = setup();
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    expect(built.prompt).toMatch(/## Инструкция схемы «spec-driven»/);
    expect(built.prompt).toContain('openspec/changes/full-feature/design.md');
  });

  it('по артефакту с замыслом: замысел автора отдельным разделом перед инструкцией', async () => {
    const { prompts } = setup();
    const built = await prompts.build('full-feature', {
      kind: 'artifact',
      artifact: 'design',
      brief: '  Выгрузка данных пользователя в CSV с лимитом объёма  ',
    });

    expect(built.prompt).toContain('## Замысел автора\n\nВыгрузка данных пользователя в CSV с лимитом объёма');
    expect(built.prompt.indexOf('## Замысел автора')).toBeLessThan(built.prompt.indexOf('## Инструкция схемы'));
    expect(built.target).toEqual({
      kind: 'artifact',
      artifact: 'design',
      brief: 'Выгрузка данных пользователя в CSV с лимитом объёма',
    });
  });

  it('пустой замысел не даёт раздела, длинный обрезается до предела', async () => {
    const { prompts } = setup();
    const empty = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design', brief: '   ' });
    expect(empty.prompt).not.toContain('Замысел автора');
    expect(empty.target).toEqual({ kind: 'artifact', artifact: 'design' });

    expect(normalizeBrief('а'.repeat(MAX_BRIEF_LENGTH + 50))).toHaveLength(MAX_BRIEF_LENGTH);
  });

  it('по пункту плана: текст задачи, критерий приёмки и артефакты change', async () => {
    const { prompts } = setup();
    const targets = await prompts.targets('full-feature');
    const item = targets.items.find((candidate) => !candidate.done);
    expect(item).toBeDefined();
    const built = await prompts.build('full-feature', { kind: 'item', key: item!.key });

    expect(built.prompt).toContain('Ограничить время ответа');
    expect(built.prompt).toMatch(/## Критерий приёмки\s+[^\n#]*тестом на таймаут/);
    expect(built.prompt).toContain('openspec/changes/full-feature/proposal.md');
  });

  it('перечень артефактов берётся из схемы change', async () => {
    const { prompts } = setup({ fixture: 'custom-schema' });
    const targets = await prompts.targets('team-feature');
    expect(targets.artifacts.map((artifact) => artifact.id)).toEqual([
      'research',
      'proposal',
      'specs',
      'spec-review',
      'design',
      'plan',
    ]);
    const built = await prompts.build('team-feature', { kind: 'artifact', artifact: 'spec-review' });
    expect(built.prompt).toContain('Зафиксируй итог ревью спека');
  });

  it('артефакт без инструкции не предлагается', async () => {
    const { prompts } = setup({ fixture: 'custom-schema' });
    const path = join(root, 'openspec/schemas/team-flow/schema.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/ {4}instruction: \|\n {6}Зафиксируй[^\n]*\n[^\n]*\n/, ''));
    const targets = await prompts.targets('team-feature');
    const review = targets.artifacts.find((artifact) => artifact.id === 'spec-review');
    expect(review?.available).toBe(false);
    expect(review?.reason).toMatch(/не описала/);
  });

  it('ошибка команды инструкций: запуска нет, вывод команды показан', async () => {
    const { prompts } = setup();
    const error = await prompts
      .build('full-feature', { kind: 'artifact', artifact: 'no-such-artifact' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).output).toMatch(/no-such-artifact/);
  });
});

describe('запуск и поток событий', () => {
  it('успешный запуск: итог, расход, затронутые файлы и события в шину', async () => {
    const { agent, prompts } = setup({ scenario: 'write' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const started = await agent.start({ built, prompt: built.prompt });
    const record = await agent.waitFor(started.runId);

    expect(record?.outcome).toBe('success');
    expect(record?.exitCode).toBe(0);
    expect(record?.files).toEqual(['notes.md']);
    expect(record?.tokensIn).toBe(320);
    expect(record?.finalText).toBe('Готово: пункт выполнен.');
    expect(events.map((event) => event.type)).toContain('agent-event');
    expect(events.at(-1)?.type).toBe('agent-finished');
    const history = await agent.history('full-feature');
    expect(history[0]?.runId).toBe(started.runId);
  });

  it('неизвестное событие и оборванная строка сохраняются, обработка продолжается', async () => {
    const { agent, prompts } = setup({ scenario: 'unknown' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const started = await agent.start({ built, prompt: built.prompt });
    const record = await agent.waitFor(started.runId);
    const stored = await agent.run(started.runId);

    expect(record?.unknownEvents).toBe(2);
    expect(record?.toolCalls).toBe(1);
    const kinds = stored?.events.map((item) => item.event.kind);
    expect(kinds).toContain('unknown');
    expect(kinds).toContain('malformed');
    expect(kinds).toContain('tool-result');
    expect(stored?.events.find((item) => item.event.kind === 'unknown')?.event).toEqual({
      kind: 'unknown',
      raw: { type: 'thought_summary', text: 'размышление' },
    });
  });

  it('ошибка CLI: неуспех с кодом и выводом в записи', async () => {
    const { agent, prompts } = setup({ scenario: 'apierror' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const record = await agent.waitFor((await agent.start({ built, prompt: built.prompt })).runId);
    expect(record?.outcome).toBe('failure');
    expect(record?.exitCode).toBe(1);
    expect(record?.error).toMatch(/401/);
  });

  it('правленый промпт уходит в CLI и сохраняется в записи', async () => {
    const { agent, prompts, log } = setup({ scenario: 'read' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const edited = `${built.prompt}\n\nДополнение пользователя: без внешних зависимостей.`;
    const record = await agent.waitFor((await agent.start({ built, prompt: edited })).runId);
    expect(loggedArgs(log)[0]).toBe(edited);
    expect(record?.prompt).toBe(edited);
  });
});

describe('бюджеты', () => {
  it('превышение предела вызовов: отдельный исход, собранный расход сохранён', async () => {
    const { agent, prompts, log } = setup({ scenario: 'toolbudget' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const record = await agent.waitFor((await agent.start({ built, prompt: built.prompt })).runId);
    expect(record?.outcome).toBe('budget-tools');
    expect(record?.tokensIn).toBe(120);
    expect(record?.toolCalls).toBe(1);
    const args = loggedArgs(log);
    expect(args[args.indexOf('--max-tool-calls') + 1]).toBe('5');
    expect(args[args.indexOf('--max-wall-time') + 1]).toBe('60');
  });

  it('превышение предела времени по сообщению CLI', async () => {
    const { agent, prompts } = setup({ scenario: 'walltime' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const record = await agent.waitFor((await agent.start({ built, prompt: built.prompt })).runId);
    expect(record?.outcome).toBe('budget-time');
  });

  it('CLI не уложился в свой предел — снимает сторожевой таймер IDE, показатели сохранены', async () => {
    const { agent, prompts } = setup({ scenario: 'hang', agent: { maxWallTime: '1' } });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const record = await agent.waitFor((await agent.start({ built, prompt: built.prompt })).runId);
    expect(record?.outcome).toBe('budget-time');
    expect(record?.toolCalls).toBe(1);
    expect(record?.tokensIn).toBe(120);
  });
});

describe('режимы подтверждения', () => {
  it('по умолчанию — режим с подтверждением изменений', async () => {
    const { agent, prompts, log } = setup();
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const record = await agent.waitFor((await agent.start({ built, prompt: built.prompt })).runId);
    const args = loggedArgs(log);
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('default');
    expect(record?.approvalMode).toBe('default');
  });

  it('yolo без явного согласия не запускается, с согласием — запускается', async () => {
    const { agent, prompts, log } = setup();
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    await expect(agent.start({ built, prompt: built.prompt, approvalMode: 'yolo' })).rejects.toBeInstanceOf(
      AgentConsentError,
    );
    await agent.waitFor((await agent.start({ built, prompt: built.prompt, approvalMode: 'yolo', confirmYolo: true })).runId);
    const args = loggedArgs(log);
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('yolo');
  });

  it('режим анализа передаётся CLI', async () => {
    const { agent, prompts, log } = setup();
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    await agent.waitFor((await agent.start({ built, prompt: built.prompt, approvalMode: 'plan' })).runId);
    const args = loggedArgs(log);
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('plan');
  });
});

describe('остановка, блокировка и журнал', () => {
  it('остановка: мягкий сигнал, исход «прерван», показатели сохранены', async () => {
    const { agent, prompts } = setup({ scenario: 'hang' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const started = await agent.start({ built, prompt: built.prompt });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(agent.stop(started.runId)).toBe(true);
    const record = await agent.waitFor(started.runId);
    expect(record?.outcome).toBe('aborted');
    expect(record?.signal).toBe('SIGTERM');
    expect(record?.tokensIn).toBe(120);
  });

  it('процесс, игнорирующий мягкий сигнал, снимается принудительно', async () => {
    const { agent, prompts } = setup({ scenario: 'hang', env: { FAKE_AGENT_IGNORE_TERM: '1' } });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const started = await agent.start({ built, prompt: built.prompt });
    await new Promise((resolve) => setTimeout(resolve, 600));
    agent.stop(started.runId);
    const record = await agent.waitFor(started.runId);
    expect(record?.outcome).toBe('aborted');
    expect(record?.signal).toBe('SIGKILL');
  });

  it('параллельный запуск по тому же change указывает на выполняющийся', async () => {
    const { agent, prompts } = setup({ scenario: 'hang' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const first = await agent.start({ built, prompt: built.prompt });
    const error = await agent.start({ built, prompt: built.prompt }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentBusyError);
    expect((error as AgentBusyError).runningRunId).toBe(first.runId);
    agent.stop(first.runId);
    await agent.waitFor(first.runId);
  });

  it('значение секрета вырезается из промпта, событий и журнала', async () => {
    const { agent, prompts } = setup({ scenario: 'echo-prompt' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    const started = await agent.start({ built, prompt: `${built.prompt}\nключ: ${SECRET}` });
    const record = await agent.waitFor(started.runId);

    expect(record?.prompt).toContain('[скрыто: $GIGACODE_API_KEY]');
    const onDisk = readFileSync(join(root, '.openspec-ide/agent/history.jsonl'), 'utf8') +
      readFileSync(join(root, `.openspec-ide/agent/runs/${started.runId}.jsonl`), 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain('[скрыто: $GIGACODE_API_KEY]');
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(existsSync(join(root, '.openspec-ide/.gitignore'))).toBe(true);
  });
});

describe('связь с метриками', () => {
  it('запуск по задаче попадает в метрики этой задачи', async () => {
    const { agent, prompts, metrics } = setup({ scenario: 'read' });
    const targets = await prompts.targets('full-feature');
    const key = targets.items.find((item) => !item.done)!.key;
    const built = await prompts.build('full-feature', { kind: 'item', key });
    await agent.waitFor((await agent.start({ built, prompt: built.prompt })).runId);

    const view = await metrics.view('full-feature');
    if (!view.tracked) throw new Error('план не отслеживается');
    const item = view.items.find((candidate) => candidate.key === key);
    expect(item?.runs.total).toBe(1);
    expect(item?.tokensIn).toBe(320);
    expect(view.summary.runs).toBe(1);
  });

  it('запуск по артефакту — только в сводке change', async () => {
    const { agent, prompts, metrics } = setup({ scenario: 'read' });
    const built = await prompts.build('full-feature', { kind: 'artifact', artifact: 'design' });
    await agent.waitFor((await agent.start({ built, prompt: built.prompt })).runId);

    const view = await metrics.view('full-feature');
    if (!view.tracked) throw new Error('план не отслеживается');
    expect(view.summary.runs).toBe(1);
    expect(view.items.every((item) => item.runs.total === 0)).toBe(true);
  });
});
