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
  CONTEXT_SANDBOX_TYPES,
  DEFAULT_SANDBOX_PROVIDER,
  MODAL_CAPABILITIES,
  LOCAL_CAPABILITIES,
  getSandboxCapabilities,
  getSandboxProviderMetadata,
  isKnownSandboxType,
  isSelectableInContext,
  isUserSelectableSandboxType,
  listProvidersForContext,
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

// local
export { LocalSandbox, connectLocal } from "./local/sandbox.ts";
export type { LocalState } from "./local/state.ts";

// provider-neutral drive types (moved out of ./vercel/config.ts when
// Vercel was dropped; Modal volumes are drives too)
export type { DriveMountConfig, DriveMountSpec } from "./types.ts";

// Error-shape helper: the SDK keeps the real cause on .text/.json while
// .message stays generic, so a bare `error.message` loses the diagnosis.
export { toErrorMessage } from "./modal/client.ts";

// Modal client + volume lifecycle, for server-side callers that need to
// reclaim an archived session's workspace. The credential resolution stays
// inside modal/client.ts; callers only ever see these functions.
export { createModalClient, deleteModalVolume } from "./modal/client.ts";
