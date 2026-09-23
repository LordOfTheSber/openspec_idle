import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from './fs/workspace.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, IDE_DIR, SecretInConfigError, loadConfig, saveConfig } from './config.js';

let root: string;

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-config-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  mkdirSync(join(root, IDE_DIR), { recursive: true });
  writeFileSync(join(root, IDE_DIR, CONFIG_FILE), JSON.stringify(value, null, 2));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, IDE_DIR, CONFIG_FILE), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('конфигурация IDE', () => {
  it('без файла применяет значения по умолчанию', async () => {
    const loaded = await loadConfig(root);

    expect(loaded.usedDefaults).toBe(true);
    expect(loaded.config.agent.command).toBe('gigacode');
    expect(loaded.config.agent.approvalMode).toBe('default');
    expect(loaded.config.agent.credentialsEnv).toBe('GIGACODE_API_KEY');
  });

  it('файл создаётся при первом сохранении из интерфейса', async () => {
    await saveConfig(root, { agent: { model: 'GigaChat-2-Max' } });

    expect(readConfig()['agent']).toMatchObject({ model: 'GigaChat-2-Max' });
  });

  it('отсутствующие поля дополняются значениями по умолчанию', async () => {
    writeConfig({ agent: { model: 'GigaChat-2-Pro' } });

    const loaded = await loadConfig(root);
    expect(loaded.config.agent.model).toBe('GigaChat-2-Pro');
    expect(loaded.config.agent.maxToolCalls).toBe(120);
  });

  it('нераспознанные поля перечисляются и сохраняются при перезаписи', async () => {
    writeConfig({ agent: { model: 'M', ещёНеизвестное: 42 }, будущийРаздел: { a: 1 } });

    const loaded = await loadConfig(root);
    expect(loaded.unknownFields).toContain('agent.ещёНеизвестное');
    expect(loaded.unknownFields).toContain('будущийРаздел');

    await saveConfig(root, { agent: { model: 'N' } });

    const written = readConfig();
    expect(written['будущийРаздел']).toEqual({ a: 1 });
    expect((written['agent'] as Record<string, unknown>)['ещёНеизвестное']).toBe(42);
    expect((written['agent'] as Record<string, unknown>)['model']).toBe('N');
  });

  it('нечитаемый файл не роняет загрузку и объясняет причину', async () => {
    mkdirSync(join(root, IDE_DIR), { recursive: true });
    writeFileSync(join(root, IDE_DIR, CONFIG_FILE), '{ это не json');

    const loaded = await loadConfig(root);
    expect(loaded.parseError).not.toBeNull();
    expect(loaded.config.agent.command).toBe('gigacode');
  });

  it('запись значения секретного поля отклоняется', async () => {
    await expect(saveConfig(root, { agent: { apiKey: 'секрет' } })).rejects.toThrow(
      SecretInConfigError,
    );
    await expect(saveConfig(root, { agent: { token: 'секрет' } })).rejects.toThrow(
      /переменной окружения/,
    );
  });

  it('пустое значение секретного поля записи не мешает', async () => {
    await expect(saveConfig(root, { agent: { apiKey: '   ' } })).resolves.toBeDefined();
  });

  it('имя переменной окружения сохраняется, значение — нет', async () => {
    await saveConfig(root, { agent: { credentialsEnv: 'MY_GIGACODE_KEY' } });

    const written = JSON.stringify(readConfig());
    expect(written).toContain('MY_GIGACODE_KEY');
    expect(written).not.toContain('apiKey');
  });

  it('значение ключа, вставленное вместо имени переменной, отклоняется', async () => {
    await expect(
      saveConfig(root, { agent: { credentialsEnv: 'sk-live-1234567890abcdef' } }),
    ).rejects.toThrow(/значение ключа[\s\S]*переменной окружения/);
  });

  it('секрет в дополнительных аргументах CLI отклоняется', async () => {
    await expect(
      saveConfig(root, { agent: { extraArgs: ['--openai-api-key', 'sk-live-1'] } }),
    ).rejects.toBeInstanceOf(SecretInConfigError);
    await expect(
      saveConfig(root, { agent: { extraArgs: ['--auth-type', 'openai'] } }),
    ).resolves.toBeDefined();
  });

  it('переменная учётных данных может быть не нужна', async () => {
    const config = await saveConfig(root, { agent: { credentialsEnv: null } });
    expect(config.agent.credentialsEnv).toBeNull();
  });

  it('значения по умолчанию безопасны: режим с подтверждением и заданные бюджеты', async () => {
    const { config } = await loadConfig(root);
    expect(config.agent.approvalMode).toBe('default');
    expect(config.agent.maxWallTime).toBe('15m');
    expect(config.agent.maxToolCalls).toBe(120);
    expect(config.agent.launch.streamFormat).toBe('stream-json');
  });
});
