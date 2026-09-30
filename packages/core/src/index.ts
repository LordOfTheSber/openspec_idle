export const CORE_VERSION = '0.1.0';

export { API_REVISION, OPENSPEC_DIR, isStaleBackend } from './constants.js';

export {
  parseSpecMarkdown,
  type DeltaOperation,
  type ParsedRequirement,
  type ParsedScenario,
  type ParsedSpecDocument,
  type SpecProblem,
} from './specMarkdown.js';

export {
  buildCapabilityTree,
  buildWorkspaceTree,
  type ArtifactState,
  type TreeArtifact,
  type TreeCapability,
  type TreeChange,
  type TreeInput,
  type TreeSchema,
  type WorkspaceTree,
} from './workspaceTree.js';

export {
  SearchIndex,
  type SearchDocument,
  type SearchHit,
  type SearchKind,
  type SearchNames,
} from './search.js';

export {
  buildDeltaView,
  compareRequirement,
  sameHeader,
  similarNames,
  type DeltaGroup,
  type DeltaRequirement,
  type DeltaView,
  type DiffLine,
  type RequirementComparison,
} from './delta.js';

export {
  buildCapabilityMap,
  capabilitiesFor,
  changesFor,
  type CapabilityDelta,
  type CapabilityLink,
  type CapabilityMap,
  type CapabilityMapInput,
  type CapabilityNode,
} from './capabilityMap.js';

export {
  WORK_COLUMNS,
  buildBoard,
  mergeOrders,
  topologicalOrder,
  type Board,
  type BoardArtifact,
  type BoardCard,
  type BoardChange,
  type BoardColumn,
  type BoardSchema,
  type SchemaWaiverNote,
} from './board.js';

export {
  TrackedItemNotFoundError,
  isDoneMarker,
  parseTrackedDocument,
  toggleTrackedItem,
  type TrackedDocument,
  type TrackedGroup,
  type TrackedItem,
} from './trackedItems.js';

export { splitAcceptance, type AcceptanceSplit } from './acceptance.js';

export {
  METRICS_SCHEMA_VERSION,
  RENUMBER_SIMILARITY_THRESHOLD,
  applyEvent,
  emptyState,
  foldEvents,
  itemMetrics,
  reconcile,
  removedKey,
  sortByTokens,
  summarize,
  textSimilarity,
  type ChangeRecord,
  type ChangeSummary,
  type CurrentItem,
  type ItemMetrics,
  type ItemRecord,
  type ItemState,
  type MetricEvent,
  type MetricsExport,
  type MetricsState,
  type RunOutcome,
  type RunRecord,
} from './metrics.js';

export {
  WAIVERS_KEY,
  addArtifact,
  dependentsOf,
  emptySchema,
  removeArtifact,
  removeWaiver,
  schemaFromPlain,
  schemaToPlain,
  setWaiver,
  updateApply,
  updateArtifact,
  type ArtifactPatch,
  type SchemaArtifactDoc,
  type SchemaDocument,
  type SchemaParse,
  type SchemaWaiver,
} from './schemaDocument.js';

export {
  SDD_RULES,
  checkConformance,
  isContract,
  reachableArtifacts,
  transitiveDependencies,
  type ConformanceReport,
  type RuleLevel,
  type SchemaField,
  type SddRule,
  type Violation,
} from './sdd.js';

export { previewSchema, type SchemaPreview } from './schemaPreview.js';

export {
  API_METHODS,
  PANEL_SECTIONS,
  isPanelApiPath,
  parseHostMessage,
  parseViewMessage,
  type ApiMethod,
  type HostEvent,
  type HostMessage,
  type PanelSection,
  type PanelSelection,
  type Parsed,
  type ViewMessage,
} from './hostProtocol.js';

export {
  MAX_DIFF_CELLS,
  diffText,
  splitLines,
  type TextDiff,
  type TextDiffHunk,
  type TextDiffLine,
} from './textDiff.js';

export {
  describeSpecChange,
  normalizeRequirementName,
  renamePairs,
  requirementBlocks,
  type RemovedRequirement,
  type RenamePair,
  type RequirementBlock,
  type RequirementChange,
  type RequirementChangeKind,
  type SpecChange,
} from './specChange.js';

export {
  DEFAULT_STRUCTURE_IGNORE,
  STRUCTURE_FILE,
  checkStructure,
  matchesName,
  parseStructureSpec,
  topLevelDirs,
  type DirEntry,
  type LineOf,
  type ReadDir,
  type StructureCheck,
  type StructureEntry,
  type StructureIssue,
  type StructureIssueKind,
  type StructureNode,
  type StructureNodeState,
  type StructureRule,
  type StructureSpec,
  type StructureSpecError,
  type StructureSpecResult,
} from './structure.js';

export {
  ADR_DIR,
  CONTEXT_DIR,
  MODULES_DIR,
  MODULE_CONTEXT_FILE,
  MODULE_INDEX_FILE,
  SPECS_DIR,
  buildContextMap,
  contextBundle,
  firstHeading,
  modulePath,
  normalizeDomain,
  specPathOf,
  splitFrontmatter,
  type AdrLink,
  type AdrSource,
  type CodePath,
  type ContextAdr,
  type ContextBundle,
  type ContextBundleOptions,
  type ContextSelection,
  type ContextDomain,
  type ContextIssue,
  type ContextIssueKind,
  type ContextMap,
  type ContextMapInput,
  type ContextModule,
  type Frontmatter,
  type KeyLine,
  type ModuleDependency,
  type ModuleDomainLink,
  type ModuleSource,
} from './contextMap.js';

export {
  MIN_INFERRED_NAME,
  appendPlanItem,
  buildTrace,
  normalizeTraceName,
  planReferences,
  scenarioKey,
  splitReference,
  traceScenarios,
  type AppendedPlanItem,
  type Trace,
  type TraceLink,
  type TracePlanItem,
  type TraceReference,
  type TraceScenario,
} from './trace.js';

export {
  authoringIssues,
  codeActions,
  codeLenses,
  completions,
  copyRequirementEdit,
  definition,
  documentKind,
  hover,
  planSymbols,
  scanDelta,
  withDocumentText,
  workspaceSymbols,
  type AuthoringAction,
  type AuthoringChange,
  type AuthoringCompletion,
  type AuthoringDelta,
  type AuthoringDocument,
  type AuthoringEdit,
  type AuthoringIssue,
  type AuthoringLens,
  type AuthoringLensAction,
  type AuthoringLocation,
  type AuthoringRange,
  type AuthoringSources,
  type AuthoringSpec,
  type AuthoringSymbol,
  type DeltaMention,
  type WorkspaceSymbolEntry,
} from './authoring.js';

export {
  FORGOTTEN_AFTER_DAYS,
  archiveOrder,
  archivedSince,
  archivedTouches,
  buildDriftReport,
  compareBaseline,
  driftFindings,
  findOverlaps,
  forgottenDays,
  requirementTouches,
  staleMessage,
  type ArchivedTouch,
  type DriftFinding,
  type ChangeDrift,
  type ChangeOverlap,
  type DeltaBaseline,
  type DriftChangeInput,
  type DriftInput,
  type DriftReport,
  type Overlap,
  type RequirementDrift,
  type RequirementTouch,
  type StaleRequirement,
} from './drift.js';
