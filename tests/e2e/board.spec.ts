import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

async function openBoard(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('button', { name: 'Доска' }).click();
  await expect(page.getByTestId('board')).toBeVisible();
}

/** Открывает панель деталей change щелчком по имени на карточке. */
async function openCard(page: Page, change: string): Promise<void> {
  await page.getByTestId(`card-open-${change}`).click();
  await expect(page.getByTestId('change-detail')).toBeVisible();
}

test.describe('доска на встроенной схеме', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('full-change', { writable: true });
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('колонки идут по зависимостям артефактов и заканчиваются рабочими', async ({ page }) => {
    await openBoard(page, ide.url);

    for (const id of ['proposal', 'specs', 'design', 'tasks', 'ready', 'in-progress', 'to-archive']) {
      await expect(page.getByTestId(`column-${id}`)).toBeVisible();
    }
  });

  test('карточка стоит в колонке «В работе» и несёт схему, прогресс и время изменения', async ({ page }) => {
    await openBoard(page, ide.url);

    const card = page.getByTestId('card-full-feature');
    await expect(page.getByTestId('column-in-progress')).toContainText('full-feature');
    await expect(card).toContainText('spec-driven');
    await expect(card).toContainText('2/4 пунктов');
    await expect(card.getByTestId('card-age')).toContainText('изменён');
  });

  test('пустые колонки свёрнуты в полосы и разворачиваются щелчком', async ({ page }) => {
    await openBoard(page, ide.url);

    const proposal = page.getByTestId('column-proposal');
    await expect(proposal).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('column-in-progress')).not.toHaveAttribute('data-collapsed', 'true');

    await proposal.click();
    await expect(page.getByTestId('column-proposal')).not.toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('column-proposal').locator('h3')).toHaveText('proposal');
  });

  test('на узкой панели доска показана списком фаз, а выбранный режим запоминается', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 800 });
    await openBoard(page, ide.url);

    await expect(page.locator('.board-pane')).toHaveAttribute('data-mode', 'list');
    await expect(page.getByTestId('column-in-progress')).toContainText('full-feature');

    await page.getByTestId('board-mode-columns').click();
    await expect(page.locator('.board-pane')).toHaveAttribute('data-mode', 'columns');

    await page.reload();
    await page.getByRole('button', { name: 'Доска' }).click();
    await expect(page.locator('.board-pane')).toHaveAttribute('data-mode', 'columns');
    await page.getByTestId('board-mode-auto').click();
  });

  test('панель деталей показывает пункты по группам и закрывается по Esc', async ({ page }) => {
    await openBoard(page, ide.url);
    await openCard(page, 'full-feature');

    const detail = page.getByTestId('change-detail');
    await expect(detail.locator('.group-title').first()).toContainText('1.');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('change-detail')).toHaveCount(0);
    await expect(page.getByTestId('board')).toBeVisible();
  });

  test('«Метрики» в панели деталей открывает раздел метрик этого change', async ({ page }) => {
    await openBoard(page, ide.url);
    await openCard(page, 'full-feature');

    await page.getByTestId('detail-metrics').click();

    await expect(page.locator('.toolbar h1')).toHaveText('Метрики');
    await expect(page.getByText('Выберите изменение в дереве слева')).toHaveCount(0);
  });

  test('метка артефакта на карточке открывает его в редакторе', async ({ page }) => {
    await openBoard(page, ide.url);

    await page.getByTestId('card-artifact-full-feature-design').click();

    await expect(page.locator('.toolbar h1')).toHaveText('Обозреватель');
  });

  test('проверка с карточки показывает результат в панели деталей', async ({ page }) => {
    await openBoard(page, ide.url);

    await page.getByTestId('card-validity-full-feature').click();

    await expect(page.getByTestId('detail-validation')).toBeVisible();
    await expect(page.getByTestId('validation-clean')).toContainText('без замечаний');
  });

  test('отметка пункта пишется в файл и не трогает остальные строки', async ({ page }) => {
    await openBoard(page, ide.url);
    await openCard(page, 'full-feature');

    const path = join(ide.root, 'openspec/changes/full-feature/tasks.md');
    const before = readFileSync(path, 'utf8');

    await page.getByTestId('item-1.3').check();
    await expect(page.getByTestId('card-full-feature')).toContainText('3/4 пунктов');

    const after = readFileSync(path, 'utf8');
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const changed = beforeLines.filter((line, index) => line !== afterLines[index]);

    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('1.3');
  });

  test('правка файла в обход IDE двигает карточку без действий в интерфейсе', async ({ page }) => {
    await openBoard(page, ide.url);
    await openCard(page, 'full-feature');

    const path = join(ide.root, 'openspec/changes/full-feature/tasks.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/- \[ \]/g, '- [x]'));

    await expect(page.getByTestId('column-to-archive')).toContainText('full-feature');
    await expect(page.getByTestId('item-2.1')).toBeChecked();
  });

  test('недопустимое имя change отклоняется с выводом команды', async ({ page }) => {
    await openBoard(page, ide.url);

    await page.getByTestId('new-change').click();
    await page.getByLabel('Имя изменения').fill('Имя С Пробелами');
    await page.getByRole('button', { name: 'Создать' }).click();

    await expect(page.getByTestId('board-error')).toBeVisible();
    await expect(page.getByTestId('column-proposal')).not.toContainText('Имя С Пробелами');
  });

  test('архивация показывает, что станет со спеками, и переносит дельты', async ({ page }) => {
    await openBoard(page, ide.url);

    await page.getByTestId('card-archive-full-feature').click();

    const preview = page.getByTestId('archive-preview');
    await expect(preview).toHaveAttribute('data-outcome', 'ready', { timeout: 20_000 });
    await expect(page.getByTestId('preview-outcome')).toContainText('Архивация пройдёт');
    await expect(page.getByTestId('spec-preview-data-export')).toContainText('новая');
    await expect(page.getByTestId('spec-preview-data-export')).toContainText('Выгрузка данных');

    await page.getByTestId('toggle-diff-data-export').click();
    await expect(page.getByTestId('unified-diff')).toContainText('### Requirement: Выгрузка данных');

    // Предпросмотр ничего не меняет в проекте.
    expect(existsSync(join(ide.root, 'openspec/specs/data-export/spec.md'))).toBe(false);

    await page.getByTestId('archive-confirmed').click();

    await expect(page.getByTestId('card-full-feature')).toHaveCount(0);
    expect(existsSync(join(ide.root, 'openspec/specs/data-export/spec.md'))).toBe(true);
    expect(readdirSync(join(ide.root, 'openspec/changes/archive')).some((name) => name.endsWith('full-feature'))).toBe(
      true,
    );
  });
});

test.describe('доска и предпросмотр на дельтах со всеми операциями', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('delta-ops');
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('фильтр по имени оставляет подходящие карточки', async ({ page }) => {
    await openBoard(page, ide.url);

    await page.getByTestId('board-filter').fill('rework');

    await expect(page.getByTestId('card-rework-export')).toBeVisible();
    await expect(page.getByTestId('card-add-limits')).toHaveCount(0);
  });

  test('архивация, которую CLI отклонит, недоступна и объяснена', async ({ page }) => {
    await openBoard(page, ide.url);
    await openCard(page, 'rework-export');

    await page.getByTestId('archive').click();

    await expect(page.getByTestId('archive-preview')).toHaveAttribute('data-outcome', 'refused', { timeout: 20_000 });
    await expect(page.getByTestId('preview-outcome')).toContainText('Пустой набор данных');
    await expect(page.getByTestId('archive-confirmed')).toBeDisabled();
  });

  test('вкладка «После архивации» в дельтах строит тот же предпросмотр', async ({ page }) => {
    await openBoard(page, ide.url);
    await openCard(page, 'add-limits');
    await page.getByTestId('detail-deltas').click();

    await expect(page.getByTestId('deltas')).toBeVisible();
    await page.getByTestId('tab-after-archive').click();

    await expect(page.getByTestId('archive-preview')).toHaveAttribute('data-outcome', 'refused', { timeout: 20_000 });
  });
});

test.describe('доска на собственной схеме', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('custom-schema', { writable: true });
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('колонки берутся из артефактов собственной схемы', async ({ page }) => {
    await openBoard(page, ide.url);

    await expect(page.getByTestId('column-research')).toBeVisible();
    await expect(page.getByTestId('column-spec-review')).toBeVisible();
    await expect(page.getByTestId('column-plan')).toBeVisible();
    await expect(page.getByTestId('column-tasks')).toHaveCount(0);
  });

  test('новый change создаётся выбранной схемой и попадает в её первую колонку', async ({
    page,
  }) => {
    await openBoard(page, ide.url);

    await page.getByTestId('new-change').click();
    await page.getByLabel('Имя изменения').fill('new-feature');
    await page.getByLabel('Схема процесса').selectOption('team-flow');
    await page.getByRole('button', { name: 'Создать' }).click();

    await expect(page.getByTestId('column-research')).toContainText('new-feature');
    await expect(page.getByTestId('card-new-feature')).toContainText('не проверялся');
  });

  test('отметка пункта пишется в plan.md, а не в tasks.md', async ({ page }) => {
    await openBoard(page, ide.url);
    await openCard(page, 'team-feature');

    await page.getByTestId('item-1.2').check();

    // Отметка ставится сразу, а запись идёт на сервер — ждём подтверждения
    // от него, прежде чем читать файл.
    await expect(page.getByTestId('card-team-feature')).toContainText('2/3 пунктов');

    const plan = readFileSync(join(ide.root, 'openspec/changes/team-feature/plan.md'), 'utf8');
    expect(plan).toContain('[x] 1.2');
    expect(existsSync(join(ide.root, 'openspec/changes/team-feature/tasks.md'))).toBe(false);
  });

  test('архивация невыполненного change требует подтверждения', async ({ page }) => {
    await openBoard(page, ide.url);
    await openCard(page, 'team-feature');

    await page.getByTestId('archive').click();

    await expect(page.getByTestId('archive-confirm')).toContainText('не выполнено пунктов');
  });
});
