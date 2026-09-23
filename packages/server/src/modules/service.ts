import {
  affectedConsumers,
  aggregateSummaries,
  capabilityModule,
  moduleOverlay,
  type ChangeSummary,
  type Consumer,
  type ModuleMetricsSummary,
  type ModuleOverlay,
  type WorkspaceTree,
} from '@openspec-ide/core';
import type { MetricsService } from '../metrics.js';
import type { WorkspaceReader } from '../workspace.js';
import { diffWithMap, discoverModules, type DiscoveredModule, type DiscoveryDiff } from './discovery.js';
import { ModuleMapStore, type ModuleInput, type ModuleMapView } from './mapStore.js';

/** Модули рабочего пространства: карта и принадлежность changes и спеков. */
export interface ModulesView {
  readonly map: ModuleMapView;
  readonly overlay: ModuleOverlay;
}

/** Что затрагивает change: его модули и потребители этих модулей. */
export interface ChangeImpact {
  readonly change: string;
  readonly modules: readonly string[];
  readonly consumers: readonly Consumer[];
  /** Capability дельт по модулям; ключ `''` — вне модулей. */
  readonly deltasByModule: Readonly<Record<string, readonly string[]>>;
}

export interface DiscoveryResult {
  readonly modules: readonly DiscoveredModule[];
  /** Расхождения с картой; `null` — карты ещё нет, весь черновик новый. */
  readonly diff: DiscoveryDiff | null;
}

export interface ModuleMetrics extends ModuleMetricsSummary {
  readonly rows: readonly (ChangeSummary & { readonly modules: readonly string[] })[];
}

export class ModuleService {
  readonly #root: string;
  readonly #workspace: WorkspaceReader;
  readonly #metrics: MetricsService | null;
  readonly store: ModuleMapStore;

  constructor(options: { root: string; workspace: WorkspaceReader; metrics: MetricsService | null }) {
    this.#root = options.root;
    this.#workspace = options.workspace;
    this.#metrics = options.metrics;
    this.store = new ModuleMapStore(options.root);
  }

  async view(tree?: WorkspaceTree): Promise<ModulesView> {
    const map = await this.store.read();
    const current = tree ?? (await this.#workspace.readTree()).tree;
    return { map, overlay: moduleOverlay(current, map.modules) };
  }

  async discover(): Promise<DiscoveryResult> {
    const [modules, map] = await Promise.all([discoverModules(this.#root), this.store.read()]);
    return { modules, diff: map.exists ? diffWithMap(modules, map.modules) : null };
  }

  save(modules: readonly ModuleInput[]): Promise<ModuleMapView> {
    return this.store.write(modules);
  }

  async impact(change: string): Promise<ChangeImpact> {
    const { tree } = await this.#workspace.readTree();
    const { map, overlay } = await this.view(tree);
    const modules = overlay.changes[change] ?? [];
    const node = tree.changes.find((entry) => entry.name === change);
    const deltasByModule: Record<string, string[]> = {};
    for (const capability of node?.deltaCapabilities ?? []) {
      const owner = capabilityModule(capability, map.modules) ?? '';
      (deltasByModule[owner] ??= []).push(capability);
    }
    return { change, modules, consumers: affectedConsumers(modules, map.modules), deltasByModule };
  }

  /** Сводка метрик по активным changes выбранных модулей. */
  async metrics(moduleIds: readonly string[]): Promise<ModuleMetrics> {
    if (this.#metrics === null) throw new Error('CLI OpenSpec недоступен');
    const { overlay } = await this.view();
    const exported = await this.#metrics.export();
    const rows = exported.changes.filter(
      (entry) =>
        !entry.archived &&
        (moduleIds.length === 0 || (overlay.changes[entry.change] ?? []).some((id) => moduleIds.includes(id))),
    );
    return {
      ...aggregateSummaries(rows.map((entry) => entry.summary)),
      rows: rows.map((entry) => ({ ...entry.summary, modules: overlay.changes[entry.change] ?? [] })),
    };
  }
}
