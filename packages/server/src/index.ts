export const SERVER_VERSION = '0.1.0';

export {
  canonicalize,
  isInsideRoot,
  resolveOpenspecRoot,
  type RootResolution,
} from './fs/workspace.js';

export {
  LOOPBACK_HOST,
  PortInUseError,
  createApp,
  startServer,
  type AppParts,
  type RunningServer,
  type ServerOptions,
} from './server.js';
export {
  createEmbeddedBackend,
  type ApiReply,
  type EmbeddedBackend,
  type EmbeddedBackendOptions,
} from './embedded.js';

export { runCli, runCliJson, type CliFailure, type CliResult, type CliRunOptions } from './openspec/exec.js';
export { OpenspecClient, type OpenspecClientOptions } from './openspec/client.js';
export { CLI_ENV, CLI_SETTING, locateOpenspecCli, missingCliNotice, type CliLocation, type CliSource } from './openspec/locate.js';
export type {
  ArtifactInstructions,
  ChangeStatus,
  ChangeSummary,
  ListChanges,
  ListSpecs,
  SchemaListEntry,
  SchemaWhich,
  SpecSummary,
  TemplatesMap,
  ValidateResult,
  ValidationIssue,
  ValidationItem,
} from './openspec/schemas.js';

export { EventBus, encodeSse, type IdeEvent } from './events.js';
export { SESSION_HEADER, SESSION_QUERY, SessionToken } from './http/session.js';
export { OutsideWorkspaceError, resolveInsideWorkspace } from './http/paths.js';
export { injectToken, placeholderPage, readBuiltPage } from './http/page.js';
export { WorkspaceWatcher, type FileChangeBatch } from './watcher.js';
export { WorkspaceReader } from './workspace.js';
export {
  StructureExistsError,
  StructureService,
  parseStructureYaml,
  watchedStructureDirs,
  type StructureReport,
} from './structure.js';
export {
  ArchivePreviewService,
  PREVIEW_DIR_PREFIX,
  UnknownChangeError,
  type ArchiveOutcome,
  type ArchivePreview,
  type ArchiveProblem,
  type SpecPreview,
} from './archivePreview.js';
export {
  CONFIG_FILE,
  IDE_DIR,
  SECRET_FIELDS,
  SecretInConfigError,
  loadConfig,
  rejectSecrets,
  saveConfig,
  type ConfigLoad,
  type IdeConfig,
} from './config.js';

export {
  ArtifactCreationError,
  SNIPPETS,
  createArtifact,
  resolveArtifactPath,
  type CreateArtifactRequest,
  type CreatedArtifact,
} from './artifacts.js';
export {
  StaleWriteError,
  WriteFailedError,
  contentVersion,
  readArtifactFile,
  saveArtifactFile,
  type ArtifactFile,
  type FileSystemOps,
} from './files.js';
export {
  ValidationRunner,
  type ValidationEntry,
  type ValidationRun,
} from './validation.js';

export {
  DeltaReader,
  capabilityFromPath,
  type ChangeDeltas,
  type SpecView,
} from './deltas.js';

export {
  BoardService,
  ChangeOperationError,
  type TrackedItemsView,
} from './board.js';
export {
  SchemaReader,
  parseSchemaYaml,
  type SchemaArtifact,
  type SchemaDefinition,
} from './schemaDefinition.js';

export {
  MetricsService,
  UnknownItemError,
  type AcceptanceRunResult,
  type ChangeMetricsView,
} from './metrics.js';
export { JOURNAL_FILE, MetricsStore, SNAPSHOT_FILE, type StoreLoad } from './metricsStore.js';
export {
  SchemaOperationError,
  SchemaRegistry,
  parseSchemaText,
  type AssignResult,
  type RegistryEntry,
  type SchemaCheck,
  type SchemaSource,
  type StructuralIssue,
  type YamlProblem,
} from './schemaRegistry.js';
export { buildArgs, displayCommand, parseDuration, templateFlags, type AgentConfig } from './agent/launch.js';
export { locateExecutable, probeAgent, type ProbeResult } from './agent/probe.js';
export { PromptBuilder, PromptError, type BuiltPrompt, type RunTarget, type RunTargets } from './agent/prompt.js';
export {
  APPROVAL_MODES,
  AgentBlockedError,
  AgentBusyError,
  AgentConsentError,
  AgentService,
  type AgentStatus,
  type ApprovalMode,
  type RunRequest,
} from './agent/runner.js';
export { AgentRunStore, Redactor, type AgentRunRecord, type StoredAgentEvent } from './agent/store.js';
