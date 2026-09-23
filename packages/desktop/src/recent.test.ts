import { describe, expect, it } from 'vitest';
import { RECENT_LIMIT, RecentList, type RecentFs, samePath } from './recent.js';

function memoryFs(available: Set<string> = new Set()): RecentFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: (file) => files.get(file) ?? null,
    write: (file, text) => void files.set(file, text),
    available: (path) => available.has(path),
  };
}

describe('RecentList', () => {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

  it('поднимает открытый репозиторий в начало без повторов', () => {
    const fs = memoryFs(new Set(['/a', '/b']));
    const recent = new RecentList('/profile/recent.json', fs, now);
    recent.add('/a');
    recent.add('/b');
    recent.add('/a');
    expect(recent.list().map((entry) => entry.path)).toEqual(['/a', '/b']);
    expect(recent.list()[0]).toMatchObject({ name: 'a', available: true });
  });

  it('помечает недоступные папки и убирает их по запросу', () => {
    const fs = memoryFs(new Set(['/a']));
    const recent = new RecentList('/profile/recent.json', fs, now);
    recent.add('/gone');
    recent.add('/a');
    expect(recent.list().map((entry) => [entry.path, entry.available])).toEqual([
      ['/a', true],
      ['/gone', false],
    ]);
    recent.remove('/gone');
    expect(recent.list().map((entry) => entry.path)).toEqual(['/a']);
  });

  it(`хранит не больше ${RECENT_LIMIT} репозиториев`, () => {
    const recent = new RecentList('/profile/recent.json', memoryFs(), now);
    for (let index = 0; index < RECENT_LIMIT + 5; index += 1) recent.add(`/r${index}`);
    const list = recent.list();
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]?.path).toBe(`/r${RECENT_LIMIT + 4}`);
  });

  it('начинает заново при испорченном файле', () => {
    const fs = memoryFs();
    fs.files.set('/profile/recent.json', '{не json');
    const recent = new RecentList('/profile/recent.json', fs, now);
    expect(recent.list()).toEqual([]);
    recent.add('/a');
    expect(recent.list().map((entry) => entry.path)).toEqual(['/a']);
  });

  it('сравнивает пути Windows без учёта регистра', () => {
    expect(samePath('C:\\Work\\Repo', 'c:\\work\\repo', 'win32')).toBe(true);
    expect(samePath('/work/Repo', '/work/repo', 'linux')).toBe(false);
  });
});
