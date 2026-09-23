import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildArgs, displayCommand, parseDuration, templateFlags } from './launch.js';

const REFERENCE = fileURLToPath(new URL('../../../../tests/agent/', import.meta.url));

async function defaults() {
  // Каталога нет — применяются значения по умолчанию.
  return (await loadConfig('/nonexistent-openspec-ide-root')).config.agent;
}

describe('шаблон аргументов', () => {
  it('подставляет значения в порядке шаблона', async () => {
    const agent = await defaults();
    const args = buildArgs(agent.launch.args, {
      prompt: 'Сделай пункт',
      format: 'stream-json',
      approvalMode: 'default',
      maxWallTime: '15m',
      maxToolCalls: 120,
      model: 'GigaChat-2-Max',
      extraArgs: ['--auth-type', 'openai'],
    });

    expect(args).toEqual([
      'Сделай пункт',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'default',
      '--max-wall-time',
      '15m',
      '--max-tool-calls',
      '120',
      '--model',
      'GigaChat-2-Max',
      '--auth-type',
      'openai',
    ]);
  });

  it('без модели выпадает и флаг --model', async () => {
    const agent = await defaults();
    const args = buildArgs(agent.launch.args, {
      prompt: 'x',
      format: 'json',
      approvalMode: 'plan',
      maxWallTime: '1m',
      maxToolCalls: 5,
      model: null,
      extraArgs: [],
    });
    expect(args).not.toContain('--model');
    expect(args.at(-1)).toBe('5');
  });

  it('промпт с дефисом в начале не превращается во флаг', () => {
    const args = buildArgs(['{prompt}'], {
      prompt: '--help',
      format: 'json',
      approvalMode: 'plan',
      maxWallTime: '1m',
      maxToolCalls: 1,
      model: null,
      extraArgs: [],
    });
    expect(args[0]?.startsWith('-')).toBe(false);
  });

  it('длительности переводятся в миллисекунды', () => {
    expect(parseDuration('90')).toBe(90_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('пять минут')).toBeNull();
  });

  it('команда для показа не содержит текста промпта', () => {
    expect(displayCommand('gigacode', ['секрет промпта', '--approval-mode', 'plan'], 'секрет промпта')).toBe(
      'gigacode "<промпт>" --approval-mode plan',
    );
  });
});

describe('сверка шаблона с записанным интерфейсом CLI', () => {
  // Каждый каталог tests/agent/<сборка>/ хранит вывод `--help` конкретной
  // сборки. Шаблон по умолчанию обязан подходить ко всем записанным сборкам.
  const builds = readdirSync(REFERENCE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(`${REFERENCE}${entry.name}/help.txt`))
    .map((entry) => entry.name);

  it('записан хотя бы один интерфейс', () => {
    expect(builds.length).toBeGreaterThan(0);
  });

  for (const build of builds) {
    it(`${build}: все флаги шаблона и значения по умолчанию есть в --help`, async () => {
      const help = readFileSync(`${REFERENCE}${build}/help.txt`, 'utf8');
      const agent = await defaults();

      for (const flag of templateFlags(agent.launch.args)) {
        expect(help, `флаг ${flag}`).toMatch(new RegExp(`(^|[\\s,])${flag}(\\s|,|$)`, 'm'));
      }
      expect(help).toContain(agent.launch.streamFormat);
      expect(help).toContain(`"${agent.launch.oneShotFormat}"`);
      for (const mode of ['plan', 'default', 'auto-edit', 'yolo']) {
        expect(help, `режим ${mode}`).toContain(`"${mode}"`);
      }
      expect(help).toMatch(/exit code 55/);
    });
  }
});
