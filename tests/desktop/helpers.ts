import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';

export const APP_DIR = fileURLToPath(new URL('../../packages/desktop', import.meta.url));
export const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;

/** Под root Chromium не запускается без --no-sandbox; в контейнерах CI так бывает. */
const SANDBOX_ARGS = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [];

export interface Desktop {
  readonly app: ElectronApplication;
  /** Профиль пользователя этого запуска. */
  readonly userData: string;
  close(): Promise<void>;
}

/**
 * Временный каталог с каноническим путём: на Windows tmpdir() бывает
 * коротким именем 8.3, а приложение показывает и хранит полный путь.
 */
export function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/** Копия фикстуры во временном каталоге — приложение пишет в `.openspec-ide/`. */
export function fixtureCopy(name: string): string {
  const target = tempDir('osi-desktop-');
  cpSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), target, { recursive: true });
  return target;
}

export async function launchDesktop(
  options: {
    path?: string;
    userData?: string;
    env?: Record<string, string>;
    recent?: readonly { path: string; openedAt: string }[];
  } = {},
): Promise<Desktop> {
  const userData = options.userData ?? tempDir('osi-profile-');
  if (options.recent !== undefined) {
    writeFileSync(join(userData, 'recent.json'), JSON.stringify(options.recent));
  }
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR, ...SANDBOX_ARGS, ...(options.path === undefined ? [] : [options.path])],
    env: { ...process.env, OPENSPEC_IDE_USER_DATA: userData, ...options.env } as Record<string, string>,
  });
  return {
    app,
    userData,
    close: async () => {
      // Подтверждения закрытия в тестах не нужны: окна закрываются как есть.
      await app.close().catch(() => undefined);
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** Окна репозиториев: страница IDE отдаётся loopback-сервером. */
export function repoWindows(app: ElectronApplication): Page[] {
  return app.windows().filter((page) => page.url().startsWith('http://127.0.0.1:'));
}

export async function waitForRepoWindow(app: ElectronApplication, title: string): Promise<Page> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    for (const page of repoWindows(app)) {
      const titles = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => [window.webContents.getURL(), window.getTitle()]),
      );
      if (titles.some(([url, name]) => url === page.url() && name === title)) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Не открылось окно «${title}»`);
}

export async function startPage(app: ElectronApplication): Promise<Page> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = app.windows().find((candidate) => candidate.url().startsWith('file:'));
    if (page !== undefined) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Стартовый экран не открылся');
}

/** Системный диалог выбора папки отвечает заданным путём. */
export async function answerFolderDialog(app: ElectronApplication, folder: string | null): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    const state = globalThis as { __dialogCalls?: number };
    state.__dialogCalls = 0;
    dialog.showOpenDialog = (async () => {
      state.__dialogCalls = (state.__dialogCalls ?? 0) + 1;
      return answer === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [answer] };
    }) as typeof dialog.showOpenDialog;
  }, folder);
}

export async function dialogCalls(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as { __dialogCalls?: number }).__dialogCalls ?? 0);
}

/** Запускает второй экземпляр приложения и ждёт его завершения. */
export function secondInstance(desktop: Desktop, path: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [APP_DIR, ...SANDBOX_ARGS, path], {
      env: { ...process.env, OPENSPEC_IDE_USER_DATA: desktop.userData },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Второй экземпляр не завершился сам'));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Нажатие с Ctrl в окне в фокусе. Идёт как настоящий ввод окна — через
 * ускорители меню, а не прямо в страницу, как клавиатура Playwright.
 */
export async function pressShortcut(app: ElectronApplication, key: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, keyCode) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    window?.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control'] });
    window?.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control'] });
  }, key);
}
