/**
 * Стартовый экран: недавние репозитории, открытие папки и предложение
 * завести OpenSpec. Работает через мост `openspecDesktop` из preload.
 */

interface RecentEntry {
  readonly path: string;
  readonly name: string;
  readonly openedAt: string;
  readonly available: boolean;
}

type OpenResult =
  | { readonly kind: 'opened'; readonly root: string }
  | { readonly kind: 'no-openspec'; readonly path: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string };

interface StartBridge {
  readonly platform: string;
  info(): Promise<{ readonly version: string; readonly cliVersion: string | null }>;
  recent(): Promise<RecentEntry[]>;
  openDialog(): Promise<OpenResult>;
  openPath(path: string): Promise<OpenResult>;
  removeRecent(path: string): Promise<void>;
  initFolder(path: string): Promise<OpenResult>;
  onOfferInit(callback: (path: string) => void): () => void;
  onRecentChanged(callback: () => void): () => void;
}

const bridge = (window as unknown as { openspecDesktop: StartBridge }).openspecDesktop;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Нет элемента #${id}`);
  return found as T;
}

const list = element<HTMLUListElement>('recent');
const empty = element('recent-empty');
const offer = element('offer');
const offerTitle = element('offer-title');
const errorBox = element('error');
const openButton = element<HTMLButtonElement>('open');
let offeredPath: string | null = null;

if (bridge.platform === 'darwin') element('open-key').textContent = '⌘O';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `сегодня, ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function renderRecent(): Promise<void> {
  const entries = await bridge.recent();
  list.replaceChildren(...entries.map(recentItem));
  empty.hidden = entries.length > 0;
}

function recentItem(entry: RecentEntry): HTMLLIElement {
  const item = document.createElement('li');
  item.dataset['path'] = entry.path;
  if (!entry.available) item.classList.add('gone');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'open';
  open.disabled = !entry.available;
  open.title = entry.available ? `Открыть ${entry.path}` : 'Папка недоступна';
  const icon = document.createElement('span');
  icon.className = 'ricon';
  icon.textContent = entry.name.slice(0, 2).toLowerCase();
  const text = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = entry.name;
  const path = document.createElement('div');
  path.className = 'path';
  path.textContent = entry.path;
  text.append(name, path);
  open.append(icon, text);
  open.addEventListener('click', () => void run(() => bridge.openPath(entry.path)));

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (entry.available) {
    meta.textContent = formatDate(entry.openedAt);
  } else {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = 'папка недоступна';
    meta.append(pill);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = 'убрать из списка';
  remove.addEventListener('click', () => void bridge.removeRecent(entry.path).then(renderRecent));
  meta.append(remove);

  item.append(open, meta);
  return item;
}

function showOffer(path: string): void {
  offeredPath = path;
  offerTitle.textContent = `В папке ${path} нет openspec/`;
  offer.hidden = false;
  errorBox.hidden = true;
}

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

/** Выполняет действие открытия и показывает его итог. */
async function run(action: () => Promise<OpenResult>): Promise<void> {
  errorBox.hidden = true;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const wasDisabled = buttons.map((button) => button.disabled);
  buttons.forEach((button) => (button.disabled = true));
  try {
    const result = await action();
    if (result.kind === 'no-openspec') showOffer(result.path);
    else if (result.kind === 'error') showError(result.message);
    else if (result.kind === 'opened') offer.hidden = true;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    buttons.forEach((button, index) => (button.disabled = wasDisabled[index] ?? false));
  }
  await renderRecent();
}

openButton.addEventListener('click', () => void run(() => bridge.openDialog()));
element('offer-other').addEventListener('click', () => {
  offer.hidden = true;
  void run(() => bridge.openDialog());
});
element('offer-init').addEventListener('click', () => {
  if (offeredPath === null) return;
  const path = offeredPath;
  void run(() => bridge.initFolder(path));
});
bridge.onOfferInit(showOffer);
bridge.onRecentChanged(() => void renderRecent());
void bridge.info().then(({ version, cliVersion }) => {
  element('version').textContent =
    cliVersion === null ? version : `${version} · встроенный CLI openspec ${cliVersion}`;
});
void renderRecent();
