import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import {
  locateOpenspecCli,
  resolveOpenspecRoot,
  runCli,
  startServer,
  type RunningServer,
} from '@openspec-ide/server';
import { repositoryArgument } from './args.js';
import { DOCS_URL, menuTemplate, type SectionId } from './menu.js';
import { RecentList, samePath } from './recent.js';
import { WindowStateStore, restoreGeometry } from './windowState.js';

/** Что стало с запросом открыть папку — стартовый экран показывает это пользователю. */
export type OpenResult =
  | { readonly kind: 'opened'; readonly root: string }
  | { readonly kind: 'no-openspec'; readonly path: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string };

interface RepoWindow {
  readonly root: string;
  readonly window: BrowserWindow;
  readonly server: RunningServer;
  /** Пользователь подтвердил закрытие при выполняющемся запуске агента. */
  confirmed: boolean;
  asking: boolean;
}

const PRODUCT = 'OpenSpec IDE';
const HERE = dirname(fileURLToPath(import.meta.url));

// Профиль пользователя: недавние, положение окон. Тесты подменяют каталог,
// чтобы не трогать настоящий профиль и не делить с ним блокировку экземпляра.
app.setName(PRODUCT);
app.setPath(
  'userData',
  process.env['OPENSPEC_IDE_USER_DATA'] ?? join(app.getPath('appData'), PRODUCT),
);

/** Ресурсы поставки: страница IDE и встроенный CLI OpenSpec. */
const resources = app.isPackaged
  ? { web: join(process.resourcesPath, 'web'), openspec: join(process.resourcesPath, 'openspec', 'bin', 'openspec.js') }
  : {
      web: join(HERE, '..', '..', 'web', 'dist'),
      openspec: join(HERE, '..', '..', '..', 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'),
    };

const recent = new RecentList(join(app.getPath('userData'), 'recent.json'));
const geometry = new WindowStateStore(join(app.getPath('userData'), 'windows.json'));
/** Окна по корню репозитория: открывающиеся и открытые. */
const repositories = new Map<string, Promise<RepoWindow>>();
/** Открытые окна — меню нужен синхронный ответ, какое окно в фокусе. */
const ready = new Map<string, RepoWindow>();
const closing = new Set<Promise<void>>();
let startWindow: BrowserWindow | null = null;
let quitting = false;

const initialPath = repositoryArgument(process.argv, {
  defaultApp: process.defaultApp === true,
  cwd: process.cwd(),
});

if (!app.requestSingleInstanceLock({ path: initialPath })) {
  // Второй запуск: путь уже передан работающему экземпляру.
  app.quit();
} else {
  app.on('second-instance', (_event, argv, cwd, data) => {
    const passed = (data as { path?: unknown } | null)?.path;
    const path =
      typeof passed === 'string'
        ? passed
        : repositoryArgument(argv, { defaultApp: process.defaultApp === true, cwd });
    if (path === null) showStart();
    else void openRepository(path);
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  // Серверы окон закрываются асинхронно; выход ждёт их, чтобы наблюдатели и
  // сокеты не обрывались на полуслове.
  app.on('will-quit', (event) => {
    if (closing.size === 0) return;
    event.preventDefault();
    void Promise.allSettled([...closing]).then(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showStart();
  });

  app.on('browser-window-focus', () => refreshMenu());

  registerIpc();

  void app.whenReady().then(async () => {
    refreshMenu();
    if (initialPath === null) showStart();
    else await openRepository(initialPath);
  });
}

/** Открывает репозиторий, содержащий папку, или фокусирует его окно. */
async function openRepository(folder: string): Promise<OpenResult> {
  const resolution = resolveOpenspecRoot(folder);
  if (resolution.kind !== 'found') {
    if (!existsSync(folder)) {
      recent.remove(folder);
      notifyRecent();
      return { kind: 'error', message: `Папка ${folder} не существует или недоступна.` };
    }
    // Предложение завести OpenSpec показывает стартовый экран.
    const start = showStart();
    const offer = (): void => start.webContents.send('desktop:offer-init', resolution.startedFrom);
    if (start.webContents.isLoading()) start.webContents.once('did-finish-load', offer);
    else offer();
    return { kind: 'no-openspec', path: resolution.startedFrom };
  }

  const { root } = resolution;
  const existing = findRepository(root);
  if (existing !== undefined) {
    try {
      const repo = await existing;
      if (repo.window.isMinimized()) repo.window.restore();
      repo.window.focus();
      recent.add(root);
      notifyRecent();
      startWindow?.close();
      return { kind: 'opened', root };
    } catch {
      // Предыдущая попытка открыть не удалась — пробуем заново.
    }
  }

  const opening = createRepoWindow(root);
  repositories.set(root, opening);
  try {
    await opening;
  } catch (error) {
    repositories.delete(root);
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Не удалось открыть ${root}: ${message}` };
  }
  recent.add(root);
  notifyRecent();
  // Репозиторий открыт — стартовый экран больше не нужен.
  startWindow?.close();
  return { kind: 'opened', root };
}

function findRepository(root: string): Promise<RepoWindow> | undefined {
  for (const [key, repo] of repositories) {
    if (samePath(key, root)) return repo;
  }
  return undefined;
}

async function createRepoWindow(root: string): Promise<RepoWindow> {
  const server = await startServer({
    root,
    port: null,
    dev: false,
    webDist: resources.web,
    openspecFallback: resources.openspec,
  });

  const display = screen.getPrimaryDisplay();
  const bounds = restoreGeometry(
    geometry.get(root),
    screen.getAllDisplays().map((entry) => entry.workArea),
    display.workArea,
  );
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: windowTitle(root),
    backgroundColor: background(),
    webPreferences: secureWebPreferences(),
  });
  if (bounds.maximized) window.maximize();

  const repo: RepoWindow = { root, window, server, confirmed: false, asking: false };
  guardNavigation(window.webContents, new URL(server.url).origin);
  // Заголовок — имя репозитория, а не заголовок страницы.
  window.on('page-title-updated', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => onRepoClose(repo, event));
  window.on('closed', () => {
    repositories.delete(root);
    ready.delete(root);
    const done = server.close().catch((error: unknown) => {
      console.error(`Сервер окна ${root} не остановился: ${String(error)}`);
    });
    closing.add(done);
    void done.finally(() => closing.delete(done));
    refreshMenu();
  });

  ready.set(root, repo);
  try {
    await window.loadURL(server.url);
  } catch (error) {
    // Окно без страницы бесполезно; сервер остановит обработчик closed.
    window.destroy();
    throw error;
  }
  return repo;
}

/** Фон окна до загрузки страницы — в цвет её темы, без белой вспышки. */
function background(): string {
  return nativeTheme.shouldUseDarkColors ? '#141114' : '#f7f4f6';
}

function windowTitle(root: string): string {
  return `${basename(root) || root} — ${PRODUCT}`;
}

/** Закрытие окна: подтверждение, если в нём выполняется запуск агента. */
function onRepoClose(repo: RepoWindow, event: Electron.Event): void {
  const runs = repo.server.activeAgentRuns();
  if (!repo.confirmed && runs.length > 0) {
    event.preventDefault();
    if (repo.asking) return;
    repo.asking = true;
    const names = runs.map((run) => `«${run.label}» (change ${run.change})`).join('\n');
    void dialog
      .showMessageBox(repo.window, {
        type: 'warning',
        title: PRODUCT,
        message: 'В окне выполняется запуск агента',
        detail:
          `${names}\n\nПри закрытии запуск будет остановлен и помечен прерванным; ` +
          'показатели, собранные до остановки, сохранятся.',
        buttons: ['Остановить и закрыть', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      .then(async ({ response }) => {
        repo.asking = false;
        if (response !== 0) {
          quitting = false;
          return;
        }
        await repo.server.stopAgentRuns();
        repo.confirmed = true;
        repo.window.close();
        if (quitting) app.quit();
      });
    return;
  }
  const maximized = repo.window.isMaximized();
  geometry.set(repo.root, { ...repo.window.getNormalBounds(), maximized });
}

function showStart(): BrowserWindow {
  if (startWindow !== null && !startWindow.isDestroyed()) {
    if (startWindow.isMinimized()) startWindow.restore();
    startWindow.focus();
    return startWindow;
  }
  const window = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 640,
    minHeight: 460,
    show: false,
    title: PRODUCT,
    backgroundColor: background(),
    webPreferences: secureWebPreferences(),
  });
  startWindow = window;
  guardNavigation(window.webContents, null);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (startWindow === window) startWindow = null;
    refreshMenu();
  });
  void window.loadFile(join(HERE, 'start', 'index.html'));
  return window;
}

function secureWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(HERE, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    spellcheck: false,
  };
}

/**
 * Окно остаётся на своём сервере: переходы на другие адреса и новые окна
 * отдаются системному браузеру, и только по http(s) и mailto.
 */
function guardNavigation(contents: WebContents, origin: string | null): void {
  const inside = (url: string): boolean => {
    try {
      return origin !== null && new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  const leave = (event: Electron.Event, url: string): void => {
    if (inside(url)) return;
    event.preventDefault();
    openExternal(url);
  };
  contents.on('will-navigate', leave);
  contents.on('will-redirect', leave);
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

function openExternal(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }
  if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') return;
  void shell.openExternal(url).catch((error: unknown) => {
    console.error(`Не удалось открыть ${url}: ${String(error)}`);
  });
}

async function chooseFolder(parent: BrowserWindow | null): Promise<OpenResult> {
  const options: Electron.OpenDialogOptions = {
    title: 'Открыть репозиторий',
    buttonLabel: 'Открыть',
    properties: ['openDirectory'],
  };
  const choice = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  const [folder] = choice.filePaths;
  if (choice.canceled || folder === undefined) return { kind: 'cancelled' };
  return openRepository(folder);
}

/** `openspec init` в папке: CLI из репозитория или PATH, иначе встроенный. */
async function initFolder(folder: string): Promise<OpenResult> {
  const located = locateOpenspecCli(folder);
  const bin = located.kind === 'found' ? located.bin : resources.openspec;
  const result = await runCli({ bin, cwd: folder, timeoutMs: 120_000 }, ['init', '--tools', 'none', folder]);
  if (result.code !== 0 || !existsSync(join(folder, 'openspec'))) {
    const output = `${result.stderr}\n${result.stdout}`.trim();
    return { kind: 'error', message: `openspec init завершился с ошибкой${output === '' ? '' : `:\n${output}`}` };
  }
  return openRepository(folder);
}

function registerIpc(): void {
  // Действия стартового экрана принимаются только от него: страница IDE
  // тоже видит мост, но открывать папки через него ей незачем.
  const fromStart = (event: IpcMainInvokeEvent): boolean =>
    startWindow !== null && !startWindow.isDestroyed() && event.sender === startWindow.webContents;
  const refuse: OpenResult = { kind: 'error', message: 'Действие доступно только со стартового экрана.' };

  ipcMain.handle('desktop:info', () => ({ version: app.getVersion(), cliVersion: bundledCliVersion() }));
  ipcMain.handle('desktop:recent', (event) => (fromStart(event) ? recent.list() : []));
  ipcMain.handle('desktop:open-dialog', (event) => (fromStart(event) ? chooseFolder(startWindow) : refuse));
  ipcMain.handle('desktop:open-path', (event, path: unknown) =>
    fromStart(event) && typeof path === 'string' ? openRepository(path) : refuse,
  );
  ipcMain.handle('desktop:remove-recent', (event, path: unknown) => {
    if (!fromStart(event) || typeof path !== 'string') return;
    recent.remove(path);
    notifyRecent();
  });
  ipcMain.handle('desktop:init', (event, path: unknown) =>
    fromStart(event) && typeof path === 'string' ? initFolder(path) : refuse,
  );
}

/** Версия встроенного CLI — из package.json рядом с его bin. */
function bundledCliVersion(): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(resources.openspec), '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function notifyRecent(): void {
  if (startWindow !== null && !startWindow.isDestroyed()) {
    startWindow.webContents.send('desktop:recent-changed');
  }
  refreshMenu();
}

function focusedRepository(): RepoWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused === null) return null;
  for (const repo of ready.values()) {
    if (repo.window === focused) return repo;
  }
  return null;
}

function refreshMenu(): void {
  if (!app.isReady()) return;
  const template = menuTemplate({
    recent: recent.list(),
    repositoryFocused: focusedRepository() !== null,
    platform: process.platform,
    actions: {
      openDialog: () => void chooseFolder(BrowserWindow.getFocusedWindow()).then(reportFailure),
      openRecent: (path) => void openRepository(path).then(reportFailure),
      showStart: () => void showStart(),
      closeWindow: () => BrowserWindow.getFocusedWindow()?.close(),
      showSection: (section: SectionId) => {
        focusedRepository()?.window.webContents.send('desktop:section', section);
      },
      openDocs: () => openExternal(DOCS_URL),
      about: () => {
        void dialog.showMessageBox({
          type: 'info',
          title: PRODUCT,
          message: `${PRODUCT} ${app.getVersion()}`,
          detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode.js ${process.versions.node}`,
        });
      },
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Ошибка открытия из меню — окна со стартовым экраном может и не быть. */
function reportFailure(result: OpenResult): void {
  if (result.kind === 'error') dialog.showErrorBox(PRODUCT, result.message);
}
