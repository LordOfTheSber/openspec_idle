import { resolve } from 'node:path';
import { CheckUsageError, runCheck } from '@openspec-ide/server';
import { USAGE, exitCode, formatGithub, formatJson, formatText, parseArgs } from './report.js';

/** Запуск команды: возвращает код завершения, не завершая процесс. */
export async function main(argv: readonly string[], cwd: string, write: (text: string) => void): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      write(USAGE);
      return 0;
    }
    const report = await runCheck({
      cwd: resolve(cwd, args.root ?? '.'),
      only: args.only,
      skip: args.skip,
      cliPath: args.cli,
      baseline: args.baseline,
    });
    const format = args.format === 'json' ? formatJson : args.format === 'github' ? formatGithub : formatText;
    write(format(report, args.failOn));
    return exitCode(report, args.failOn);
  } catch (error) {
    if (error instanceof CheckUsageError) {
      console.error(`openspec-ide-check: ${error.message}`);
      return 2;
    }
    console.error(`openspec-ide-check: проверка не выполнилась — ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

// Запуск как команды, а не импорт из теста.
const invoked = process.argv[1] ?? '';
if (/openspec-ide-check(\.m?js)?$|[\\/]check[\\/]src[\\/]cli\.ts$/.test(invoked)) {
  const code = await main(process.argv.slice(2), process.cwd(), (text) => process.stdout.write(text));
  process.exitCode = code;
}
