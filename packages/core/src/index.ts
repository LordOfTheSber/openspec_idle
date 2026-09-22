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
