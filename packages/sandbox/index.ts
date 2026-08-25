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
  type SandboxState,
  type ConnectOptions,
  type SandboxConnectConfig,
} from "./factory.ts";

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
  type VercelSandboxConfig,
  type VercelSandboxConnectConfig,
  type VercelState,
} from "./vercel/index.ts";

// local
export { LocalSandbox, connectLocal } from "./local/sandbox.ts";
export type { LocalState } from "./local/state.ts";
