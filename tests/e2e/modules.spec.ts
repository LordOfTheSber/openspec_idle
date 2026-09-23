import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

const OPENSPEC = fileURLToPath(new URL('../../node_modules/@fission-ai/openspec/bin/openspec.js', import.meta.url));

async function openSection(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Разделы' }).getByRole('button', { name, exact: true }).click();
}

async function filterBy(page: Page, id: string): Promise<void> {
  await page.getByTestId('module-filter').getByRole('button').first().click();
  await page.getByTestId(`filter-module-${id}`).check();
  await page.getByRole('heading', { level: 1 }).click();
}

test.describe('модули монорепо с картой', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('monorepo', { writable: true });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('раздел «Модули»: группы, граф и панель модуля', async ({ page }) => {
    await page.goto(ide.url);
    await openSection(page, 'Модули');

    await expect(page.getByTestId('module-graph')).toBeVisible();
    await page.getByTestId('module-billing').click();
    const panel = page.getByTestId('module-panel');
    await expect(panel.getByTestId('module-depends')).toContainText('km/core');
    await expect(panel.getByTestId('module-depends')).toContainText('km/events');
    await expect(panel.getByTestId('module-consumers')).toContainText('orders');
    await expect(panel.getByTestId('module-consumers')).toContainText('reports');
    await expect(panel.getByTestId('module-changes')).toContainText('add-invoice-export');
    await expect(panel.getByTestId('module-changes')).toContainText('сквозной');
    await expect(panel.getByTestId('module-specs')).toContainText('billing');

    await page.getByTestId('graph-module-km/core').click();
    await expect(panel).toContainText('КМ Core');
    await expect(panel.getByTestId('module-changes')).toContainText('add-cache-ttl');
  });

  test('дерево по модулям: сквозной change под обоими модулями, спек вне модулей', async ({ page }) => {
    await page.goto(ide.url);
    const billing = page.getByTestId('tree-module-billing');
    const core = page.getByTestId('tree-module-km/core');
    await expect(billing.getByTestId('change-add-invoice-export')).toBeVisible();
    await expect(core.getByTestId('change-add-invoice-export')).toBeVisible();
    await expect(billing.getByTestId('change-add-invoice-export')).toContainText('сквозной');
    await expect(core.getByTestId('change-add-cache-ttl')).toBeVisible();
    await expect(billing.getByTestId('change-add-cache-ttl')).toHaveCount(0);
    await expect(page.getByTestId('tree-outside-modules').getByTestId('capability-ops/runbooks')).toBeVisible();
  });

  test('фильтр billing: доска, поиск и метрики, сохраняется при переключении разделов', async ({ page }) => {
    await page.goto(ide.url);
    await openSection(page, 'Доска');
    await filterBy(page, 'billing');
    await expect(page.getByTestId('card-add-invoice-export')).toBeVisible();
    await expect(page.getByTestId('card-add-invoice-export').getByTestId('card-modules')).toContainText('km/core');
    await expect(page.getByTestId('card-fix-auth-timeout')).toHaveCount(0);
    await expect(page.getByTestId('card-add-cache-ttl')).toHaveCount(0);

    await openSection(page, 'Поиск');
    await expect(page.getByTestId('module-filter')).toContainText('Модули: billing');
    await page.getByLabel('Поиск по рабочему пространству').fill('Вход по паролю');
    await page.getByLabel('Поиск по рабочему пространству').press('Enter');
    await expect(page.getByTestId('search-empty')).toContainText('с текущим фильтром');
    await page.getByLabel('Поиск по рабочему пространству').fill('Нумерация счетов');
    await page.getByLabel('Поиск по рабочему пространству').press('Enter');
    await expect(page.getByTestId('search-hits')).toContainText('billing');

    await openSection(page, 'Метрики');
    await expect(page.getByTestId('module-metrics')).toBeVisible();
    await expect(page.getByTestId('module-metrics-row-add-invoice-export')).toBeVisible();
    await expect(page.getByTestId('module-metrics-row-fix-auth-timeout')).toHaveCount(0);
    await expect(page.getByTestId('module-metrics-items')).toHaveText('1/2');

    // Фильтр помнится и после перезагрузки страницы.
    await page.reload();
    await openSection(page, 'Доска');
    await expect(page.getByTestId('card-fix-auth-timeout')).toHaveCount(0);
  });

  test('change в библиотеке КМ: прямые и транзитивные потребители в деталях и на графе', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('tree-module-km/core').getByTestId('change-add-cache-ttl').click();

    const consumers = page.getByTestId('impact-consumers');
    await expect(consumers.locator('li[data-depth="1"]')).toHaveCount(6);
    await expect(consumers.locator('li[data-depth="2"]')).toHaveCount(2);
    await expect(consumers).toContainText('reports');
    await expect(consumers).toContainText('транзитивный, через billing');

    await page.getByTestId('show-impact').click();
    await expect(page.getByTestId('graph-module-km/core')).toHaveAttribute('data-mark', 'source');
    await expect(page.getByTestId('graph-module-billing')).toHaveAttribute('data-mark', 'direct');
    await expect(page.getByTestId('graph-module-reports')).toHaveAttribute('data-mark', 'transitive');
    await expect(page.getByTestId('graph-module-km/ui-kit')).toHaveAttribute('data-mark', '');
  });

  test('сквозной change: модули при создании, подсказка префикса, дельты по модулям', async ({ page }) => {
    await page.goto(ide.url);
    await openSection(page, 'Доска');
    await page.getByTestId('new-change').click();
    await page.getByLabel('Имя изменения').fill('add-refund-events');
    await page.getByTestId('new-change-module-km/events').check();
    await page.getByTestId('new-change-module-billing').check();
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByTestId('card-add-refund-events')).toContainText('сквозной');
    expect(readFileSync(join(ide.root, 'openspec/changes/add-refund-events/.openspec.yaml'), 'utf8')).toMatch(
      /^schema: spec-driven\ncreated: \S+\nmodules: \[billing, km\/events\]\n$/,
    );

    await openSection(page, 'Обозреватель');
    await page.getByTestId('tree-module-km/events').getByTestId('change-add-refund-events').click();
    await expect(page.getByTestId('delta-prefix-hint')).toContainText('km/events/');
    await expect(page.getByTestId('delta-prefix-hint')).toContainText('billing/');
    await page.getByTestId('add-delta-path').fill('orders/x');
    await expect(page.getByTestId('delta-prefix-warning')).toBeVisible();
    await page.getByTestId('add-delta-path').fill('km/events/refunds');
    await expect(page.getByTestId('delta-prefix-warning')).toHaveCount(0);
    await page.getByTestId('add-delta').click();
    await expect(page.locator('.editor-toolbar')).toContainText('specs/km/events/refunds/spec.md');
    expect(existsSync(join(ide.root, 'openspec/changes/add-refund-events/specs/km/events/refunds/spec.md'))).toBe(true);

    // Дельты сквозного change сгруппированы по модулям.
    await page.getByTestId('tree-module-billing').getByTestId('change-add-invoice-export').click();
    await openSection(page, 'Дельты');
    await expect(page.getByTestId('deltas-module-billing')).toBeVisible();
    await expect(page.getByTestId('deltas-module-km/core')).toBeVisible();
  });

  test('ошибка в карте видна с модулем и полем, остальные модули работают', async ({ page }) => {
    const path = join(ide.root, 'openspec/modules.yaml');
    const text = readFileSync(path, 'utf8').replace('dependsOn: [km/core, km/events]', 'dependsOn: [km/core, km/nope]');
    await import('node:fs').then((fs) => fs.writeFileSync(path, text));
    await page.goto(ide.url);
    await openSection(page, 'Модули');
    await expect(page.getByTestId('module-problems')).toContainText('billing');
    await expect(page.getByTestId('module-problems')).toContainText('Неизвестный модуль km/nope');
    await page.getByTestId('module-orders').click();
    await expect(page.getByTestId('module-depends')).toContainText('billing');
  });
});

test.describe('модули монорепо без карты', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('monorepo', { writable: true, prepare: (root) => unlinkSync(join(root, 'openspec/modules.yaml')) });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('от пустой карты до сохранённого openspec/modules.yaml', async ({ page }) => {
    await page.goto(ide.url);
    // Без карты дерево прежнее.
    await expect(page.getByTestId('change-add-invoice-export')).toBeVisible();
    await expect(page.getByTestId('tree-module-billing')).toHaveCount(0);

    await openSection(page, 'Модули');
    await expect(page.getByTestId('discovery')).toBeVisible();
    const ui = page.getByTestId('draft-ui');
    await expect(ui).toBeVisible();
    await ui.getByLabel('id').fill('web-ui');
    await ui.getByLabel('Название').fill('Веб-интерфейс');
    await ui.getByLabel('Префикс спеков').fill('web-ui');
    const kit = page.getByTestId('draft-km/ui-kit');
    await kit.getByLabel('Вид').selectOption('library');
    await kit.getByLabel('Группа').fill('КМ');
    await page.getByTestId('draft-services/notifications').getByLabel('Включить notifications').uncheck();
    await page.getByTestId('discovery-save').click();

    await expect(page.getByTestId('module-graph')).toBeVisible();
    const saved = readFileSync(join(ide.root, 'openspec/modules.yaml'), 'utf8');
    expect(saved).toContain('id: web-ui');
    expect(saved).toContain('title: Веб-интерфейс');
    expect(saved).toMatch(/id: web-ui[\s\S]*dependsOn: \[km\/ui-kit\]/);
    expect(saved).not.toContain('notifications');
    expect(saved).toMatch(/id: billing[\s\S]*dependsOn: \[km\/core, km\/events\]/);

    // Повторное обнаружение: карта совпадает с кодом, кроме убранного модуля.
    await page.getByTestId('rediscover').click();
    await expect(page.getByTestId('draft-services/notifications')).toBeVisible();
    await expect(page.getByTestId('draft-services/billing')).toHaveCount(0);
  });

  test('сквозной сценарий: карта, сквозной change, потребители, фильтр, архивация', async ({ page }) => {
    rmSync(join(ide.root, 'openspec/changes/add-cache-ttl'), { recursive: true, force: true });
    await page.goto(ide.url);
    await openSection(page, 'Модули');
    await page.getByTestId('discovery-save').click();
    await expect(page.getByTestId('module-graph')).toBeVisible();

    // Сквозной change в библиотеке и сервисе.
    await openSection(page, 'Доска');
    await page.getByTestId('new-change').click();
    await page.getByLabel('Имя изменения').fill('add-core-metrics');
    await page.getByTestId('new-change-module-km/core').check();
    await page.getByTestId('new-change-module-billing').check();
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByTestId('card-add-core-metrics')).toContainText('сквозной');

    await openSection(page, 'Обозреватель');
    await page.getByTestId('tree-module-km/core').getByTestId('change-add-core-metrics').click();
    await expect(page.getByTestId('impact-consumers')).toContainText('orders');
    await expect(page.getByTestId('impact-consumers')).toContainText('reports');

    await openSection(page, 'Доска');
    await filterBy(page, 'auth');
    await expect(page.getByTestId('card-fix-auth-timeout')).toBeVisible();
    await expect(page.getByTestId('card-add-invoice-export')).toHaveCount(0);

    // Архивация сквозного change с дельтами обеих частей.
    await page.getByTestId('module-filter').getByRole('button', { name: 'Сбросить фильтр модулей' }).click();
    await page.getByTestId('card-add-invoice-export').click();
    await page.getByTestId('archive').click();
    await page.getByTestId('archive-confirmed').click();
    await expect(page.getByTestId('card-add-invoice-export')).toHaveCount(0);
    expect(readFileSync(join(ide.root, 'openspec/specs/km/core/spec.md'), 'utf8')).toContain('Сброс по событию');

    const validate = execFileSync(process.execPath, [OPENSPEC, 'validate', '--specs', '--strict'], {
      cwd: ide.root,
      encoding: 'utf8',
    });
    expect(validate).toMatch(/passed/);
  });
});
