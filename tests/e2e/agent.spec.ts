import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

const FAKE_AGENT = fileURLToPath(new URL('../agent/stub/fake-agent.mjs', import.meta.url));

function agentConfig(root: string, agent: Record<string, unknown> = {}): void {
  mkdirSync(join(root, '.openspec-ide'), { recursive: true });
  writeFileSync(
    join(root, '.openspec-ide', 'config.json'),
    JSON.stringify({ version: 1, agent: { command: FAKE_AGENT, maxWallTime: '60', maxToolCalls: 7, ...agent } }),
  );
}

async function launch(env: Record<string, string | undefined> = {}): Promise<{ ide: LaunchedIde; scenario: (name: string) => void }> {
  chmodSync(FAKE_AGENT, 0o755);
  const ide = await launchIde('full-change', {
    writable: true,
    prepare: (root) => agentConfig(root),
    env: {
      GIGACODE_API_KEY: 'sk-e2e-secret-value',
      // Относительный путь: заглушка запускается в корне рабочего пространства.
      FAKE_AGENT_SCENARIO_FILE: '.openspec-ide/fake-scenario',
      ...env,
    },
  });
  return {
    ide,
    scenario: (name) => writeFileSync(join(ide.root, '.openspec-ide', 'fake-scenario'), name),
  };
}

async function openAgent(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByTestId('change-full-feature').click();
  await page.getByRole('button', { name: 'Агент' }).click();
  await expect(page.getByTestId('agent')).toBeVisible();
}

test.describe('настройки подключения', () => {
  let ide: LaunchedIde;

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('проверка подключения показывает версию и потоковый вывод, настройки сохраняются', async ({ page }) => {
    ({ ide } = await launch());
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Настройки' }).click();

    await page.getByTestId('probe').click();
    await expect(page.getByTestId('probe-result')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('probe-result')).toContainText('1.4.2-fake');
    await expect(page.getByTestId('probe-result')).toContainText('stream-json');
    await expect(page.getByTestId('credentials-state')).toContainText('задана в среде сервера');

    await page.getByLabel('Модель').fill('GigaChat-2-Max');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-message')).toContainText('сохранены');
    const saved = JSON.parse(readFileSync(join(ide.root, '.openspec-ide/config.json'), 'utf8')) as {
      agent: { model: string; credentialsEnv: string };
    };
    expect(saved.agent.model).toBe('GigaChat-2-Max');
    expect(saved.agent.credentialsEnv).toBe('GIGACODE_API_KEY');
    expect(JSON.stringify(saved)).not.toContain('sk-e2e-secret-value');
  });

  test('значение ключа вместо имени переменной отклоняется с инструкцией', async ({ page }) => {
    ({ ide } = await launch());
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Настройки' }).click();

    await page.getByLabel('Переменная с учётными данными').fill('sk-live-pasted-key-123');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-message')).toContainText('переменной окружения');
    expect(readFileSync(join(ide.root, '.openspec-ide/config.json'), 'utf8')).not.toContain('sk-live-pasted-key-123');
  });

  test('незаданная переменная: настройка не завершена, запуск заблокирован', async ({ page }) => {
    ({ ide } = await launch({ GIGACODE_API_KEY: '' }));
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Настройки' }).click();
    await expect(page.getByTestId('credentials-state')).toContainText('не задана');

    // Настройки занимают всю ширину — дерево возвращается с переходом в раздел агента.
    await page.getByRole('button', { name: 'Обозреватель' }).click();
    await page.getByTestId('change-full-feature').click();
    await page.getByRole('button', { name: 'Агент' }).click();
    await expect(page.getByTestId('agent-blocked')).toContainText('GIGACODE_API_KEY');
  });
});

test.describe('запуск агента', () => {
  let ide: LaunchedIde;
  let scenario: (name: string) => void;

  test.beforeEach(async () => {
    ({ ide, scenario } = await launch());
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('режим по умолчанию: промпт из инструкций, ход работы, итог и история', async ({ page }) => {
    scenario('write');
    await openAgent(page, ide.url);
    await page.getByTestId('target-artifact-design').click();

    const confirm = page.getByTestId('run-confirm');
    await expect(page.getByLabel('Промпт запуска')).toHaveValue(/Инструкция схемы «spec-driven»/);
    await expect(page.getByLabel('Режим подтверждения')).toHaveValue('default');
    await expect(confirm).toContainText('--approval-mode default');
    await expect(confirm).toContainText('--max-tool-calls 7');

    await page.getByTestId('run-start').click();
    const view = page.getByTestId('run-view');
    await expect(view).toHaveAttribute('data-outcome', 'success', { timeout: 15_000 });
    await expect(page.getByTestId('run-final')).toContainText('Готово: пункт выполнен.');
    await expect(page.getByTestId('run-files')).toContainText('notes.md');
    await expect(page.getByTestId('run-tokens')).toContainText('320');
    await expect(page.getByTestId('run-log')).toContainText('write_file');
    await expect(page.getByTestId('agent-history').locator('[data-outcome="success"]')).toHaveCount(1);
  });

  test('yolo — только после явного согласия с предупреждением', async ({ page }) => {
    scenario('read');
    await openAgent(page, ide.url);
    await page.getByTestId('target-artifact-design').click();

    await page.getByLabel('Режим подтверждения').selectOption('yolo');
    await expect(page.getByTestId('yolo-warning')).toContainText('без подтверждения');
    await expect(page.getByTestId('run-start')).toBeDisabled();
    await page.getByTestId('yolo-warning').getByRole('checkbox').check();
    await page.getByTestId('run-start').click();

    await expect(page.getByTestId('run-view')).toHaveAttribute('data-outcome', 'success', { timeout: 15_000 });
    await expect(page.getByTestId('run-view')).toContainText('yolo');
  });

  test('режим анализа: CLI получает plan, файлы не меняются', async ({ page }) => {
    scenario('read');
    await openAgent(page, ide.url);
    await page.getByTestId('target-artifact-design').click();
    await page.getByLabel('Режим подтверждения').selectOption('plan');
    await expect(page.getByTestId('run-mode-hint')).toContainText('Файлы не изменяются');
    const before = readFileSync(join(ide.root, 'openspec/changes/full-feature/tasks.md'), 'utf8');
    await page.getByTestId('run-start').click();

    await expect(page.getByTestId('run-view')).toHaveAttribute('data-outcome', 'success', { timeout: 15_000 });
    await expect(page.getByTestId('run-files')).toHaveText('нет');
    expect(existsSync(join(ide.root, 'notes.md'))).toBe(false);
    expect(readFileSync(join(ide.root, 'openspec/changes/full-feature/tasks.md'), 'utf8')).toBe(before);
    await page.getByText('Команда').click();
    await expect(page.getByTestId('run-view')).toContainText('--approval-mode plan');
  });

  test('остановка выполняющегося запуска: исход «прерван»', async ({ page }) => {
    scenario('hang');
    await openAgent(page, ide.url);
    await page.getByTestId('target-artifact-design').click();
    await page.getByTestId('run-start').click();

    await expect(page.getByTestId('run-live')).toBeVisible();
    await expect(page.getByTestId('run-budget')).toContainText('/ 7');
    await expect(page.getByTestId('run-log')).toContainText('read_file');
    await page.getByTestId('run-stop').click();
    await expect(page.getByTestId('run-view')).toHaveAttribute('data-outcome', 'aborted', { timeout: 15_000 });
  });

  test('запуск по пункту плана из метрик: задача и критерий в промпте, запуск в метриках пункта', async ({ page }) => {
    scenario('read');
    await page.goto(ide.url);
    await page.getByTestId('change-full-feature').click();
    await page.getByRole('button', { name: 'Метрики' }).click();
    await page.getByTestId('metrics-row-1.3').click();
    await page.getByTestId('item-agent').click();

    await expect(page.getByLabel('Промпт запуска')).toHaveValue(/Ограничить время ответа[\s\S]*## Критерий приёмки/);
    await page.getByTestId('run-start').click();
    await expect(page.getByTestId('run-view')).toHaveAttribute('data-outcome', 'success', { timeout: 15_000 });

    await page.getByRole('button', { name: 'Метрики' }).click();
    await page.getByTestId('metrics-row-1.3').click();
    await expect(page.getByTestId('item-agent')).toContainText('Запуски агента (1)');
  });
});

test.describe('генерация артефактов агентом', () => {
  let ide: LaunchedIde;
  let scenario: (name: string) => void;

  test.beforeEach(async () => {
    ({ ide, scenario } = await launch());
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('новый change с замыслом: агент готов писать первый артефакт в режиме auto-edit', async ({ page }) => {
    scenario('write');
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Доска' }).click();

    await page.getByTestId('new-change').click();
    await page.getByLabel('Имя изменения').fill('add-export');
    await page.getByTestId('new-change-brief').fill('Выгрузка данных пользователя в CSV с ограничением объёма');
    await expect(page.getByTestId('new-change-generate')).toBeChecked();
    await page.getByRole('button', { name: 'Создать' }).click();

    await expect(page.getByTestId('run-confirm')).toContainText('артефакт proposal');
    await expect(page.getByLabel('Промпт запуска')).toHaveValue(
      /## Замысел автора\s+Выгрузка данных пользователя в CSV с ограничением объёма[\s\S]*## Инструкция схемы/,
    );
    await expect(page.getByLabel('Режим подтверждения')).toHaveValue('auto-edit');
    await expect(page.getByTestId('run-mode-note')).toContainText('default');

    await page.getByTestId('run-start').click();
    await expect(page.getByTestId('run-view')).toHaveAttribute('data-outcome', 'success', { timeout: 15_000 });
    // Настройки не меняются: auto-edit выбран только для этого запуска.
    const config = JSON.parse(readFileSync(join(ide.root, '.openspec-ide/config.json'), 'utf8')) as {
      agent: { approvalMode?: string };
    };
    expect(config.agent.approvalMode ?? 'default').toBe('default');
  });

  test('«Сгенерировать» у несозданного артефакта в панели деталей открывает агента по нему', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Доска' }).click();
    await page.getByTestId('new-change').click();
    await page.getByLabel('Имя изменения').fill('add-thing');
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByTestId('card-add-thing')).toBeVisible();

    await page.getByTestId('card-open-add-thing').click();
    await page.getByTestId('detail-generate-proposal').click();

    await expect(page.getByTestId('run-confirm')).toContainText('артефакт proposal');
    await expect(page.getByLabel('Промпт запуска')).toHaveValue(/openspec\/changes\/add-thing\/proposal\.md/);
    await expect(page.getByLabel('Промпт запуска')).not.toHaveValue(/Замысел автора/);
  });

  test('замысел в разделе «Агент» попадает в промпт, режим остаётся из настроек', async ({ page }) => {
    await openAgent(page, ide.url);

    await page.getByTestId('agent-brief').fill('Описать решение по таймаутам');
    await page.getByTestId('target-artifact-design').click();

    await expect(page.getByLabel('Промпт запуска')).toHaveValue(/## Замысел автора\s+Описать решение по таймаутам/);
    await expect(page.getByLabel('Режим подтверждения')).toHaveValue('default');
  });
});
