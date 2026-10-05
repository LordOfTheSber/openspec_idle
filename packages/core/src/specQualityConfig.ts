/**
 * Разбор настроек проверки качества спеков — `openspec/quality.yaml`.
 *
 * Модуль чистый: YAML разбирает сервер и передаёт сюда значение и функцию,
 * которая по пути ключа отвечает строкой в файле. Реестр кодов ошибок сервер
 * читает сам — по путям, которые вернул разбор.
 */
import {
  type ArtifactRule,
  DEFAULT_QUALITY_CONFIG,
  QUALITY_METRICS,
  QUALITY_RULES,
  type QualityConfig,
  type QualityConfigError,
  type QualityExclusion,
  type QualityLevel,
  type QualityMetric,
  type QualityRule,
  type QualityThreshold,
  type RegistryCode,
} from './specQuality.js';

/** Путь файла настроек от корня проекта. */
export const QUALITY_FILE = 'openspec/quality.yaml';

const KEYS = ['version', 'scope', 'rules', 'errorCodes', 'actors', 'glossary', 'parameters', 'vagueWords', 'internalTerms', 'thresholds', 'artifacts', 'exclude'];
const EXCLUDE_KEYS = ['rule', 'path', 'requirement', 'reason'];
const ARTIFACT_KEYS = ['id', 'artifact', 'each', 'heading', 'require', 'forbid', 'message', 'level'];
const LEVELS: readonly string[] = ['error', 'warning', 'info', 'off'];

export interface ParsedQualityConfig {
  /** Настройки без реестра кодов: его сервер дочитывает по `registryPaths`. */
  readonly config: QualityConfig;
  readonly registryPaths: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Разбирает значение `quality.yaml`. Ошибки не прерывают разбор: неверный
 * ключ пропускается, остальные настройки действуют.
 */
export function parseQualityConfig(raw: unknown, lineOf: (path: readonly string[]) => number | null = () => null): ParsedQualityConfig {
  const errors: QualityConfigError[] = [];
  const error = (path: readonly string[], message: string): void => {
    errors.push({ line: lineOf(path), message: `${QUALITY_FILE}: ${message}` });
  };
  if (raw === null || raw === undefined) {
    return { config: { ...DEFAULT_QUALITY_CONFIG, path: QUALITY_FILE }, registryPaths: [] };
  }
  if (!isRecord(raw)) {
    error([], 'ожидается словарь настроек');
    return { config: { ...DEFAULT_QUALITY_CONFIG, path: QUALITY_FILE, errors }, registryPaths: [] };
  }

  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) error([key], `неизвестный ключ «${key}». Доступны: ${KEYS.join(', ')}`);
  }

  const strings = (path: readonly string[], value: unknown): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' && typeof item !== 'number')) {
      error(path, `«${path.join('.')}» — список строк`);
      return [];
    }
    return value.map(String);
  };

  let scope: QualityConfig['scope'] = 'all';
  if (raw['scope'] !== undefined) {
    if (raw['scope'] === 'all' || raw['scope'] === 'changes') scope = raw['scope'];
    else error(['scope'], '«scope» — all (основные спеки и дельты) или changes (только дельты активных changes)');
  }

  const levels: Partial<Record<QualityRule, QualityLevel | 'off'>> = {};
  const rules = raw['rules'];
  if (rules !== undefined && rules !== null) {
    if (!isRecord(rules)) {
      error(['rules'], '«rules» — словарь «правило: уровень»');
    } else {
      for (const [rule, value] of Object.entries(rules)) {
        if (!(rule in QUALITY_RULES)) {
          error(['rules', rule], `неизвестное правило «${rule}». Доступны: ${Object.keys(QUALITY_RULES).join(', ')}`);
          continue;
        }
        // В YAML 1.1 «off» читается как false.
        const level = value === false ? 'off' : value;
        if (typeof level !== 'string' || !LEVELS.includes(level)) {
          error(['rules', rule], `уровень правила «${rule}» — ${LEVELS.join(', ')}`);
          continue;
        }
        levels[rule as QualityRule] = level as QualityLevel | 'off';
      }
    }
  }

  let errorCodePattern: string | null = null;
  const registryPaths: string[] = [];
  const errorCodes = raw['errorCodes'];
  if (errorCodes !== undefined && errorCodes !== null) {
    if (!isRecord(errorCodes)) {
      error(['errorCodes'], '«errorCodes» — словарь с ключами pattern и registry');
    } else {
      for (const key of Object.keys(errorCodes)) {
        if (key !== 'pattern' && key !== 'registry') error(['errorCodes', key], `неизвестный ключ «errorCodes.${key}». Доступны: pattern, registry`);
      }
      const pattern = errorCodes['pattern'];
      if (pattern !== undefined && pattern !== null) {
        if (typeof pattern !== 'string') {
          error(['errorCodes', 'pattern'], '«errorCodes.pattern» — регулярное выражение строкой');
        } else {
          try {
            new RegExp(pattern, 'u');
            errorCodePattern = pattern;
          } catch (failure) {
            error(['errorCodes', 'pattern'], `«errorCodes.pattern» не разбирается: ${(failure as Error).message}`);
          }
        }
      }
      registryPaths.push(...strings(['errorCodes', 'registry'], errorCodes['registry']));
    }
  }

  const parameters: Record<string, number | null> = {};
  const rawParameters = raw['parameters'];
  if (Array.isArray(rawParameters)) {
    for (const name of strings(['parameters'], rawParameters)) parameters[name] = null;
  } else if (rawParameters !== undefined && rawParameters !== null) {
    if (!isRecord(rawParameters)) {
      error(['parameters'], '«parameters» — словарь «параметр: значение» или список имён');
    } else {
      for (const [name, value] of Object.entries(rawParameters)) {
        if (value === null || value === undefined) parameters[name] = null;
        else if (typeof value === 'number' && Number.isFinite(value)) parameters[name] = value;
        else error(['parameters', name], `значение параметра «${name}» — число или пусто`);
      }
    }
  }

  const wordList = (key: 'vagueWords' | 'internalTerms'): { add: string[]; ignore: string[] } => {
    const value = raw[key];
    if (value === undefined || value === null) return { add: [], ignore: [] };
    if (Array.isArray(value)) return { add: strings([key], value), ignore: [] };
    if (!isRecord(value)) {
      error([key], `«${key}» — словарь с ключами add и ignore или список слов`);
      return { add: [], ignore: [] };
    }
    for (const item of Object.keys(value)) {
      if (item !== 'add' && item !== 'ignore') error([key, item], `неизвестный ключ «${key}.${item}». Доступны: add, ignore`);
    }
    return { add: strings([key, 'add'], value['add']), ignore: strings([key, 'ignore'], value['ignore']) };
  };

  const thresholds: QualityThreshold[] = [];
  const rawThresholds = raw['thresholds'];
  if (rawThresholds !== undefined && rawThresholds !== null) {
    if (!isRecord(rawThresholds)) {
      error(['thresholds'], '«thresholds» — словарь «метрика: порог»');
    } else {
      for (const [metric, value] of Object.entries(rawThresholds)) {
        if (!(QUALITY_METRICS as readonly string[]).includes(metric)) {
          error(['thresholds', metric], `неизвестная метрика «${metric}». Доступны: ${QUALITY_METRICS.join(', ')}`);
          continue;
        }
        const ratio = metric !== 'ambiguityDensity';
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (ratio && value > 1)) {
          error(['thresholds', metric], ratio ? `порог «${metric}» — доля от 0 до 1` : `порог «${metric}» — неотрицательное число на 100 слов`);
          continue;
        }
        thresholds.push({ metric: metric as QualityMetric, value, line: lineOf(['thresholds', metric]) });
      }
    }
  }

  const artifactRules: ArtifactRule[] = [];
  const rawArtifacts = raw['artifacts'];
  if (rawArtifacts !== undefined && rawArtifacts !== null) {
    if (!Array.isArray(rawArtifacts)) {
      error(['artifacts'], '«artifacts» — список правил с ключами id, artifact, each, require или forbid, message');
    } else {
      rawArtifacts.forEach((item: unknown, index) => {
        const path = ['artifacts', String(index)];
        if (!isRecord(item)) {
          error(path, `правило артефактов №${index + 1} — словарь`);
          return;
        }
        for (const key of Object.keys(item)) {
          if (!ARTIFACT_KEYS.includes(key)) error([...path, key], `неизвестный ключ правила артефактов «${key}». Доступны: ${ARTIFACT_KEYS.join(', ')}`);
        }
        const text = (key: string): string | null => {
          const value = item[key];
          if (value === undefined || value === null) return null;
          if (typeof value !== 'string' || value.trim() === '') {
            error([...path, key], `«${key}» правила артефактов — непустая строка`);
            return null;
          }
          return value;
        };
        const pattern = (key: string): string | null => {
          const value = text(key);
          if (value === null) return null;
          try {
            new RegExp(value, 'iu');
            return value;
          } catch (failure) {
            error([...path, key], `«${key}» правила артефактов не разбирается: ${(failure as Error).message}`);
            return null;
          }
        };
        const id = text('id') ?? `artifacts[${index}]`;
        const artifact = text('artifact');
        const each = item['each'] ?? 'file';
        const require = pattern('require');
        const forbid = pattern('forbid');
        const heading = pattern('heading');
        const level = item['level'];
        if (artifact === null) error(path, `у правила «${id}» нет «artifact» — идентификатора артефакта схемы (proposal, design, tasks, specs…)`);
        if (each !== 'file' && each !== 'section' && each !== 'item') error([...path, 'each'], `«each» правила «${id}» — file, section или item`);
        if (require === null && forbid === null) error(path, `у правила «${id}» нет ни «require», ни «forbid»`);
        if (level !== undefined && level !== null && level !== 'error' && level !== 'warning' && level !== 'info') {
          error([...path, 'level'], `уровень правила «${id}» — error, warning или info`);
        }
        if (artifact === null || (each !== 'file' && each !== 'section' && each !== 'item') || (require === null && forbid === null)) return;
        artifactRules.push({
          id,
          artifact,
          each,
          heading,
          require,
          forbid,
          message: text('message') ?? (require !== null ? `нет «${require}»` : `есть «${forbid ?? ''}»`),
          level: level === 'error' || level === 'warning' || level === 'info' ? level : null,
          line: lineOf(path),
        });
      });
    }
  }

  const exclusions: QualityExclusion[] = [];
  const rawExclude = raw['exclude'];
  if (rawExclude !== undefined && rawExclude !== null) {
    if (!Array.isArray(rawExclude)) {
      error(['exclude'], '«exclude» — список исключений с ключами rule, path, requirement, reason');
    } else {
      rawExclude.forEach((item: unknown, index) => {
        const path = ['exclude', String(index)];
        if (!isRecord(item)) {
          error(path, `исключение №${index + 1} — словарь`);
          return;
        }
        for (const key of Object.keys(item)) {
          if (!EXCLUDE_KEYS.includes(key)) error([...path, key], `неизвестный ключ исключения «${key}». Доступны: ${EXCLUDE_KEYS.join(', ')}`);
        }
        const text = (key: string): string | null => {
          const value = item[key];
          if (value === undefined || value === null) return null;
          if (typeof value !== 'string' || value.trim() === '') {
            error([...path, key], `«${key}» исключения — непустая строка`);
            return null;
          }
          return value.trim();
        };
        const rule = text('rule');
        if (rule !== null && !(rule in QUALITY_RULES)) {
          error([...path, 'rule'], `неизвестное правило исключения «${rule}». Доступны: ${Object.keys(QUALITY_RULES).join(', ')}`);
          return;
        }
        const target = text('path');
        const requirement = text('requirement');
        if (rule === null && target === null && requirement === null) {
          error(path, `исключение №${index + 1} не задаёт ни rule, ни path, ни requirement — оно исключило бы всё`);
          return;
        }
        exclusions.push({ rule: rule as QualityRule | null, path: target, requirement, reason: text('reason'), line: lineOf(path) });
      });
    }
  }

  return {
    config: {
      path: QUALITY_FILE,
      scope,
      levels,
      errorCodePattern,
      actors: strings(['actors'], raw['actors']),
      glossary: strings(['glossary'], raw['glossary']),
      parameters,
      vagueWords: wordList('vagueWords'),
      internalTerms: wordList('internalTerms'),
      registry: null,
      thresholds,
      artifactRules,
      exclusions,
      errors,
    },
    registryPaths,
  };
}

/** Коды ошибок файла реестра — все совпадения шаблона кода, первое вхождение со строкой. */
export function registryCodes(text: string, pattern: string | null): RegistryCode[] {
  const source = pattern ?? '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, 'gu');
  const seen = new Set<string>();
  const result: RegistryCode[] = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(re)) {
      if (seen.has(match[0])) continue;
      seen.add(match[0]);
      result.push({ code: match[0], line: index + 1 });
    }
  });
  return result;
}
