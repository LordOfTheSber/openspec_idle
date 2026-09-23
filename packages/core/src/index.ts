export const CORE_VERSION = '0.1.0';

export { OPENSPEC_DIR } from './constants.js';

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
