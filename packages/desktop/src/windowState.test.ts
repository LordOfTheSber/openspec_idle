import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, WindowStateStore, restoreGeometry, type Rect } from './windowState.js';

const primary: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const right: Rect = { x: 1920, y: 0, width: 1280, height: 1024 };

describe('restoreGeometry', () => {
  it('возвращает прежние размер и положение, если окно на мониторе', () => {
    const saved = { x: 2000, y: 100, width: 1000, height: 700, maximized: false };
    expect(restoreGeometry(saved, [primary, right], primary)).toEqual(saved);
  });

  it('переносит окно на основной монитор, если прежний отключён', () => {
    const saved = { x: 2000, y: 100, width: 1000, height: 700, maximized: true };
    expect(restoreGeometry(saved, [primary], primary)).toEqual({
      x: 460,
      y: 170,
      width: 1000,
      height: 700,
      maximized: true,
    });
  });

  it('ужимает окно, не помещающееся на основной монитор', () => {
    const small: Rect = { x: 0, y: 0, width: 1280, height: 680 };
    const saved = { x: 5000, y: 5000, width: 2500, height: 1400, maximized: false };
    expect(restoreGeometry(saved, [small], small)).toMatchObject({ x: 0, y: 0, width: 1280, height: 680 });
  });

  it('считает окно потерянным, если видна лишь узкая полоска', () => {
    const saved = { x: 1900, y: -600, width: 1000, height: 700, maximized: false };
    expect(restoreGeometry(saved, [primary], primary).x).toBe(460);
  });

  it('без сохранённого — размер по умолчанию по центру', () => {
    expect(restoreGeometry(null, [primary], primary)).toMatchObject({
      width: DEFAULT_SIZE.width,
      height: DEFAULT_SIZE.height,
      maximized: false,
    });
  });
});

describe('WindowStateStore', () => {
  it('хранит геометрию по пути репозитория и переживает испорченные записи', () => {
    const store = new WindowStateStore(join(mkdtempSync(join(tmpdir(), 'osi-ws-')), 'windows.json'));
    expect(store.get('/repo')).toBeNull();
    store.set('/repo', { x: 1, y: 2, width: 900, height: 600, maximized: false });
    expect(store.get('/repo')).toEqual({ x: 1, y: 2, width: 900, height: 600, maximized: false });
    expect(store.get('/other')).toBeNull();
  });
});
