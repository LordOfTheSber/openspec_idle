import { expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

let ide: LaunchedIde;

test.beforeAll(async () => {
  ide = await launchIde('full-change');
});

test.afterAll(async () => {
  await ide?.stop();
});

test('при живом сервере показывает наблюдение за файлами', async ({ page }) => {
  await page.goto(ide.url);

  const indicator = page.getByTestId('connection-state');
  await expect(indicator).toHaveAttribute('data-state', 'connected');
  await expect(indicator).toContainText('наблюдение за файлами');
});

test('обрыв потока показывает признак отключения, а восстановление перечитывает состояние', async ({
  page,
}) => {
  let блокироватьПоток = false;
  let запросовПотока = 0;
  let запросовСостояния = 0;

  // Поток рвётся и не восстанавливается, пока тест не снимет блокировку —
  // так проверяется и признак отключения, и повторное подключение.
  await page.route('**/api/events*', async (route) => {
    запросовПотока += 1;
    if (блокироватьПоток) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.route('**/api/workspace', async (route) => {
    запросовСостояния += 1;
    await route.continue();
  });

  await page.goto(ide.url);

  const indicator = page.getByTestId('connection-state');
  await expect(indicator).toHaveAttribute('data-state', 'connected');

  const состояниеДоОбрыва = запросовСостояния;
  const потоковДоОбрыва = запросовПотока;

  // Обрываем поток так же, как это сделал бы упавший сервер: открытое
  // соединение прекращается, а все последующие попытки отклоняются.
  блокироватьПоток = true;
  await page.evaluate(() => window.stop());

  await expect(indicator).toHaveAttribute('data-state', 'disconnected', { timeout: 20_000 });
  await expect(indicator).toContainText('нет связи с сервером');

  // Повторные попытки идут — значит, переподключение запущено.
  await expect
    .poll(() => запросовПотока, { timeout: 20_000 })
    .toBeGreaterThan(потоковДоОбрыва);

  блокироватьПоток = false;
  await page.unroute('**/api/events*');

  await expect(indicator).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });

  // После восстановления состояние перечитывается целиком.
  await expect
    .poll(() => запросовСостояния, { timeout: 20_000 })
    .toBeGreaterThan(состояниеДоОбрыва);
});
