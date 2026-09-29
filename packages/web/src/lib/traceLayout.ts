/**
 * Раскладка вкладки «Трассировка»: сценарии слева группами по требованиям,
 * пункты плана — напротив своих сценариев, пробелы — на уровне непокрытого
 * сценария. Координаты — в долях ширины и пикселях высоты, линии рисует SVG.
 */
import type { Trace, TracePlanItem, TraceScenario } from '@openspec-ide/core';

export const GROUP_HEIGHT = 26;
export const SCENARIO_HEIGHT = 40;
export const SCENARIO_GAP = 8;
export const SLOT_HEIGHT = 56;
export const SLOT_GAP = 12;
const GROUP_GAP = 10;
const TOP = 30;

export interface TraceGroupBox {
  readonly key: string;
  readonly capability: string;
  readonly requirement: string;
  readonly y: number;
}

export interface TraceScenarioBox {
  readonly scenario: TraceScenario;
  readonly y: number;
  readonly covered: boolean;
}

/** Место в средней колонке: пункт плана или пробел под непокрытый сценарий. */
export type TraceSlot =
  | { readonly kind: 'item'; readonly item: TracePlanItem; readonly y: number }
  | { readonly kind: 'gap'; readonly scenario: TraceScenario; readonly y: number };

export interface TraceEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: 'explicit' | 'inferred' | 'gap';
  readonly scenario: string;
}

export interface TraceLayout {
  readonly groups: readonly TraceGroupBox[];
  readonly scenarios: readonly TraceScenarioBox[];
  readonly slots: readonly TraceSlot[];
  readonly edges: readonly TraceEdge[];
  readonly height: number;
}

/** Раскладывает трассировку; `gapsOnly` оставляет только непокрытые сценарии. */
export function layoutTrace(trace: Trace, gapsOnly = false): TraceLayout {
  const covered = new Set(trace.covered);
  const shown = trace.scenarios.filter((scenario) => !gapsOnly || !covered.has(scenario.key));

  const groups: TraceGroupBox[] = [];
  const scenarios: TraceScenarioBox[] = [];
  let y = TOP;
  let previous: string | null = null;
  for (const scenario of shown) {
    const key = `${scenario.capability}/${scenario.requirement}`;
    if (key !== previous) {
      if (previous !== null) y += GROUP_GAP;
      groups.push({ key, capability: scenario.capability, requirement: scenario.requirement, y });
      y += GROUP_HEIGHT;
      previous = key;
    }
    scenarios.push({ scenario, y, covered: covered.has(scenario.key) });
    y += SCENARIO_HEIGHT + SCENARIO_GAP;
  }
  const scenarioBottom = y;

  const center = (key: string): number | null => {
    const box = scenarios.find((entry) => entry.scenario.key === key);
    return box === undefined ? null : box.y + SCENARIO_HEIGHT / 2;
  };

  // Желаемая высота места — средняя по связанным сценариям.
  type Pending =
    | { readonly kind: 'item'; readonly item: TracePlanItem }
    | { readonly kind: 'gap'; readonly scenario: TraceScenario };
  const wanted: { slot: Pending; desired: number; order: number }[] = [];
  if (!gapsOnly) {
    trace.items.forEach((item, order) => {
      const centers = trace.links
        .filter((link) => link.item === item.line)
        .map((link) => center(link.scenario))
        .filter((value): value is number => value !== null);
      if (centers.length === 0) {
        wanted.push({ slot: { kind: 'item', item }, desired: Number.POSITIVE_INFINITY, order });
      } else {
        const mean = centers.reduce((sum, value) => sum + value, 0) / centers.length;
        wanted.push({ slot: { kind: 'item', item }, desired: mean - SLOT_HEIGHT / 2, order });
      }
    });
  }
  for (const box of scenarios) {
    if (box.covered) continue;
    wanted.push({
      slot: { kind: 'gap', scenario: box.scenario },
      desired: box.y + SCENARIO_HEIGHT / 2 - SLOT_HEIGHT / 2,
      order: Number.MAX_SAFE_INTEGER,
    });
  }
  wanted.sort((a, b) => a.desired - b.desired || a.order - b.order);

  const slots: TraceSlot[] = [];
  let bottom = TOP - SLOT_GAP;
  for (const entry of wanted) {
    const desired = Number.isFinite(entry.desired) ? entry.desired : bottom + SLOT_GAP;
    const at = Math.max(TOP, desired, bottom + SLOT_GAP);
    slots.push({ ...entry.slot, y: at });
    bottom = at + SLOT_HEIGHT;
  }

  const edges: TraceEdge[] = [];
  for (const slot of slots) {
    const to = slot.y + SLOT_HEIGHT / 2;
    if (slot.kind === 'gap') {
      const from = center(slot.scenario.key);
      if (from !== null) edges.push({ from, to, kind: 'gap', scenario: slot.scenario.key });
      continue;
    }
    for (const link of trace.links.filter((entry) => entry.item === slot.item.line)) {
      const from = center(link.scenario);
      if (from !== null) edges.push({ from, to, kind: link.kind, scenario: link.scenario });
    }
  }

  return { groups, scenarios, slots, edges, height: Math.max(scenarioBottom, bottom) + 8 };
}

/** Шаг сценария «- **WHEN** текст» → метка и текст. */
export function parseStep(step: string): { label: string; text: string } {
  const match = /^\s*[-*]?\s*\*\*(WHEN|THEN|AND|GIVEN|BUT)\*\*\s*(.*)$/i.exec(step);
  if (match === null) return { label: '', text: step.replace(/^\s*[-*]\s*/, '') };
  const label = (match[1] ?? '').toUpperCase();
  const russian: Record<string, string> = { WHEN: 'КОГДА', THEN: 'ТОГДА', AND: 'И', GIVEN: 'ДАНО', BUT: 'НО' };
  return { label: russian[label] ?? label, text: match[2] ?? '' };
}

/** Задача для агента по непокрытому сценарию — с путями `@файл`. */
export function agentTask(change: string, scenario: TraceScenario, planPath: string | null): string {
  const steps = scenario.steps.map((step) => {
    const parsed = parseStep(step);
    return parsed.label === '' ? `- ${parsed.text}` : `- ${parsed.label}: ${parsed.text}`;
  });
  return [
    `Сценарий без пункта плана в change «${change}».`,
    `Спек ${scenario.capability}, требование «${scenario.requirement}», сценарий «${scenario.name}»:`,
    ...steps,
    '',
    'Добавь пункт в план со способом проверки и реализуй поведение. Под пунктом укажи ссылку на сценарий:',
    `  ↳ ${scenario.capability} / ${scenario.name}`,
    '',
    `@openspec/changes/${change}/specs/${scenario.capability}/spec.md`,
    ...(planPath === null ? [] : [`@${planPath}`]),
  ].join('\n');
}
