import type { ArchivePreview, SpecPreview } from '@openspec-ide/server';

/** Текст подтверждения архивации по предпросмотру. */
export interface ArchiveSummary {
  /** CLI по предпросмотру архивирует change — архивацию можно предлагать. */
  readonly archivable: boolean;
  readonly message: string;
  /** Подробности для модального окна: по строке на capability и замечание. */
  readonly detail: string;
}

/** Одна строка сводки по capability: `data-export — новая: +2`. */
export function specLine(spec: SpecPreview): string {
  const counts = [
    spec.counts.added > 0 ? `+${spec.counts.added}` : null,
    spec.counts.modified > 0 ? `~${spec.counts.modified}` : null,
    spec.counts.renamed > 0 ? `→${spec.counts.renamed}` : null,
    spec.counts.removed > 0 ? `−${spec.counts.removed}` : null,
  ].filter((part): part is string => part !== null);
  const status = spec.status === 'created' ? 'новая' : 'изменится';
  return `${spec.capability} — ${status}${counts.length === 0 ? '' : `: ${counts.join(' ')}`}`;
}

/**
 * Сводка для подтверждения архивации.
 *
 * Архивация предлагается только при исходе «пройдёт»: в остальных случаях
 * CLI её заведомо отклонит, и пользователь увидит причину до, а не после.
 */
export function archiveSummary(preview: ArchivePreview, unfinished = 0): ArchiveSummary {
  const specs = preview.specs.map(specLine);
  const problems = preview.problems.flatMap((problem) => [
    problem.message,
    ...(problem.fix === null ? [] : [`Как исправить: ${problem.fix}`]),
  ]);
  const legend = specs.length > 0 ? ['', '+ добавлено · ~ изменено · → переименовано · − удалено'] : [];

  if (preview.outcome === 'refused') {
    return {
      archivable: false,
      message: `CLI отклонит архивацию change «${preview.change}».`,
      detail: [...problems, ...(problems.length === 0 && preview.output !== '' ? [preview.output] : [])].join('\n'),
    };
  }

  if (preview.outcome === 'validation-failed') {
    return {
      archivable: false,
      message: `Архивацию change «${preview.change}» остановит проверка.`,
      detail: [
        ...problems,
        '',
        specs.length > 0 ? 'После исправления ошибок основные спеки изменятся так:' : 'Основные спеки не изменятся.',
        ...specs,
        ...legend,
      ].join('\n'),
    };
  }

  return {
    archivable: true,
    message: `Архивировать change «${preview.change}»?`,
    detail: [
      ...(unfinished > 0 ? [`Не выполнено пунктов: ${unfinished}.`, ''] : []),
      specs.length > 0 ? 'Основные спеки изменятся так:' : 'Основные спеки не изменятся.',
      ...specs,
      ...preview.warnings.map((warning) => `Предупреждение CLI: ${warning}`),
      ...legend,
    ].join('\n'),
  };
}
