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
