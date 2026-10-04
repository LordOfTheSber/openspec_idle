import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

test.describe('карта контекста', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('context-map', { writable: true });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('граф связывает модули с доменами многие-ко-многим, выбор узла показывает связи и контекст', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-context').click();

    await expect(page.getByTestId('context-summary')).toContainText('2 модуля');
    await expect(page.getByTestId('context-summary')).toContainText('5 доменов');
    await expect(page.getByTestId('context-graph')).toBeVisible();
    // Домен replication — у обоих модулей.
    await expect(page.getByTestId('ctx-edge-domain:sds-master->replication')).toBeAttached();
    await expect(page.getByTestId('ctx-edge-domain:sds-impl->replication')).toBeAttached();
    await expect(page.getByTestId('ctx-edge-depends:sds-master->sds-impl')).toBeAttached();

    await page.getByTestId('ctx-node-domain:replication').click();
    await expect(page.getByTestId('context-details')).toContainText('sds-master');
    await expect(page.getByTestId('context-details')).toContainText('sds-impl');
    await expect(page.getByTestId('context-details')).toContainText('ADR-001-sync-replication');

    await page.getByTestId('ctx-node-module:sds-master').click();
    const bundle = page.getByTestId('context-bundle');
    await expect(bundle).toContainText('openspec/context/1.md');
    await expect(bundle).toContainText('openspec/context/modules/sds-impl/context.md');
    await expect(bundle).toContainText('openspec/specs/servant-master-api/spec.md');

    await expect(page.getByTestId('context-issue-unknown-module')).toContainText('sds-router');
    await expect(page.getByTestId('context-issue-uncovered-domain')).toContainText('cm-cluster-api');
  });

  test('набор контекста собирается щелчками по нескольким модулям и доменам', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-context').click();

    await page.getByTestId('context-pick-mode').click();
    await expect(page.getByTestId('context-selection-empty')).toBeVisible();

    // Модуль без его зависимостей и отдельный домен, не относящийся к модулю.
    await page.getByTestId('ctx-node-module:sds-impl').click();
    await page.getByTestId('ctx-node-domain:cm-cluster-api').click();
    const bundle = page.getByTestId('context-bundle');
    await expect(bundle).toContainText('openspec/context/modules/sds-impl/context.md');
    await expect(bundle).toContainText('openspec/specs/servant-master-api/spec.md');
    await expect(bundle).toContainText('openspec/specs/cm-cluster-api/spec.md');
    await expect(bundle).toContainText('ADR-001-sync-replication.md');
    await expect(bundle).not.toContainText('modules/master/context.md');
    await expect(page.getByTestId('ctx-node-module:sds-impl')).toHaveAttribute('data-picked', 'true');
    // Не вошедший в набор узел приглушён.
    await expect(page.getByTestId('ctx-node-domain:session-data')).toHaveClass(/faded/);

    // Без спек доменов модулей остаётся только выбранный домен.
    await page.getByTestId('context-opt-module-domains').uncheck();
    await expect(bundle).not.toContainText('servant-master-api');
    await expect(bundle).toContainText('cm-cluster-api');

    // Повторный щелчок убирает узел; чип в панели — тоже.
    await page.getByTestId('ctx-node-domain:cm-cluster-api').click();
    await expect(bundle).not.toContainText('cm-cluster-api');
    await page.getByTestId('context-picked-module:sds-impl').click();
    await expect(page.getByTestId('context-selection-empty')).toBeVisible();

    // Вне режима набора щелчок открывает карточку, Ctrl+щелчок — добавляет в набор.
    await page.getByTestId('context-pick-mode').click();
    await page.getByTestId('ctx-node-module:sds-master').click();
    await expect(page.getByTestId('context-details')).toContainText('sds-master');
    await page.getByTestId('ctx-node-domain:session-data').click({ modifiers: ['Control'] });
    await expect(page.getByTestId('context-selection')).toContainText('session-data');

    // В матрице выбор — по строкам и столбцам; набор переживает перезагрузку.
    await page.getByTestId('context-view-matrix').click();
    await page.getByTestId('ctx-row-sds-master').click();
    await expect(bundle).toContainText('openspec/context/modules/master/context.md');
    await page.reload();
    await page.getByTestId('nav-context').click();
    await expect(page.getByTestId('context-selection')).toContainText('sds-master');
    await expect(page.getByTestId('context-selection')).toContainText('session-data');
  });

  test('вид «Контроль» показывает объём, лишнее и ненайденные пути', async ({ page }) => {
    const paragraph = 'Мастер хранит данные сессии в памяти и реплицирует их синхронно на резервный узел до ответа клиенту.';
    writeFileSync(join(ide.root, 'openspec/context/1.md'), `# Общий контекст 1\n\n${paragraph}\n`);
    writeFileSync(
      join(ide.root, 'openspec/context/modules/master/context.md'),
      `# Контекст sds-master\n\n<!-- Опишите назначение модуля и пути к коду. -->\n\n${paragraph}\n\nТочка входа — \`Main.java\`, сессии — \`session/Store.java\`.\n`,
    );
    writeFileSync(join(ide.root, 'openspec/context/modules/master/notes.md'), '# черновик\n');
    writeFileSync(
      join(ide.root, 'openspec/context/adr/ADR-000-async.md'),
      '---\nstatus: superseded\nmodules: [sds-master]\n---\n# ADR-000: Асинхронная репликация\n',
    );

    await page.goto(ide.url);
    await page.getByTestId('nav-context').click();
    await expect(page.getByTestId('context-summary')).toContainText('токенов');
    await expect(page.getByTestId('context-summary')).toContainText('полезных');

    await page.getByTestId('context-view-control').click();
    const control = page.getByTestId('context-control');
    await expect(control).toBeVisible();
    // Объём: каждый файл с оценкой, наборы модулей.
    await expect(page.getByTestId('ctx-control-file-openspec/context/modules/master/context.md')).toContainText('≈');
    await expect(page.getByTestId('ctx-control-bundle-sds-master')).toBeVisible();
    // Полезность: у context.md модуля — повтор, заготовка и абзац с ненайденным путём; у наборов — доля полезных.
    await expect(page.getByTestId('ctx-control-useful-total')).toContainText('полезных токенов');
    const useful = page.getByTestId('ctx-control-useful-openspec/context/modules/master/context.md');
    await expect(useful).toContainText('повторы');
    await expect(useful).toContainText('заготовки');
    await expect(useful).toContainText('битые пути');
    await expect(page.getByTestId('ctx-control-useful-openspec/context/1.md')).toHaveCount(0);
    await expect(page.getByTestId('ctx-control-bundle-useful-sds-master')).toContainText('%');
    // Лишнее: повтор, пустой контекст, файл вне наборов, недействующий ADR.
    await expect(page.getByTestId('ctx-control-duplicates')).toContainText('openspec/context/1.md:3');
    await expect(page.getByTestId('ctx-control-empty')).toContainText('modules/sds-impl/context.md');
    await expect(page.getByTestId('ctx-control-unused')).toContainText('modules/master/notes.md');
    await expect(page.getByTestId('ctx-control-inactive')).toContainText('ADR-000-async.md');
    // Связь с реальностью: путь, которого нет; проект не в git — свежесть неизвестна.
    await expect(page.getByTestId('ctx-control-broken')).toContainText('session/Store.java');
    await expect(page.getByTestId('ctx-control-fresh-sds-master')).toContainText('нет данных git');
    await expect(page.getByTestId('context-issue-duplicate-text')).toBeAttached();
    await expect(page.getByTestId('context-issue-broken-reference')).toContainText('session/Store.java');

    // Переход к модулю: карточка с объёмом набора; недействующий ADR — вне набора.
    await page.getByTestId('ctx-control-bundle-sds-master').getByRole('button', { name: 'sds-master' }).click();
    await expect(page.getByTestId('context-graph')).toBeVisible();
    await expect(page.getByTestId('context-module-volume')).toContainText('набор ≈');
    await expect(page.getByTestId('context-module-volume')).toContainText('полезно');
    await expect(page.getByTestId('context-bundle-useful')).toContainText('%');
    await expect(page.getByTestId('context-bundle-tokens')).toContainText('токенов');
    await expect(page.getByTestId('context-bundle-skipped')).toContainText('ADR-000-async.md');
    await expect(page.getByTestId('context-bundle').locator('ol')).not.toContainText('ADR-000-async.md');

    // В наборе флажок возвращает недействующий ADR.
    await page.getByTestId('context-pick').click();
    await page.getByTestId('context-opt-inactive-adrs').check();
    await expect(page.getByTestId('context-selection').locator('ol')).toContainText('ADR-000-async.md');
  });

  test('матрица и обновление при правке index.md', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-context').click();
    await page.getByTestId('context-view-matrix').click();

    await expect(page.getByTestId('ctx-cell-sds-master-replication')).toBeVisible();
    await expect(page.getByTestId('ctx-cell-sds-impl-replication')).toBeVisible();
    await expect(page.getByTestId('ctx-cell-sds-impl-cm-cluster-api')).toHaveCount(0);

    writeFileSync(
      join(ide.root, 'openspec/context/modules/sds-impl/index.md'),
      '---\nmodule: sds-impl\ndomains: [replication, servant-master-api, cm-cluster-api]\n---\n',
    );

    await expect(page.getByTestId('ctx-cell-sds-impl-cm-cluster-api')).toBeVisible();
    await expect(page.getByTestId('context-issue-uncovered-domain')).toHaveCount(0);
  });
});

test.describe('контекст без модулей', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('empty', { writable: true });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('пустое состояние объясняет формат и создаёт модуль', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-context').click();

    await expect(page.getByTestId('context-not-configured')).toContainText('Модули ещё не описаны');
    await page.getByTestId('context-new-module').click();
    await page.getByTestId('context-module-name').fill('web');
    await page.getByTestId('context-module-create').click();

    await expect(page.getByTestId('context-summary')).toContainText('1 модуль');
    await expect(page.getByTestId('toast')).toContainText('Модуль web создан');
    const index = readFileSync(join(ide.root, 'openspec/context/modules/web/index.md'), 'utf8');
    expect(index).toContain('module: web');
  });
});
