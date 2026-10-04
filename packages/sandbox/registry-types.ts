/**
 * Provider-agnostic sandbox registry metadata.
 *
 * This module is deliberately free of any provider SDK (or even Node)
 * imports so it is safe to pull into a browser bundle -- the sandbox
 * selector and the settings/preferences UI are client components that
 * need the provider list without dragging a provider SDK into the
 * client graph.
 *
 * The server-side half that binds each id to its `connect()` lives in
 * ./registry.ts. Adding a provider means: add its state type, add its
 * adapter under <provider>/, register it in registry.ts, and add its id
 * below. Nothing in the agent, the workflows or the UI needs to change.
 */

export type SandboxProviderId = "modal" | "local";

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

/**
 * Modal (modal.com): gVisor-isolated sandbox containers with the
 * workspace on a persistent **Volume**.
 *
 * The volume is the whole story. Because the workspace is mounted from a
 * distributed filesystem that outlives any container, re-provisioning a
 * sandbox costs one boot and zero data transfer -- so `workspaceMigration`
 * is false even though a single sandbox is capped at 24h. Migration would
 * be pure churn: the new sandbox simply remounts the same bytes.
 *
 * `killCommand` is true, but via a documented workaround: Modal's
 * ContainerProcess exposes no kill RPC (only `wait()`), so
 * ModalCloudSandbox records each command's PID when it starts and
 * killCommand() signals that PID from inside the sandbox. Callers that
 * check this capability still get a working cross-process kill; see
 * modal/sandbox.ts for the mechanism.
 *
 * `timeoutExtension` is false: Modal accepts only `timeout` +
 * `idle_timeout` at creation, both bounded by the 24h hard cap, so a
 * running sandbox's lifetime cannot be stretched from outside.
 */
export const MODAL_CAPABILITIES: SandboxCapabilities = {
  // A Volume outlives the sandbox; stop() + reconnect sees the same files.
  persistentResume: true,
  drives: true,
  // snapshotFilesystem() captures a point-in-time Image (30-day TTL).
  snapshots: true,
  execDetached: true,
  // PID-based, see modal/sandbox.ts killCommand().
  killCommand: true,
  // Encrypted tunnels + createConnectToken give public HTTPS URLs.
  publicPorts: true,
  // Per-exec env injection; see modal/sandbox.ts setGitHubAuthToken().
  credentialBrokering: true,
  // No API to extend a live sandbox past its configured timeout.
  timeoutExtension: false,
  // The Volume makes migration unnecessary rather than merely cheap.
  workspaceMigration: false,
  // Modal's documented hard ceiling on a single sandbox lifetime.
  maxTimeoutMs: 24 * 60 * 60 * 1000,
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
  modal: {
    id: "modal",
    displayName: "Modal",
    description: "Cloud sandbox on a persistent volume",
    capabilities: MODAL_CAPABILITIES,
  },
  local: {
    id: "local",
    displayName: "Local",
    description: "Local directory (development only)",
    capabilities: LOCAL_CAPABILITIES,
  },
};

/** Every id the factory can dispatch to. */
export const SANDBOX_TYPES = ["modal", "local"] as const satisfies readonly SandboxProviderId[];

/**
 * Providers a user may pick in the UI. `local` is dev/test only.
 *
 * Ordered so the registry default (`modal`) leads: this list drives the
 * selector and settings dropdown, and showing the default provider first
 * is what makes "which sandbox am I on" readable at a glance.
 */
export const USER_SELECTABLE_SANDBOX_TYPES = [
  "modal",
] as const satisfies readonly SandboxProviderId[];

export const DEFAULT_SANDBOX_PROVIDER: SandboxProviderId = "modal";

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
