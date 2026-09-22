import { expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

let ide: LaunchedIde;

test.beforeAll(async () => {
  ide = await launchIde('custom-schema');
});

test.afterAll(async () => {
  await ide?.stop();
});

test('открывается и показывает разделы дерева', async ({ page }) => {
  await page.goto(ide.url);

  await expect(page.getByRole('heading', { name: 'Обозреватель' })).toBeVisible();
  await expect(page.getByText('Изменения ·')).toBeVisible();
  await expect(page.getByText('Спеки ·')).toBeVisible();
  await expect(page.getByText('Процессы ·')).toBeVisible();
  await expect(page.getByText('Архив ·')).toBeVisible();
});

test('раскрывает артефакты change по его собственной схеме', async ({ page }) => {
  await page.goto(ide.url);

  await expect(page.getByTestId('change-team-feature')).toBeVisible();
  // Артефакты собственной схемы, которых нет во встроенной.
  await expect(page.getByTestId('artifact-team-feature-research')).toBeVisible();
  await expect(page.getByTestId('artifact-team-feature-spec-review')).toBeVisible();
  await expect(page.getByTestId('artifact-team-feature-plan')).toBeVisible();
  // Артефакта встроенной схемы здесь быть не должно.
  await expect(page.getByTestId('artifact-team-feature-tasks')).toHaveCount(0);
});

test('прогресс показан у артефакта, объявленного отслеживаемым', async ({ page }) => {
  await page.goto(ide.url);

  await expect(page.getByTestId('artifact-team-feature-plan')).toContainText('1/3');
  await expect(page.getByTestId('artifact-team-feature-research')).not.toContainText('1/3');
});

test('выбор артефакта показывает его состояние', async ({ page }) => {
  await page.goto(ide.url);

  await page.getByTestId('artifact-team-feature-spec-review').click();
  await expect(page.getByTestId('artifact-state')).toHaveText('заполнен');
});

test('раздел процессов показывает схему проекта и её источник', async ({ page }) => {
  await page.goto(ide.url);

  await expect(page.getByTestId('schema-team-flow')).toContainText('умолч.');
  await expect(page.getByTestId('schema-spec-driven')).toContainText('package');
});

test('поиск находит требование и ведёт к файлу и строке', async ({ page }) => {
  await page.goto(ide.url);

  await page.getByRole('button', { name: 'Поиск' }).click();
  await page.getByLabel('Поиск по рабочему пространству').fill('ревью');
  await page.getByLabel('Поиск по рабочему пространству').press('Enter');

  const hits = page.getByTestId('search-hits');
  await expect(hits).toBeVisible();
  await expect(hits).toContainText('Ревью спека до дизайна');
  await expect(hits).toContainText('specs/review-flow/spec.md:');
});

test('фильтр по типу ограничивает выдачу только сценариями', async ({ page }) => {
  await page.goto(ide.url);

  await page.getByRole('button', { name: 'Поиск' }).click();
  await page.getByLabel('Поиск по рабочему пространству').fill('ревью');
  await page.getByLabel('Тип элемента').selectOption('scenario');

  const hits = page.getByTestId('search-hits');
  await expect(hits).toContainText('Ревью не зафиксировано');
  await expect(hits).not.toContainText('Ревью спека до дизайна');
});

test('поиск без совпадений показывает пустое состояние с текстом запроса', async ({ page }) => {
  await page.goto(ide.url);

  await page.getByRole('button', { name: 'Поиск' }).click();
  await page.getByLabel('Поиск по рабочему пространству').fill('такого-точно-нет');
  await page.getByLabel('Поиск по рабочему пространству').press('Enter');

  await expect(page.getByTestId('search-empty')).toContainText('такого-точно-нет');
});

for (const width of [400, 1280]) {
  test(`на ширине ${width} страница не прокручивается по горизонтали`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(ide.url);
    await expect(page.getByRole('heading', { name: 'Обозреватель' })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
