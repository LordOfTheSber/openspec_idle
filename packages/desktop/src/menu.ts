import type { MenuItemConstructorOptions } from 'electron';

/** Разделы интерфейса в порядке панели слева — и сочетания Ctrl+1…9. */
export const SECTIONS = [
  { id: 'explorer', label: 'Обозреватель' },
  { id: 'deltas', label: 'Дельты' },
  { id: 'board', label: 'Доска' },
  { id: 'metrics', label: 'Метрики' },
  { id: 'modules', label: 'Модули' },
  { id: 'agent', label: 'Агент' },
  { id: 'processes', label: 'Процессы' },
  { id: 'search', label: 'Поиск' },
  { id: 'settings', label: 'Настройки' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

export interface MenuRecent {
  readonly path: string;
  readonly name: string;
  readonly available: boolean;
}

/** Действия, которые вызывают пункты меню. */
export interface MenuActions {
  openDialog(): void;
  openRecent(path: string): void;
  showStart(): void;
  closeWindow(): void;
  showSection(section: SectionId): void;
  openDocs(): void;
  about(): void;
}

export const DOCS_URL = 'https://github.com/Fission-AI/OpenSpec';

/**
 * Шаблон системного меню. Пункты разделов действуют на окно репозитория в
 * фокусе и выключены, когда в фокусе стартовый экран.
 */
export function menuTemplate(options: {
  readonly recent: readonly MenuRecent[];
  readonly repositoryFocused: boolean;
  readonly platform: NodeJS.Platform;
  readonly actions: MenuActions;
}): MenuItemConstructorOptions[] {
  const { actions, recent, repositoryFocused } = options;
  const mac = options.platform === 'darwin';

  const recentItems: MenuItemConstructorOptions[] =
    recent.length === 0
      ? [{ label: 'Список пуст', enabled: false }]
      : recent.map((entry) => ({
          label: entry.available ? `${entry.name}  —  ${entry.path}` : `${entry.name}  (недоступен)`,
          enabled: entry.available,
          click: () => actions.openRecent(entry.path),
        }));

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Файл',
      submenu: [
        {
          id: 'open-repository',
          label: 'Открыть репозиторий…',
          accelerator: 'CmdOrCtrl+O',
          click: () => actions.openDialog(),
        },
        { id: 'recent', label: 'Недавние', submenu: recentItems },
        { id: 'start', label: 'Стартовый экран', click: () => actions.showStart() },
        { type: 'separator' },
        {
          id: 'close-window',
          label: 'Закрыть окно',
          accelerator: 'CmdOrCtrl+W',
          click: () => actions.closeWindow(),
        },
        ...(mac ? [] : [{ type: 'separator' as const }, { label: 'Выход', role: 'quit' as const }]),
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', role: 'undo' },
        { label: 'Повторить', role: 'redo' },
        { type: 'separator' },
        { label: 'Вырезать', role: 'cut' },
        { label: 'Копировать', role: 'copy' },
        { label: 'Вставить', role: 'paste' },
        { label: 'Выделить всё', role: 'selectAll' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        ...SECTIONS.map(
          (section, index): MenuItemConstructorOptions => ({
            id: `section-${section.id}`,
            label: section.label,
            accelerator: `CmdOrCtrl+${index + 1}`,
            enabled: repositoryFocused,
            click: () => actions.showSection(section.id),
          }),
        ),
        { type: 'separator' },
        { label: 'Обновить окно', role: 'reload' },
        { label: 'Инструменты разработчика', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Крупнее', role: 'zoomIn' },
        { label: 'Мельче', role: 'zoomOut' },
        { label: 'Исходный масштаб', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Во весь экран', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        { id: 'docs', label: 'Документация OpenSpec', click: () => actions.openDocs() },
        { id: 'about', label: 'О программе', click: () => actions.about() },
      ],
    },
  ];

  if (mac) {
    template.unshift({
      label: 'OpenSpec IDE',
      submenu: [
        { label: 'О программе', click: () => actions.about() },
        { type: 'separator' },
        { label: 'Скрыть', role: 'hide' },
        { type: 'separator' },
        { label: 'Выйти', role: 'quit' },
      ],
    });
  }
  return template;
}
