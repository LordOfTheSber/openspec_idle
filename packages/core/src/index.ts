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
  NdjsonSplitter,
  classifyOutcome,
  emptyTally,
  parseAgentJsonOutput,
  parseAgentLine,
  parseAgentMessage,
  tallyMessage,
  type AgentEvent,
  type AgentUsage,
  type ParsedMessage,
  type RunEnding,
  type RunTally,
} from './agentStream.js';

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
