/**
 * Provider-agnostic sandbox registry metadata.
 *
 * This module is deliberately free of any provider SDK (or even Node)
 * imports so it is safe to pull into a browser bundle -- the sandbox
 * selector and the settings/preferences UI are client components that
 * need the provider list without dragging `@vercel/sandbox` (or a future
 * Boat client) into the client graph.
 *
 * The server-side half that binds each id to its `connect()` lives in
 * ./registry.ts. Adding a provider means: add its state type, add its
 * adapter under <provider>/, register it in registry.ts, and add its id
 * below. Nothing in the agent, the workflows or the UI needs to change.
 */

export type SandboxProviderId = "vercel" | "boat" | "local";

/**
 * What a sandbox provider can actually do.
 *
 * The core asks the registry this instead of assuming Vercel behaviour:
 * `if (capabilities.workspaceMigration) ...` reads as policy, whereas
 * `if (state.type === "vercel") ...` reads as a hard-coded vendor check
 * that silently no-ops for every other provider.
 */
export interface SandboxCapabilities {
  /**
   * The filesystem survives stop() + resume(). False for Entry's Vercel
   * sandboxes (`persistent: false` -- stopping loses the workspace), true
   * for Boat (stop snapshots the disk, resume restores it) and for the
   * local dev adapter (it never goes anywhere).
   */
  persistentResume: boolean;
  /** Attachable workspace storage that outlives an individual sandbox. */
  drives: boolean;
  /** Provider can capture a point-in-time copy of the filesystem. */
  snapshots: boolean;
  /** Supports starting a command that outlives the call. */
  execDetached: boolean;
  /** Supports force-killing a command by id from a different process. */
  killCommand: boolean;
  /** Supports giving an in-sandbox port a public URL. */
  publicPorts: boolean;
  /** Supports injecting short-lived credentials into a running sandbox. */
  credentialBrokering: boolean;
  /** Supports extending a running sandbox's lifetime. */
  timeoutExtension: boolean;
  /**
   * The host must migrate the workspace to a fresh sandbox near the hard
   * session cap. False when stopping and resuming the same sandbox already
   * preserves the filesystem, in which case migration would be pure churn.
   */
  workspaceMigration: boolean;
  /** Hard ceiling on a single sandbox lifetime, in ms. `null` = uncapped. */
  maxTimeoutMs: number | null;
}

export interface SandboxProviderMetadata {
  id: SandboxProviderId;
  displayName: string;
  description: string;
  capabilities: SandboxCapabilities;
}

/** Vercel Sandbox, as configured by this app (non-persistent, drives opt-in). */
export const VERCEL_CAPABILITIES: SandboxCapabilities = {
  persistentResume: false,
  drives: true,
  snapshots: true,
  execDetached: true,
  killCommand: true,
  publicPorts: true,
  credentialBrokering: true,
  timeoutExtension: true,
  workspaceMigration: true,
  // Vercel's documented `timeout <= 45m` API ceiling, shared with
  // apps/web/lib/sandbox/config.ts (MAX_SANDBOX_TIMEOUT_MS).
  maxTimeoutMs: 45 * 60 * 1000,
};

/**
 * Boat (docs.boat.dev): a full persistent Linux VM. Stop snapshots the
 * disk and pauses billing; resume restores it on a new machine under the
 * same sandbox id, so the workspace never needs to be migrated.
 */
export const BOAT_CAPABILITIES: SandboxCapabilities = {
  persistentResume: true,
  drives: false,
  snapshots: true,
  execDetached: true,
  // No documented "kill process by id" endpoint; the command API only
  // exposes start/status. Detached processes are not recorded as an
  // active command, so there is nothing for the caller to kill either.
  killCommand: false,
  publicPorts: true,
  // GitHub and Vercel tokens are brokered per command in memory
  // (BoatSandbox.setGitHubAuthToken / setVercelAuthToken) rather than
  // injected at the network egress layer, because Boat offers no equivalent
  // mechanism and its PATCH endpoint cannot hot-set env on a live sandbox.
  credentialBrokering: true,
  timeoutExtension: true,
  workspaceMigration: false,
  // Requested TTL is capped at 7200s (2h): trial accounts reject any
  // sandbox without auto-stop, and reject TTLs above 2h. See
  // BOAT_TTL_CEILING_SECONDS. This used to claim 30 days -- the API
  // ceiling -- while we were also sending `null` (no auto-stop), which is
  // exactly what production was failing on.
  maxTimeoutMs: 7_200 * 1000,
};

/** Local directory + child_process. Dev/test only -- never a real session. */
export const LOCAL_CAPABILITIES: SandboxCapabilities = {
  persistentResume: true,
  drives: false,
  snapshots: false,
  execDetached: false,
  killCommand: false,
  publicPorts: false,
  credentialBrokering: false,
  timeoutExtension: false,
  workspaceMigration: false,
  maxTimeoutMs: null,
};

export const SANDBOX_PROVIDER_METADATA: Record<
  SandboxProviderId,
  SandboxProviderMetadata
> = {
  vercel: {
    id: "vercel",
    displayName: "Vercel",
    description: "Cloud sandbox",
    capabilities: VERCEL_CAPABILITIES,
  },
  boat: {
    id: "boat",
    displayName: "Boat",
    description: "Persistent Linux VM",
    capabilities: BOAT_CAPABILITIES,
  },
  local: {
    id: "local",
    displayName: "Local",
    description: "Local directory (development only)",
    capabilities: LOCAL_CAPABILITIES,
  },
};

/** Every id the factory can dispatch to. */
export const SANDBOX_TYPES = [
  "vercel",
  "boat",
  "local",
] as const satisfies readonly SandboxProviderId[];

/**
 * Providers a user may pick in the UI. `local` is dev/test only.
 *
 * Ordered so the registry default (`boat`) leads: this list drives the
 * selector and settings dropdown, and showing the default provider first
 * is what makes "which sandbox am I on" readable at a glance.
 */
export const USER_SELECTABLE_SANDBOX_TYPES = [
  "boat",
  "vercel",
] as const satisfies readonly SandboxProviderId[];

export const DEFAULT_SANDBOX_PROVIDER: SandboxProviderId = "boat";

export function isKnownSandboxType(value: unknown): value is SandboxProviderId {
  return (
    typeof value === "string" &&
    SANDBOX_TYPES.includes(value as SandboxProviderId)
  );
}

export function isUserSelectableSandboxType(
  value: unknown,
): value is (typeof USER_SELECTABLE_SANDBOX_TYPES)[number] {
  return (
    typeof value === "string" &&
    USER_SELECTABLE_SANDBOX_TYPES.includes(
      value as (typeof USER_SELECTABLE_SANDBOX_TYPES)[number],
    )
  );
}

export function getSandboxProviderMetadata(
  id: string,
): SandboxProviderMetadata | undefined {
  return isKnownSandboxType(id) ? SANDBOX_PROVIDER_METADATA[id] : undefined;
}

/** Registry-driven option list for selectors and validation. */
export function listUserSelectableSandboxProviders(): SandboxProviderMetadata[] {
  return USER_SELECTABLE_SANDBOX_TYPES.map(
    (id) => SANDBOX_PROVIDER_METADATA[id],
  );
}

/**
 * Capability lookup for a provider id. Unknown ids report a fully
 * disabled capability set so callers degrade instead of throwing on
 * malformed/legacy rows.
 */
export function getSandboxCapabilities(
  id: string,
): SandboxCapabilities {
  return (
    getSandboxProviderMetadata(id)?.capabilities ?? {
      persistentResume: false,
      drives: false,
      snapshots: false,
      execDetached: false,
      killCommand: false,
      publicPorts: false,
      credentialBrokering: false,
      timeoutExtension: false,
      workspaceMigration: false,
      maxTimeoutMs: null,
    }
  );
}
