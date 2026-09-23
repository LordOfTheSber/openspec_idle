import { expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

let ide: LaunchedIde;

test.beforeAll(async () => {
  ide = await launchIde('delta-ops');
});

test.afterAll(async () => {
  await ide?.stop();
});

test('дельты сгруппированы по операциям с подписями и счётчиками', async ({ page }) => {
  await page.goto(ide.url);
  await page.getByTestId('change-rework-export').click();
  await page.getByRole('button', { name: 'Дельты' }).click();

  await expect(page.getByTestId('group-MODIFIED')).toContainText('Изменено');
  await expect(page.getByTestId('group-REMOVED')).toContainText('Удалено');
  await expect(page.getByTestId('group-RENAMED')).toContainText('Переименовано');
  await expect(page.getByTestId('group-MODIFIED')).toContainText('1 треб.');
});

test('удалённое требование показывает причину и миграцию', async ({ page }) => {
  await page.goto(ide.url);
  await page.getByTestId('change-rework-export').click();
  await page.getByRole('button', { name: 'Дельты' }).click();

  const removed = page.getByTestId('group-REMOVED');
  await expect(removed).toContainText('Причина: Заменена новой выгрузкой');
  await expect(removed).toContainText('Миграция: Используйте /api/v2/export');
  await expect(removed.getByTestId('incomplete')).toHaveCount(0);
});

test('переименование показывает прежнее и новое имя', async ({ page }) => {
  await page.goto(ide.url);
  await page.getByTestId('change-rework-export').click();
  await page.getByRole('button', { name: 'Дельты' }).click();

  await expect(page.getByTestId('group-RENAMED')).toContainText(
    'Кодировка файла → Кодировка выгрузки',
  );
});

test('сравнение с основным спеком показывает потерянный сценарий', async ({ page }) => {
  await page.goto(ide.url);
  await page.getByTestId('change-rework-export').click();
  await page.getByRole('button', { name: 'Дельты' }).click();

  await page.getByTestId('requirement-Выгрузка данных').click();

  const comparison = page.getByTestId('comparison');
  await expect(comparison).toBeVisible();
  await expect(page.getByTestId('lost-scenarios')).toContainText('Пустой набор данных');
  await expect(page.getByTestId('lost-warning')).toContainText('потеряны при архивации');
});

test('сравнение показывает изменение текста требования', async ({ page }) => {
  await page.goto(ide.url);
  await page.getByTestId('change-rework-export').click();
  await page.getByRole('button', { name: 'Дельты' }).click();
  await page.getByTestId('requirement-Выгрузка данных').click();

  await expect(page.locator('.diff .row.minus')).toContainText('формате CSV');
  await expect(page.locator('.diff .row.plus')).toContainText('CSV и JSON');
});

test('карта связей помечает требование, которое меняют два change', async ({ page }) => {
  await page.goto(ide.url);
  await page.getByRole('button', { name: 'Дельты' }).click();

  const node = page.getByTestId('map-data-export');
  await expect(node).toBeVisible();
  await expect(node).toContainText('rework-export');
  await expect(node).toContainText('add-limits');
  await expect(node.getByTestId('conflict').first()).toContainText('Выгрузка данных');
});

test('change без дельт сообщает об этом прямо', async ({ page }) => {
  const bare = await launchIde('bare-change');
  try {
    await page.goto(bare.url);
    await page.getByTestId('change-bare-feature').click();
    await page.getByRole('button', { name: 'Дельты' }).click();

    await expect(page.getByTestId('no-deltas')).toContainText('не содержит дельт');
  } finally {
    await bare.stop();
  }
});

test('основной спек показан структурно со сворачиванием требований', async ({ page }) => {
  await page.goto(ide.url);
  await page.getByRole('button', { name: 'Дельты' }).click();
  await page.getByTestId('capability-data-export').click();

  const view = page.getByTestId('spec-view');
  await expect(view).toBeVisible();
  await expect(view).toContainText('переносимом формате');
  await expect(view).toContainText('Пустой набор данных');

  // Сворачивание скрывает сценарии, разворачивание возвращает.
  await page.getByTestId('spec-requirement-Выгрузка данных').click();
  await expect(view).not.toContainText('Пустой набор данных');
  await page.getByTestId('spec-requirement-Выгрузка данных').click();
  await expect(view).toContainText('Пустой набор данных');
});

test('незаполненное назначение спека помечается как требующее заполнения', async ({ page }) => {
  await page.goto(ide.url);
  await page.getByRole('button', { name: 'Дельты' }).click();
  await page.getByTestId('capability-tbd-capability').click();

  await expect(page.getByTestId('purpose-placeholder')).toContainText('заглушкой');
});
