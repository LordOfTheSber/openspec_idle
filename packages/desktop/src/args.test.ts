import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryArgument } from './args.js';

describe('repositoryArgument', () => {
  const cwd = resolve('/work');

  it('берёт путь после исполняемого файла упакованного приложения', () => {
    expect(repositoryArgument(['OpenSpec IDE.exe', '/repo'], { defaultApp: false, cwd })).toBe('/repo');
  });

  it('пропускает скрипт главного процесса при запуске из исходников', () => {
    expect(repositoryArgument(['electron', 'dist/main.mjs', '/repo'], { defaultApp: true, cwd })).toBe('/repo');
    expect(repositoryArgument(['electron', 'dist/main.mjs'], { defaultApp: true, cwd })).toBeNull();
    expect(
      repositoryArgument(['electron', '--inspect=0', 'packages/desktop', '--no-sandbox', '/repo'], {
        defaultApp: true,
        cwd,
      }),
    ).toBe('/repo');
  });

  it('пропускает ключи Chromium и Electron', () => {
    expect(
      repositoryArgument(['app', '--no-sandbox', '--inspect=0', '/repo', '--x'], { defaultApp: false, cwd }),
    ).toBe('/repo');
  });

  it('разрешает относительный путь от каталога запуска', () => {
    expect(repositoryArgument(['app', 'services/billing'], { defaultApp: false, cwd })).toBe(
      resolve(cwd, 'services/billing'),
    );
  });

  it('без пути — стартовый экран', () => {
    expect(repositoryArgument(['app'], { defaultApp: false, cwd })).toBeNull();
  });
});
