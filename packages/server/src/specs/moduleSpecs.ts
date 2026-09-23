import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENSPEC_DIR,
  buildSections,
  capabilityModule,
  checkModuleSpec,
  coverageState,
  findByAnchor,
  normalizeScenarioName,
  parseSpecLinks,
  parseSpecMarkdown,
  requirementAnchor,
  sameRequirement,
  splitSections,
  type CoverageState,
  type DeltaOperation,
  type ModuleDef,
  type ModuleSpecWarning,
  type ParsedScenario,
  type SectionNode,
  type WorkspaceTree,
} from '@openspec-ide/core';
import type { ModuleService } from '../modules/service.js';
import type { WorkspaceReader } from '../workspace.js';
import { DeltaArchive, renamedTo, requirementHistory, type DeltaEntry, type HistoryEntry } from './archive.js';
import type { CodeIndex, IndexedFile } from './codeIndex.js';

/** Признак активного change у требования. */
export interface RequirementChange {
  readonly change: string;
  readonly operation: DeltaOperation;
  readonly renamedTo: string | null;
}

/** Требование спеки модуля в том виде, в каком его показывает IDE. */
export interface RequirementView {
  readonly name: string;
  readonly short: string;
  readonly sections: readonly string[];
  readonly anchor: string;
  readonly line: number;
  readonly description: string;
  readonly scenarios: readonly ParsedScenario[];
  readonly changes: readonly RequirementChange[];
  /** Требование предлагается дельтой ADDED активного change — в основной спеке его нет. */
  readonly proposedBy: string | null;
  readonly outgoing: number;
  readonly incoming: number;
}

export interface ModuleSpecView {
  readonly capability: string;
  readonly file: string;
  readonly module: ModuleDef | null;
  readonly purpose: string | null;
  readonly sections: readonly SectionNode<RequirementView>[];
  readonly counts: { readonly sections: number; readonly requirements: number; readonly scenarios: number };
  readonly warnings: readonly ModuleSpecWarning[];
  /** Активные changes модуля (или capability, если модуля нет). */
  readonly activeChanges: readonly string[];
  readonly links: { readonly outgoing: number; readonly incoming: number };
}

/** Ссылка из требования на требование или спеку. */
export interface ResolvedLink {
  readonly fromCapability: string;
  readonly fromRequirement: string | null;
  readonly fromModule: string | null;
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly href: string;
  readonly toCapability: string;
  readonly toModule: string | null;
  readonly toRequirement: string | null;
  readonly anchor: string | null;
  /** Ссылка из дельты активного change — `null` у основной спеки. */
  readonly change: string | null;
  readonly status: 'ok' | 'missing-spec' | 'missing-requirement' | 'changing';
  /** Для переименованного требования — новое имя. */
  readonly suggestion: string | null;
  /** Требование цели удаляется или переименовывается в активном change. */
  readonly changing: RequirementChange | null;
}

/** Связь двух модулей по ссылкам требований. */
export interface ModuleLinkEdge {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  /** Связи нет в карте зависимостей. */
  readonly mismatch: boolean;
}

export interface LinkGraph {
  readonly links: readonly ResolvedLink[];
  readonly edges: readonly ModuleLinkEdge[];
  /** Зависимости карты без единой ссылки требований — контракт не зафиксирован. */
  readonly undocumented: readonly { readonly from: string; readonly to: string }[];
}

/** Место метки или теста в коде. */
export interface CodePlace {
  readonly path: string;
  readonly line: number;
  /** Модуль, которому принадлежит файл. */
  readonly module: string | null;
  readonly kind: 'code' | 'test' | 'usage' | 'probable';
  /** Для вероятного покрытия — сценарий, совпавший по имени. */
  readonly scenario?: string;
}

export interface RequirementTrace {
  readonly requirement: string;
  readonly state: CoverageState;
  readonly code: readonly CodePlace[];
  readonly tests: readonly CodePlace[];
  readonly usages: readonly CodePlace[];
  readonly probable: readonly CodePlace[];
}

export interface CoverageView {
  readonly capability: string;
  readonly index: CodeIndex['status'];
  readonly requirements: readonly RequirementTrace[];
  readonly summary: Readonly<Record<CoverageState, number>>;
}

/** Метка, не разрешающаяся до требования. */
export interface BrokenTag {
  readonly path: string;
  readonly line: number;
  readonly module: string;
  readonly requirement: string;
  readonly reason: 'unknown-module' | 'unknown-requirement';
  readonly suggestion: string | null;
}

/** Что change затрагивает в ссылках и метках. */
export interface ChangeTraces {
  readonly change: string;
  /** Требования других модулей, ссылающиеся на изменяемые или удаляемые. */
  readonly affectedLinks: readonly ResolvedLink[];
  /** Битые ссылки в дельтах этого change. */
  readonly brokenLinks: readonly ResolvedLink[];
  /** Метки, которые придётся обновить после переименования требований. */
  readonly tagsToUpdate: readonly (CodePlace & { readonly from: string; readonly to: string })[];
}

interface SpecFile {
  readonly capability: string;
  readonly file: string;
  readonly text: string;
  readonly names: readonly string[];
}

/**
 * Спеки модулей: структура большой спеки, признаки активных changes, история
 * по архиву, ссылки между требованиями и связь с кодом через индекс меток.
 */
export class ModuleSpecService {
  readonly #root: string;
  readonly #workspace: WorkspaceReader;
  readonly #modules: ModuleService;
  readonly #index: CodeIndex;
  readonly #archive: DeltaArchive;

  constructor(options: { root: string; workspace: WorkspaceReader; modules: ModuleService; index: CodeIndex }) {
    this.#root = options.root;
    this.#workspace = options.workspace;
    this.#modules = options.modules;
    this.#index = options.index;
    this.#archive = new DeltaArchive(options.root);
  }

  /** Запускает индексацию кода по текущей карте модулей. */
  async refreshIndex(): Promise<void> {
    const map = await this.#modules.store.read();
    void this.#index.configure(map.modules, map.testPatterns);
  }

  async spec(capability: string): Promise<ModuleSpecView | null> {
    const { tree } = await this.#workspace.readTree();
    const file = specPath(capability);
    const text = await this.#read(file);
    if (text === null) return null;
    const [{ map, overlay }, active, graph] = await Promise.all([
      this.#modules.view(tree),
      this.#activeDeltas(tree),
      this.links(tree),
    ]);
    const parsed = parseSpecMarkdown(text);
    const mine = active.filter((entry) => entry.capability === capability);

    const views: RequirementView[] = parsed.requirements.map((requirement) => ({
      ...describe(requirement.name),
      line: requirement.line,
      description: requirement.description,
      scenarios: requirement.scenarios,
      changes: mine
        .filter(
          (entry) =>
            entry.operation !== 'ADDED' &&
            sameRequirement(entry.operation === 'RENAMED' ? (entry.renamedFrom ?? '') : entry.name, requirement.name),
        )
        .map((entry) => ({ change: entry.change, operation: entry.operation, renamedTo: entry.renamedTo })),
      proposedBy: null,
      outgoing: graph.links.filter((link) => link.fromCapability === capability && link.change === null && link.fromRequirement !== null && sameRequirement(link.fromRequirement, requirement.name)).length,
      incoming: graph.links.filter((link) => link.toCapability === capability && link.toRequirement !== null && sameRequirement(link.toRequirement, requirement.name)).length,
    }));
    // Требования, которые активные changes добавляют, — в своём разделе как предлагаемые.
    for (const entry of mine.filter((item) => item.operation === 'ADDED')) {
      if (views.some((view) => sameRequirement(view.name, entry.name))) continue;
      const delta = parseSpecMarkdown(await this.#read(entry.file) ?? '').requirements.find((item) => sameRequirement(item.name, entry.name));
      views.push({
        ...describe(entry.name),
        line: entry.line,
        description: delta?.description ?? '',
        scenarios: delta?.scenarios ?? [],
        changes: [{ change: entry.change, operation: 'ADDED', renamedTo: null }],
        proposedBy: entry.change,
        outgoing: 0,
        incoming: 0,
      });
    }

    const sections = buildSections(views);
    const moduleId = capabilityModule(capability, map.modules);
    const module = map.modules.find((entry) => entry.id === moduleId) ?? null;
    const activeChanges =
      moduleId === null
        ? tree.changes.filter((change) => change.deltaCapabilities.includes(capability)).map((change) => change.name)
        : Object.entries(overlay.changes).filter(([, ids]) => ids.includes(moduleId)).map(([change]) => change);
    const countSections = (nodes: readonly SectionNode<RequirementView>[]): number =>
      nodes.reduce((sum, node) => sum + 1 + countSections(node.children), 0);

    return {
      capability,
      file,
      module,
      purpose: parsed.purpose,
      sections,
      counts: {
        sections: countSections(sections),
        requirements: parsed.requirements.length,
        scenarios: parsed.requirements.reduce((sum, requirement) => sum + requirement.scenarios.length, 0),
      },
      warnings: checkModuleSpec(text),
      activeChanges,
      links: {
        outgoing: graph.links.filter((link) => link.fromCapability === capability && link.change === null).length,
        incoming: graph.links.filter((link) => link.toCapability === capability).length,
      },
    };
  }

  async history(capability: string, requirement: string): Promise<HistoryEntry[]> {
    return requirementHistory(await this.#archive.archived(), capability, requirement);
  }

  /** Все ссылки между требованиями и связи модулей, выведенные из них. */
  async links(tree?: WorkspaceTree): Promise<LinkGraph> {
    const current = tree ?? (await this.#workspace.readTree()).tree;
    const [{ map }, specs, active, archived] = await Promise.all([
      this.#modules.view(current),
      this.#specs(current),
      this.#activeDeltas(current),
      this.#archive.archived(),
    ]);
    const byCapability = new Map(specs.map((spec) => [spec.capability, spec]));
    const moduleOf = (capability: string): string | null => capabilityModule(capability, map.modules);

    const resolve = (
      source: { capability: string; file: string; text: string; change: string | null },
    ): ResolvedLink[] => {
      const requirements = parseSpecMarkdown(source.text).requirements;
      return parseSpecLinks(source.text, source.capability).map((link) => {
        const owner = [...requirements].reverse().find((requirement) => requirement.line <= link.line) ?? null;
        const target = byCapability.get(link.capability);
        let toRequirement: string | null = null;
        let status: ResolvedLink['status'] = 'ok';
        let suggestion: string | null = null;
        let changing: RequirementChange | null = null;
        if (target === undefined) {
          status = 'missing-spec';
        } else if (link.anchor !== null) {
          toRequirement = findByAnchor(link.anchor, target.names);
          if (toRequirement === null) {
            status = 'missing-requirement';
            // Якорь прежнего имени: имя восстанавливается по переименованиям архива.
            const old = archived.find(
              (entry) =>
                entry.operation === 'RENAMED' &&
                entry.capability === link.capability &&
                entry.renamedFrom !== null &&
                requirementAnchor(entry.renamedFrom) === link.anchor!.toLowerCase(),
            );
            if (old?.renamedFrom !== undefined && old.renamedFrom !== null) {
              suggestion = renamedTo(archived, link.capability, old.renamedFrom);
            }
          } else {
            const pending = active.find(
              (entry) =>
                entry.capability === link.capability &&
                (entry.operation === 'REMOVED' || entry.operation === 'RENAMED') &&
                sameRequirement(entry.operation === 'RENAMED' ? (entry.renamedFrom ?? '') : entry.name, toRequirement!),
            );
            if (pending !== undefined) {
              status = 'changing';
              changing = { change: pending.change, operation: pending.operation, renamedTo: pending.renamedTo };
              suggestion = pending.renamedTo;
            }
          }
        }
        return {
          fromCapability: source.capability,
          fromRequirement: owner?.name ?? null,
          fromModule: moduleOf(source.capability),
          file: source.file,
          line: link.line,
          label: link.label,
          href: link.href,
          toCapability: link.capability,
          toModule: moduleOf(link.capability),
          toRequirement,
          anchor: link.anchor,
          change: source.change,
          status,
          suggestion,
          changing,
        };
      });
    };

    const links: ResolvedLink[] = [];
    for (const spec of specs) links.push(...resolve({ ...spec, change: null }));
    const deltaFiles = new Map<string, { capability: string; change: string }>();
    for (const entry of active) deltaFiles.set(entry.file, { capability: entry.capability, change: entry.change });
    for (const [file, { capability, change }] of deltaFiles) {
      const text = await this.#read(file);
      if (text !== null) links.push(...resolve({ capability, file, text, change }));
    }

    // Связи модулей — по ссылкам основных спек между разными модулями.
    const counts = new Map<string, number>();
    for (const link of links) {
      if (link.change !== null || link.fromModule === null || link.toModule === null || link.fromModule === link.toModule) continue;
      const key = `${link.fromModule}\u0000${link.toModule}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const edges: ModuleLinkEdge[] = [...counts].map(([key, count]) => {
      const [from, to] = key.split('\u0000') as [string, string];
      const module = map.modules.find((entry) => entry.id === from);
      return { from, to, count, mismatch: module !== undefined && !module.dependsOn.includes(to) };
    });
    const undocumented = map.modules.flatMap((module) =>
      module.dependsOn.filter((to) => !counts.has(`${module.id}\u0000${to}`)).map((to) => ({ from: module.id, to })),
    );
    return { links, edges, undocumented };
  }

  /** Покрытие требований спеки кодом и тестами. */
  async coverage(capability: string): Promise<CoverageView> {
    await this.refreshIndex();
    const { tree } = await this.#workspace.readTree();
    const { map } = await this.#modules.view(tree);
    const text = (await this.#read(specPath(capability))) ?? '';
    const requirements = parseSpecMarkdown(text).requirements;
    const owner = capabilityModule(capability, map.modules);
    const specsOfOwner = (await this.#specs(tree)).filter((spec) => capabilityModule(spec.capability, map.modules) === owner);

    const places = new Map<string, { code: CodePlace[]; tests: CodePlace[]; usages: CodePlace[]; probable: CodePlace[] }>();
    for (const requirement of requirements) places.set(requirement.name, { code: [], tests: [], usages: [], probable: [] });

    for (const [path, entry] of this.#index.files) {
      const fileModule = this.#index.ownerOf(path)?.id ?? null;
      for (const tag of entry.tags) {
        if (!this.#tagTargets(tag.module, capability, owner, specsOfOwner)) continue;
        const requirement = requirements.find((item) => sameRequirement(item.name, tag.requirement));
        if (requirement === undefined) continue;
        const bucket = places.get(requirement.name)!;
        if (entry.test) bucket.tests.push({ path, line: tag.line, module: fileModule, kind: 'test' });
        else if (owner !== null && fileModule !== null && fileModule !== owner) {
          bucket.usages.push({ path, line: tag.line, module: fileModule, kind: 'usage' });
        } else bucket.code.push({ path, line: tag.line, module: fileModule, kind: 'code' });
      }
      // Вероятное покрытие — только тесты модуля-владельца спеки.
      if (!entry.test || (owner !== null && fileModule !== owner)) continue;
      addProbable(path, entry, fileModule, requirements, places);
    }

    const traces: RequirementTrace[] = requirements.map((requirement) => {
      const bucket = places.get(requirement.name)!;
      return {
        requirement: requirement.name,
        state: coverageState({ code: bucket.code.length, tests: bucket.tests.length, probable: bucket.probable.length }),
        ...bucket,
      };
    });
    const summary: Record<CoverageState, number> = { full: 0, code: 0, tests: 0, probable: 0, none: 0 };
    for (const trace of traces) summary[trace.state] += 1;
    return { capability, index: this.#index.status, requirements: traces, summary };
  }

  /** Метки, которые не разрешаются до требования. */
  async brokenTags(): Promise<BrokenTag[]> {
    await this.refreshIndex();
    const { tree } = await this.#workspace.readTree();
    const [{ map }, specs, archived] = await Promise.all([this.#modules.view(tree), this.#specs(tree), this.#archive.archived()]);
    const broken: BrokenTag[] = [];
    for (const [path, entry] of this.#index.files) {
      for (const tag of entry.tags) {
        const targets = this.#tagSpecs(tag.module, map.modules, specs);
        if (targets === null) {
          broken.push({ path, line: tag.line, module: tag.module, requirement: tag.requirement, reason: 'unknown-module', suggestion: null });
          continue;
        }
        if (targets.some((spec) => spec.names.some((name) => sameRequirement(name, tag.requirement)))) continue;
        const suggestion =
          targets.map((spec) => renamedTo(archived, spec.capability, tag.requirement)).find((name) => name !== null) ?? null;
        broken.push({ path, line: tag.line, module: tag.module, requirement: tag.requirement, reason: 'unknown-requirement', suggestion });
      }
    }
    return broken;
  }

  /** Ссылки и метки, которые затрагивает активный change. */
  async changeTraces(change: string): Promise<ChangeTraces> {
    const { tree } = await this.#workspace.readTree();
    const [graph, deltas, { map }] = await Promise.all([this.links(tree), this.#archive.active(change), this.#modules.view(tree)]);
    const touched = deltas.filter((entry) => entry.operation === 'MODIFIED' || entry.operation === 'REMOVED' || entry.operation === 'RENAMED');
    const affectedLinks = graph.links.filter(
      (link) =>
        link.change === null &&
        link.toRequirement !== null &&
        link.fromModule !== link.toModule &&
        touched.some(
          (entry) =>
            entry.capability === link.toCapability &&
            sameRequirement(entry.operation === 'RENAMED' ? (entry.renamedFrom ?? '') : entry.name, link.toRequirement!),
        ),
    );
    const brokenLinks = graph.links.filter((link) => link.change === change && link.status !== 'ok');

    await this.refreshIndex();
    const tagsToUpdate: (CodePlace & { from: string; to: string })[] = [];
    for (const entry of deltas.filter((item) => item.operation === 'RENAMED' && item.renamedFrom !== null)) {
      const owner = capabilityModule(entry.capability, map.modules);
      for (const [path, file] of this.#index.files) {
        for (const tag of file.tags) {
          if (tag.module !== owner && tag.module !== entry.capability) continue;
          if (!sameRequirement(tag.requirement, entry.renamedFrom!)) continue;
          tagsToUpdate.push({
            path,
            line: tag.line,
            module: this.#index.ownerOf(path)?.id ?? null,
            kind: file.test ? 'test' : 'code',
            from: entry.renamedFrom!,
            to: entry.renamedTo ?? entry.name,
          });
        }
      }
    }
    return { change, affectedLinks, brokenLinks, tagsToUpdate };
  }

  /** Фрагмент файла вокруг строки — только для чтения. */
  async snippet(path: string, line: number, context = 6): Promise<{ path: string; start: number; line: number; lines: string[] }> {
    const text = await readFile(join(this.#root, path), 'utf8');
    const lines = text.split('\n');
    const start = Math.max(1, line - context);
    const end = Math.min(lines.length, line + context);
    return { path, start, line, lines: lines.slice(start - 1, end) };
  }

  /** Все требования всех спек — для вставки ссылки. */
  async requirementIndex(): Promise<{ capability: string; module: string | null; name: string; anchor: string }[]> {
    const { tree } = await this.#workspace.readTree();
    const [{ map }, specs] = await Promise.all([this.#modules.view(tree), this.#specs(tree)]);
    return specs.flatMap((spec) =>
      spec.names.map((name) => ({
        capability: spec.capability,
        module: capabilityModule(spec.capability, map.modules),
        name,
        anchor: requirementAnchor(name),
      })),
    );
  }

  /** Метка указывает на эту спеку: по id модуля-владельца или по пути capability. */
  #tagTargets(tagModule: string, capability: string, owner: string | null, specsOfOwner: readonly SpecFile[]): boolean {
    if (tagModule === capability) return true;
    return owner !== null && tagModule === owner && specsOfOwner.some((spec) => spec.capability === capability);
  }

  #tagSpecs(tagModule: string, modules: readonly ModuleDef[], specs: readonly SpecFile[]): SpecFile[] | null {
    const direct = specs.filter((spec) => spec.capability === tagModule);
    if (direct.length > 0) return direct;
    if (!modules.some((module) => module.id === tagModule)) return null;
    return specs.filter((spec) => capabilityModule(spec.capability, modules) === tagModule);
  }

  async #specs(tree: WorkspaceTree): Promise<SpecFile[]> {
    const capabilities: string[] = [];
    const walk = (nodes: WorkspaceTree['capabilities']): void => {
      for (const node of nodes) {
        if (node.isSpec) capabilities.push(node.path);
        walk(node.children);
      }
    };
    walk(tree.capabilities);
    const specs: SpecFile[] = [];
    for (const capability of capabilities) {
      const file = specPath(capability);
      const text = await this.#read(file);
      if (text === null) continue;
      specs.push({ capability, file, text, names: parseSpecMarkdown(text).requirements.map((item) => item.name) });
    }
    return specs;
  }

  async #activeDeltas(tree: WorkspaceTree): Promise<DeltaEntry[]> {
    const entries = await Promise.all(tree.changes.map((change) => this.#archive.active(change.name)));
    return entries.flat();
  }

  async #read(relative: string): Promise<string | null> {
    try {
      return await readFile(join(this.#root, relative), 'utf8');
    } catch {
      return null;
    }
  }
}

function specPath(capability: string): string {
  return `${OPENSPEC_DIR}/specs/${capability}/spec.md`;
}

function describe(name: string): { name: string; short: string; sections: readonly string[]; anchor: string } {
  const { sections, short } = splitSections(name);
  return { name, short, sections, anchor: requirementAnchor(name) };
}

function addProbable(
  path: string,
  entry: IndexedFile,
  module: string | null,
  requirements: readonly { name: string; scenarios: readonly ParsedScenario[] }[],
  places: Map<string, { probable: CodePlace[] }>,
): void {
  for (const requirement of requirements) {
    for (const scenario of requirement.scenarios) {
      const wanted = normalizeScenarioName(scenario.name);
      const mention = entry.mentions.find((item) => item.text === wanted);
      if (mention !== undefined) {
        places.get(requirement.name)!.probable.push({ path, line: mention.line, module, kind: 'probable', scenario: scenario.name });
      }
    }
  }
}
