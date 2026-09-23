import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { menuTemplate, SECTIONS, type MenuActions } from './menu.js';

function actions(): MenuActions {
  return {
    openDialog: vi.fn(),
    openRecent: vi.fn(),
    showStart: vi.fn(),
    closeWindow: vi.fn(),
    showSection: vi.fn(),
    openDocs: vi.fn(),
    about: vi.fn(),
  };
}

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? items(item.submenu as MenuItemConstructorOptions[]) : []),
  ]);
}

function click(item: MenuItemConstructorOptions | undefined): void {
  (item?.click as (() => void) | undefined)?.();
}

describe('menuTemplate', () => {
  it('открывает репозиторий по Ctrl+O и переключает разделы по Ctrl+1…8', () => {
    const acts = actions();
    const all = items(menuTemplate({ recent: [], repositoryFocused: true, platform: 'win32', actions: acts }));
    const open = all.find((item) => item.id === 'open-repository');
    expect(open?.accelerator).toBe('CmdOrCtrl+O');
    click(open);
    expect(acts.openDialog).toHaveBeenCalled();

    SECTIONS.forEach((section, index) => {
      const item = all.find((entry) => entry.id === `section-${section.id}`);
      expect(item).toMatchObject({ label: section.label, accelerator: `CmdOrCtrl+${index + 1}`, enabled: true });
    });
    click(all.find((item) => item.id === 'section-board'));
    expect(acts.showSection).toHaveBeenCalledWith('board');
  });

  it('выключает разделы, когда в фокусе стартовый экран', () => {
    const all = items(menuTemplate({ recent: [], repositoryFocused: false, platform: 'linux', actions: actions() }));
    expect(all.find((item) => item.id === 'section-explorer')?.enabled).toBe(false);
  });

  it('показывает недавние и выключает недоступные', () => {
    const acts = actions();
    const template = menuTemplate({
      recent: [
        { path: '/work/bank', name: 'bank', available: true },
        { path: '/work/gone', name: 'gone', available: false },
      ],
      repositoryFocused: false,
      platform: 'linux',
      actions: acts,
    });
    const recent = items(template).find((item) => item.id === 'recent');
    const [first, second] = recent?.submenu as MenuItemConstructorOptions[];
    expect(second).toMatchObject({ label: 'gone  (недоступен)', enabled: false });
    click(first);
    expect(acts.openRecent).toHaveBeenCalledWith('/work/bank');
  });

  it('на macOS добавляет меню приложения и не дублирует «Выход» в «Файле»', () => {
    const template = menuTemplate({ recent: [], repositoryFocused: false, platform: 'darwin', actions: actions() });
    expect(template[0]?.label).toBe('OpenSpec IDE');
    const file = template.find((item) => item.label === 'Файл')?.submenu as MenuItemConstructorOptions[];
    expect(file.some((item) => item.role === 'quit')).toBe(false);
  });
});
