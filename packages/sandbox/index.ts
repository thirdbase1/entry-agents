// interface
export type {
  ActiveCommandInfo,
  ExecResult,
  Sandbox,
  SandboxHook,
  SandboxHooks,
  SandboxStats,
  SandboxType,
  SnapshotResult,
} from "./interface.ts";

// migration (moving a session's workspace to a fresh sandbox ahead of
// its hard session-duration cap -- see lib/sandbox/migration.ts in
// apps/web)
export {
  packWorkspacePayload,
  restoreWorkspacePayload,
  type WorkspacePayload,
} from "./migrate.ts";

// drive reclamation
export {
  cleanupStaleDrives,
  type DriveCleanupOptions,
  type DriveCleanupResult,
  type DriveSessionStatus,
} from "./drive-cleanup.ts";

// shared types
export type { Source, FileEntry, SandboxStatus } from "./types.ts";

// factory
export {
  connectSandbox,
  type ConnectOptions,
  type SandboxConnectConfig,
} from "./factory.ts";

export type { SandboxState } from "./state.ts";

// provider registry -- provider metadata + capabilities are importable
// from a browser bundle (no provider SDKs pulled in), while the
// server-side bindings live behind ./registry.
export {
  SANDBOX_TYPES,
  SANDBOX_PROVIDER_METADATA,
  USER_SELECTABLE_SANDBOX_TYPES,
  DEFAULT_SANDBOX_PROVIDER,
  VERCEL_CAPABILITIES,
  BOAT_CAPABILITIES,
  LOCAL_CAPABILITIES,
  getSandboxCapabilities,
  getSandboxProviderMetadata,
  isKnownSandboxType,
  isUserSelectableSandboxType,
  listUserSelectableSandboxProviders,
  type SandboxCapabilities,
  type SandboxProviderId,
  type SandboxProviderMetadata,
} from "./registry-types.ts";

export {
  SANDBOX_PROVIDERS,
  getSandboxProvider,
  requireSandboxProvider,
  requireAvailableSandboxProvider,
  UnsupportedSandboxProviderError,
  type BuildProvisionStateInput,
  type SandboxProvider,
} from "./registry.ts";

// git helpers
export {
  hasUncommittedChanges,
  stageAll,
  getCurrentBranch,
  getHeadSha,
  getStagedDiff,
  getChangedFiles,
  detectBinaryFiles,
  readFileContents,
  getFileModes,
  getSymlinkTarget,
  syncToRemote,
  syncToRemotePreservingChanges,
  withTemporaryGitHubAuth,
  type FileChange,
  type FileChangeStatus,
  type FileWithContent,
} from "./git.ts";

// vercel
export {
  connectVercelSandbox,
  VercelSandbox,
  toErrorMessage,
  type VercelSandboxConfig,
  type VercelSandboxConnectConfig,
  type VercelState,
} from "./vercel/index.ts";

// local
export { LocalSandbox, connectLocal } from "./local/sandbox.ts";
export type { LocalState } from "./local/state.ts";

// boat
export {
  BoatSandbox,
  connectBoat,
  BoatApiError,
  BoatConfigurationError,
  BOAT_DEFAULT_WORKING_DIRECTORY,
  isBoatConfigured,
  isBoatNotFoundError,
  type BoatSandboxConnectOptions,
  type BoatState,
} from "./boat/index.ts";
