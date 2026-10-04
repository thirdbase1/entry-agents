/**
 * Source configuration for cloning a git repository into a sandbox.
 */
export interface Source {
  /** GitHub repository URL (e.g., "https://github.com/owner/repo") */
  repo: string;
  /** Branch to clone (defaults to "main") */
  branch?: string;
  /** Deprecated: do not embed GitHub tokens in sandbox remotes. */
  token?: string;
  /** If set, create and checkout a new branch with this name after cloning */
  newBranch?: string;
}

/**
 * A single drive mount: the named drive to attach, the absolute path to
 * mount it at inside the sandbox, and whether it is read-write or a
 * read-only snapshot.
 *
 * Deliberately provider-neutral: "drive" is the shared name for durable
 * attachable storage (a Vercel Drive, a Modal Volume), so callers declare
 * mounts once and each provider adapter maps the spec onto its own
 * mount API.
 */
export interface DriveMountSpec {
  /** Name of an existing drive. */
  driveName: string;
  /** Absolute mount path inside the sandbox, e.g. `/workspace`. */
  mountPath: string;
  /** `read-write` (default) or `snapshot` for a read-only view. */
  mode?: "read-write" | "snapshot";
  /** Drive size in bytes when the drive has to be created. */
  maxSizeBytes?: number;
}

/**
 * Optional drive configuration. When set, `connectSandbox()` resolves each
 * declared drive before creating the sandbox and passes the resulting
 * mounts through to the provider's create call.
 *
 * Drives persist independently of sandbox lifetime, so a workspace mounted
 * on a drive survives sandbox stop/expiry without relying on snapshots.
 * This is what makes Modal's `workspaceMigration: false` honest.
 */
export interface DriveMountConfig {
  mounts: DriveMountSpec[];
}

/**
 * File entry representing a file, directory, or symlink in the sandbox filesystem.
 * Used for serialization/deserialization of sandbox state.
 */
export interface FileEntry {
  type: "file" | "directory" | "symlink";
  /** File content (UTF-8 text or base64 for binary) */
  content?: string;
  /** Set to "base64" for binary files */
  encoding?: "base64";
  /** File permissions */
  mode?: number;
  /** Symlink target path */
  target?: string;
}

/**
 * Status of a sandbox throughout its lifecycle.
 * Used for UI feedback and state management.
 */
export type SandboxStatus =
  | "starting" // Creating new sandbox
  | "restoring" // Restoring from saved state (files or snapshot)
  | "reconnecting" // Reconnecting to existing VM
  | "ready" // Fully usable
  | "stopping" // Shutting down
  | "stopped"; // Terminated
