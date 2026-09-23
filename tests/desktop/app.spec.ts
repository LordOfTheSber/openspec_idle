import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  answerFolderDialog,
  dialogCalls,
  fixtureCopy,
  launchDesktop,
  pressShortcut,
  repoWindows,
  secondInstance,
  tempDir,
  startPage,
  waitForRepoWindow,
  type Desktop,
} from './helpers.js';

const FAKE_AGENT = fileURLToPath(new URL('../agent/stub/fake-agent.mjs', import.meta.url));

let desktop: Desktop | null = null;

test.afterEach(async () => {
  await desktop?.close();
  desktop = null;
});

test('открывает репозиторий из командной строки в своём окне с деревом changes', async () => {
  const root = fixtureCopy('full-change');
  desktop = await launchDesktop({ path: root });
  const page = await waitForRepoWindow(desktop.app, `${basename(root)} — OpenSpec IDE`);
  await expect(page.getByTestId('change-full-feature')).toBeVisible();
  // CLI из репозитория IDE найден подъёмом по дереву не будет: копия во временном каталоге.
  await expect(page.getByTestId('cli-source')).toContainText(/встроенный|из PATH/);
});

test('стартовый экран: вложенная папка открывает корень, повторное открытие — то же окно', async () => {
  const root = fixtureCopy('full-change');
  desktop = await launchDesktop();
  const start = await startPage(desktop.app);
  await expect(start.getByText('Недавние репозитории')).toBeVisible();
  await expect(start.locator('#version')).toContainText('встроенный CLI openspec');

  await answerFolderDialog(desktop.app, join(root, 'openspec', 'changes', 'full-feature'));
  await start.getByRole('button', { name: /Открыть репозиторий/ }).click();
  const page = await waitForRepoWindow(desktop.app, `${basename(root)} — OpenSpec IDE`);
  await expect(page.getByTestId('change-full-feature')).toBeVisible();

  // Недавние запомнили корень, а не выбранную вложенную папку.
  const recent = JSON.parse(readFileSync(join(desktop.userData, 'recent.json'), 'utf8')) as { path: string }[];
  expect(recent.map((entry) => entry.path)).toEqual([root]);

  // Стартовый экран снова, выбор того же репозитория из недавних — окно не множится.
  await desktop.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('start')?.click());
  const again = await startPage(desktop.app);
  await again.locator('li').filter({ hasText: root }).locator('button.open').click();
  await expect.poll(() => desktop!.app.windows().some((window) => window.url().startsWith('file:'))).toBe(false);
  expect(repoWindows(desktop.app)).toHaveLength(1);
});

test('второй запуск с путём открывает репозиторий в работающем экземпляре', async () => {
  const first = fixtureCopy('full-change');
  const second = fixtureCopy('bare-change');
  desktop = await launchDesktop({ path: first });
  await waitForRepoWindow(desktop.app, `${basename(first)} — OpenSpec IDE`);

  expect(await secondInstance(desktop, second)).toBe(0);
  await waitForRepoWindow(desktop.app, `${basename(second)} — OpenSpec IDE`);
  expect(repoWindows(desktop.app)).toHaveLength(2);

  // Тот же репозиторий ещё раз — окно не добавляется.
  expect(await secondInstance(desktop, first)).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(repoWindows(desktop.app)).toHaveLength(2);
});

test('недавний репозиторий, которого больше нет, помечен и убирается из списка', async () => {
  const gone = join(tmpdir(), 'osi-desktop-gone-repository');
  desktop = await launchDesktop({ recent: [{ path: gone, openedAt: '2026-09-01T10:00:00.000Z' }] });
  const start = await startPage(desktop.app);
  const item = start.locator('li').filter({ hasText: gone });
  await expect(item).toContainText('папка недоступна');
  await expect(item.getByRole('button', { name: /osi-desktop-gone/ })).toBeDisabled();
  await item.getByRole('button', { name: 'убрать из списка' }).click();
  await expect(item).toHaveCount(0);
  await expect(start.getByText('Здесь появятся открытые репозитории.')).toBeVisible();
});

test('папка без OpenSpec: после согласия выполняется openspec init и открывается окно', async () => {
  const empty = tempDir('osi-desktop-empty-');
  desktop = await launchDesktop();
  const start = await startPage(desktop.app);
  await answerFolderDialog(desktop.app, empty);
  await start.getByRole('button', { name: /Открыть репозиторий/ }).click();

  await expect(start.locator('#offer')).toBeVisible();
  await expect(start.locator('#offer')).toContainText(empty);
  await start.getByRole('button', { name: 'Выполнить openspec init' }).click();

  const page = await waitForRepoWindow(desktop.app, `${basename(empty)} — OpenSpec IDE`);
  expect(existsSync(join(empty, 'openspec', 'config.yaml'))).toBe(true);
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
});

test('внешняя ссылка открывается в системном браузере, окно остаётся на IDE', async () => {
  const root = fixtureCopy('full-change');
  desktop = await launchDesktop({ path: root });
  const page = await waitForRepoWindow(desktop.app, `${basename(root)} — OpenSpec IDE`);
  await desktop.app.evaluate(({ shell }) => {
    const state = globalThis as { __opened?: string[] };
    state.__opened = [];
    shell.openExternal = (async (url: string) => void state.__opened!.push(url)) as typeof shell.openExternal;
  });
  const before = page.url();

  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'https://example.com/docs';
    link.textContent = 'внешняя';
    link.id = 'external-link';
    document.body.append(link);
  });
  // Клик из страницы: Playwright иначе ждал бы отменённую навигацию.
  await page.evaluate(() => document.getElementById('external-link')?.click());
  await page.evaluate(() => void window.open('https://example.com/popup'));

  await expect
    .poll(() => desktop!.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened))
    .toEqual(['https://example.com/docs', 'https://example.com/popup']);
  expect(page.url()).toBe(before);
  expect(desktop.app.windows()).toHaveLength(1);
});

test('меню «Вид» и сочетания переключают разделы, Ctrl+O вызывает диалог', async () => {
  const root = fixtureCopy('full-change');
  desktop = await launchDesktop({ path: root });
  const page = await waitForRepoWindow(desktop.app, `${basename(root)} — OpenSpec IDE`);
  await expect(page.getByTestId('change-full-feature')).toBeVisible();
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());

  await desktop.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('section-board')?.click());
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Доска');

  await pressShortcut(desktop.app, '4');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Метрики');
  await pressShortcut(desktop.app, '1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Обозреватель');

  await answerFolderDialog(desktop.app, null);
  await pressShortcut(desktop.app, 'O');
  await expect.poll(() => dialogCalls(desktop!.app)).toBe(1);
});

test('закрытие окна с выполняющимся запуском агента: отказ оставляет окно, согласие прерывает запуск', async () => {
  chmodSync(FAKE_AGENT, 0o755);
  const root = fixtureCopy('full-change');
  mkdirSync(join(root, '.openspec-ide'), { recursive: true });
  writeFileSync(
    join(root, '.openspec-ide', 'config.json'),
    JSON.stringify({ version: 1, agent: { command: FAKE_AGENT, maxWallTime: '60', maxToolCalls: 7 } }),
  );
  writeFileSync(join(root, '.openspec-ide', 'fake-scenario'), 'hang');
  desktop = await launchDesktop({
    path: root,
    env: { GIGACODE_API_KEY: 'sk-desktop-e2e', FAKE_AGENT_SCENARIO_FILE: '.openspec-ide/fake-scenario' },
  });
  const page = await waitForRepoWindow(desktop.app, `${basename(root)} — OpenSpec IDE`);
  await page.getByTestId('change-full-feature').click();
  await page.getByRole('button', { name: 'Агент' }).click();
  await page.getByTestId('target-artifact-design').click();
  await page.getByTestId('run-start').click();
  await expect(page.getByTestId('run-log')).toContainText('read_file');

  const answer = (response: number) =>
    desktop!.app.evaluate(({ dialog }, value) => {
      const state = globalThis as { __asked?: string[] };
      state.__asked = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { detail?: string };
        state.__asked!.push(options.detail ?? '');
        return { response: value, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    }, response);
  const asked = () => desktop!.app.evaluate(() => (globalThis as { __asked?: string[] }).__asked ?? []);
  const closeWindow = () =>
    desktop!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());

  await answer(1);
  await closeWindow();
  await expect.poll(asked).toHaveLength(1);
  expect((await asked())[0]).toContain('change full-feature');
  expect(repoWindows(desktop.app)).toHaveLength(1);
  await expect(page.getByTestId('run-live')).toBeVisible();

  await answer(0);
  const closed = desktop.app.waitForEvent('close');
  await closeWindow();
  await closed;

  const records = readFileSync(join(root, '.openspec-ide', 'agent', 'history.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { outcome: string | null; state: string });
  expect(records).toEqual([expect.objectContaining({ state: 'finished', outcome: 'aborted' })]);
});
