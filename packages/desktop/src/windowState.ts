import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Сохранённое состояние окна репозитория. */
export interface WindowGeometry extends Rect {
  readonly maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1400, height: 900 } as const;
const MIN_SIZE = { width: 800, height: 500 } as const;
/** Сколько окна должно быть видно на мониторе, чтобы за него можно было взяться. */
const GRIP = { width: 120, height: 40 } as const;

/**
 * Где открыть окно. Сохранённое положение берётся, если заголовок окна
 * виден на одном из мониторов; иначе — монитор отключили — окно размещается
 * по центру основного, с прежним размером, ужатым до его рабочей области.
 */
export function restoreGeometry(
  saved: WindowGeometry | null,
  displays: readonly Rect[],
  primary: Rect,
): WindowGeometry {
  if (saved !== null && displays.some((display) => titleVisible(saved, display))) {
    return saved;
  }
  const width = clamp(saved?.width ?? DEFAULT_SIZE.width, MIN_SIZE.width, primary.width);
  const height = clamp(saved?.height ?? DEFAULT_SIZE.height, MIN_SIZE.height, primary.height);
  return {
    x: primary.x + Math.round((primary.width - width) / 2),
    y: primary.y + Math.round((primary.height - height) / 2),
    width,
    height,
    maximized: saved?.maximized ?? false,
  };
}

function titleVisible(window: Rect, display: Rect): boolean {
  // Полоса заголовка — верхние GRIP.height пикселей окна.
  const left = Math.max(window.x, display.x);
  const right = Math.min(window.x + window.width, display.x + display.width);
  const top = Math.max(window.y, display.y);
  const bottom = Math.min(window.y + GRIP.height, display.y + display.height);
  return right - left >= GRIP.width && bottom - top >= GRIP.height / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(Math.min(value, max), Math.min(min, max));
}

/** Геометрия окон по пути репозитория в профиле пользователя. */
export class WindowStateStore {
  constructor(private readonly file: string) {}

  get(root: string): WindowGeometry | null {
    const entry = this.load()[key(root)];
    return entry !== undefined && isGeometry(entry) ? entry : null;
  }

  set(root: string, geometry: WindowGeometry): void {
    const all = this.load();
    all[key(root)] = geometry;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, `${JSON.stringify(all, null, 2)}\n`);
      renameSync(`${this.file}.tmp`, this.file);
    } catch (error) {
      console.error(`Не удалось сохранить положение окна: ${String(error)}`);
    }
  }

  private load(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

function key(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function isGeometry(value: unknown): value is WindowGeometry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    ['x', 'y', 'width', 'height'].every((name) => Number.isFinite(entry[name])) &&
    typeof entry['maximized'] === 'boolean'
  );
}
