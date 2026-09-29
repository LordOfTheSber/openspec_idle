/**
 * Готовность change к архивации — пять условий. Готовность ничего не
 * блокирует: архивация по-прежнему идёт через подтверждение с предпросмотром.
 */

export type CheckState = 'ok' | 'fail' | 'unknown';

export interface ReadinessCheck {
  readonly id: 'artifacts' | 'plan' | 'validation' | 'coverage' | 'preview';
  readonly label: string;
  readonly state: CheckState;
  readonly detail: string;
}

export interface ReadinessInput {
  readonly artifacts: { readonly done: number; readonly total: number };
  /** `null` — схема не объявила отслеживаемый артефакт. */
  readonly plan: { readonly complete: number; readonly total: number } | null;
  /** Последняя валидация: число ошибок; `null` — не запускалась. */
  readonly validationErrors: number | null;
  /** `null` — трассировка ещё не загружена. */
  readonly coverage: { readonly covered: number; readonly total: number } | null;
  /** Исход предпросмотра архивации; `null` — не строился. */
  readonly preview: 'ready' | 'refused' | 'validation-failed' | null;
}

export interface Readiness {
  readonly checks: readonly ReadinessCheck[];
  readonly passed: number;
}

export function readiness(input: ReadinessInput): Readiness {
  const { artifacts, plan, validationErrors, coverage, preview } = input;
  const checks: ReadinessCheck[] = [
    {
      id: 'artifacts',
      label: 'Артефакты',
      state: artifacts.done >= artifacts.total ? 'ok' : 'fail',
      detail: `${artifacts.done}/${artifacts.total}`,
    },
    {
      id: 'plan',
      label: 'План',
      state: plan === null ? 'unknown' : plan.total > 0 && plan.complete >= plan.total ? 'ok' : 'fail',
      detail: plan === null ? 'не отслеживается' : plan.total === 0 ? 'нет пунктов' : `${plan.complete}/${plan.total}`,
    },
    {
      id: 'validation',
      label: 'Валидация',
      state: validationErrors === null ? 'unknown' : validationErrors === 0 ? 'ok' : 'fail',
      detail:
        validationErrors === null ? 'не проверялся' : validationErrors === 0 ? 'без ошибок' : `ошибок: ${validationErrors}`,
    },
    {
      id: 'coverage',
      label: 'Сценарии покрыты',
      state: coverage === null ? 'unknown' : coverage.covered >= coverage.total ? 'ok' : 'fail',
      detail: coverage === null ? '…' : coverage.total === 0 ? 'сценариев нет' : `${coverage.covered}/${coverage.total}`,
    },
    {
      id: 'preview',
      label: 'Архивация пройдёт',
      state: preview === null ? 'unknown' : preview === 'ready' ? 'ok' : 'fail',
      detail: preview === null ? 'не проверено' : preview === 'ready' ? 'по предпросмотру' : 'CLI отклонит',
    },
  ];
  return { checks, passed: checks.filter((check) => check.state === 'ok').length };
}
