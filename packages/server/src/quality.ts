import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import {
  DEFAULT_QUALITY_CONFIG,
  QUALITY_FILE,
  type QualityConfig,
  type QualityConfigError,
  type RegistryFile,
  parseQualityConfig,
  registryCodes,
} from '@openspec-ide/core';
import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';

/**
 * Читает настройки проверки качества спеков — `openspec/quality.yaml` — и
 * файлы реестра кодов ошибок, на которые они ссылаются. Без файла настроек —
 * умолчания; ошибки файла и ненайденные реестры попадают в `errors`.
 */
export async function readQualityConfig(root: string): Promise<QualityConfig> {
  let text: string;
  try {
    text = await readFile(join(root, QUALITY_FILE), 'utf8');
  } catch {
    return DEFAULT_QUALITY_CONFIG;
  }

  const counter = new LineCounter();
  const document = parseDocument(text, { lineCounter: counter, prettyErrors: false });
  const failure = document.errors[0];
  if (failure !== undefined) {
    return {
      ...DEFAULT_QUALITY_CONFIG,
      path: QUALITY_FILE,
      errors: [
        {
          line: counter.linePos(failure.pos[0]).line,
          message: `${QUALITY_FILE} не разбирается как YAML: ${failure.message.split('\n')[0] ?? failure.message}`,
        },
      ],
    };
  }

  const lines = new Map<string, number>();
  const walk = (node: unknown, path: readonly string[]): void => {
    if (!isMap(node)) return;
    for (const pair of node.items) {
      if (!isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      const offset = pair.key.range?.[0];
      if (offset !== undefined) lines.set([...path, key].join('\u0000'), counter.linePos(offset).line);
      walk(pair.value, [...path, key]);
    }
  };
  walk(document.contents, []);
  const lineOf = (path: readonly string[]): number | null => lines.get(path.join('\u0000')) ?? null;

  const { config, registryPaths } = parseQualityConfig(document.toJS(), lineOf);
  if (registryPaths.length === 0) return config;

  const errors: QualityConfigError[] = [...config.errors];
  const registry: RegistryFile[] = [];
  for (const path of registryPaths) {
    const relative = normalize(path).replaceAll('\\', '/');
    // Реестр — файл проекта: путь вне корня не читается.
    if (isAbsolute(path) || relative.startsWith('..')) {
      errors.push({ line: lineOf(['errorCodes', 'registry']), message: `${QUALITY_FILE}: реестр «${path}» — путь от корня проекта, без выхода за него` });
      continue;
    }
    try {
      const content = await readFile(join(root, relative), 'utf8');
      registry.push({ path: relative, codes: registryCodes(content, config.errorCodePattern) });
    } catch {
      errors.push({ line: lineOf(['errorCodes', 'registry']), message: `${QUALITY_FILE}: файл реестра кодов ошибок «${path}» не найден` });
    }
  }
  return { ...config, registry, errors };
}
