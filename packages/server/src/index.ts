export const SERVER_VERSION = '0.1.0';

export {
  LOOPBACK_HOST,
  PortInUseError,
  createApp,
  startServer,
  type RunningServer,
  type ServerOptions,
} from './server.js';

export { runCli, runCliJson, type CliFailure, type CliResult, type CliRunOptions } from './openspec/exec.js';
export { OpenspecClient, type OpenspecClientOptions } from './openspec/client.js';
export { locateOpenspecCli, missingCliNotice, type CliLocation } from './openspec/locate.js';
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
export { WorkspaceWatcher, type FileChangeBatch } from './watcher.js';
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
