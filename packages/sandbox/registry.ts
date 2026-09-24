/**
 * Server-side sandbox provider registry: binds each registered provider id
 * to its `connect()` implementation and its state-shape normalisation.
 *
 * The registry is the ONLY place that knows which concrete adapter backs a
 * given `state.type`. `connectSandbox()` in factory.ts dispatches through
 * it, so an unknown provider throws instead of falling through to Vercel --
 * a user selecting a provider must never silently get a different one.
 *
 * Adding a provider: implement `<provider>/connect.ts` + `state.ts`,
 * register it here, and add its metadata to registry-types.ts. No changes
 * are required in the agent, the workflows, or the UI.
 */

import type { Sandbox } from "./interface.ts";
import type { ConnectOptions } from "./factory.ts";
import type { SandboxState } from "./state.ts";
import type { Source } from "./types.ts";
import {
  SANDBOX_PROVIDER_METADATA,
  type SandboxCapabilities,
  type SandboxProviderId,
} from "./registry-types.ts";
import { connectVercel } from "./vercel/connect.ts";
import type { VercelState } from "./vercel/state.ts";
import { connectLocal } from "./local/sandbox.ts";
import { connectBoat } from "./boat/connect.ts";
import { isBoatConfigured } from "./boat/client.ts";
import type { BoatState } from "./boat/state.ts";

export class UnsupportedSandboxProviderError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `Unsupported sandbox provider "${providerId}". Registered providers: ` +
        `${Object.keys(SANDBOX_PROVIDER_METADATA).join(", ")}. ` +
        `Entry never falls back to a different provider.`,
    );
    this.name = "UnsupportedSandboxProviderError";
    this.providerId = providerId;
  }
}

export interface BuildProvisionStateInput {
  /** Valid state already persisted on the session, if any. */
  existing?: SandboxState;
  sessionId: string;
  source?: Source;
  /**
   * Build state for a brand-new sandbox rather than a reconnect: drop any
   * persisted identity so `connect()` creates instead of resuming.
   * Used by workspace migration (only reachable for providers whose
   * capabilities report `workspaceMigration`).
   */
  fresh?: boolean;
}

export interface SandboxProvider {
  id: SandboxProviderId;
  displayName: string;
  description: string;
  capabilities: SandboxCapabilities;
  /** Resolve a usable `Sandbox` for the given state. */
  connect(state: SandboxState, options?: ConnectOptions): Promise<Sandbox>;
  /**
   * Build the state that provisioning should persist for a session. Lives
   * here (rather than in provisioning.ts) so identity/naming rules --
   * Vercel's `session_<id>` name, Boat's bare `bx_*` id -- stay inside the
   * provider instead of becoming provider-name branches in app code.
   */
  buildProvisionState(input: BuildProvisionStateInput): SandboxState;
  /**
   * Whether the provider can operate in this environment right now (i.e.
   * its credentials are configured). An unavailable provider is a hard
   * error at connect time, never a silent substitution.
   */
  isAvailable(): boolean;
}

function carryForward(
  state: SandboxState | undefined,
  drop: readonly string[],
): Record<string, unknown> {
  const carried: Record<string, unknown> = { ...(state ?? {}) };
  for (const key of drop) {
    delete carried[key];
  }
  return carried;
}

const vercelProvider: SandboxProvider = {
  id: "vercel",
  displayName: SANDBOX_PROVIDER_METADATA.vercel.displayName,
  description: SANDBOX_PROVIDER_METADATA.vercel.description,
  capabilities: SANDBOX_PROVIDER_METADATA.vercel.capabilities,

  async connect(state, options) {
    if (state.type !== "vercel") {
      throw new UnsupportedSandboxProviderError(String(state.type));
    }
    return connectVercel(state as { type: "vercel" } & VercelState, options);
  },

  buildProvisionState({ existing, sessionId, source, fresh }) {
    const current =
      existing?.type === "vercel"
        ? (existing as { type: "vercel" } & VercelState)
        : undefined;
    const carry = carryForward(
      current,
      // `sandboxId` is legacy Vercel identity: it is always promoted to
      // `sandboxName` below, so carrying it too would leave two handles.
      fresh ? ["sandboxName", "sandboxId", "snapshotId"] : ["sandboxId"],
    );

    const resumeHandle =
      typeof carry.sandboxName === "string" && carry.sandboxName.length > 0
        ? carry.sandboxName
        : typeof carry.sandboxId === "string" && carry.sandboxId.length > 0
          ? carry.sandboxId
          : undefined;
    const sandboxName = fresh ? undefined : (resumeHandle ?? `session_${sessionId}`);

    return {
      type: "vercel",
      ...carry,
      ...(sandboxName ? { sandboxName } : {}),
      // NOTE: `persistent` is intentionally NOT set here. It is governed by
      // ConnectOptions.persistent (provisioning passes false, snapshot
      // restore passes true), and seeding it into state would win over the
      // caller's option because connectVercel reads `state.persistent ??
      // options.persistent`.
      ...(source ? { source } : {}),
    } as SandboxState;
  },

  isAvailable: () => true,
};

const boatProvider: SandboxProvider = {
  id: "boat",
  displayName: SANDBOX_PROVIDER_METADATA.boat.displayName,
  description: SANDBOX_PROVIDER_METADATA.boat.description,
  capabilities: SANDBOX_PROVIDER_METADATA.boat.capabilities,

  async connect(state, options) {
    if (state.type !== "boat") {
      throw new UnsupportedSandboxProviderError(String(state.type));
    }
    return connectBoat(state as { type: "boat" } & BoatState, options);
  },

  buildProvisionState({ existing, source, fresh }) {
    const current =
      existing?.type === "boat"
        ? (existing as { type: "boat" } & BoatState)
        : undefined;
    const carry = carryForward(current, fresh ? ["sandboxId"] : []);

    // Boat's identity is its id -- no caller-chosen name is needed, and
    // there is no `persistent` flag: persistence is inherent (stop
    // snapshots, resume restores).
    return {
      type: "boat",
      ...carry,
      ...(source ? { source } : {}),
    } as SandboxState;
  },

  isAvailable: () => isBoatConfigured(),
};

const localProvider: SandboxProvider = {
  id: "local",
  displayName: SANDBOX_PROVIDER_METADATA.local.displayName,
  description: SANDBOX_PROVIDER_METADATA.local.description,
  capabilities: SANDBOX_PROVIDER_METADATA.local.capabilities,

  async connect(state, options) {
    if (state.type !== "local") {
      throw new UnsupportedSandboxProviderError(String(state.type));
    }
    return connectLocal(state as { type: "local" } & { rootDir: string }, options);
  },

  buildProvisionState({ existing, sessionId, fresh }) {
    const current = existing?.type === "local" ? existing : undefined;
    const rootDir =
      !fresh && current?.rootDir
        ? current.rootDir
        : `/tmp/entry-sandbox-${sessionId}`;

    return { type: "local", rootDir } as SandboxState;
  },

  isAvailable: () => true,
};

export const SANDBOX_PROVIDERS: Record<SandboxProviderId, SandboxProvider> = {
  vercel: vercelProvider,
  boat: boatProvider,
  local: localProvider,
};

export function getSandboxProvider(
  id: string,
): SandboxProvider | undefined {
  return SANDBOX_PROVIDERS[id as SandboxProviderId];
}

/**
 * Resolve the provider for a state, throwing for anything unregistered.
 * This is the guard that prevents "UI says Boat, backend runs Vercel".
 */
export function requireSandboxProvider(id: string): SandboxProvider {
  const provider = getSandboxProvider(id);
  if (!provider) {
    throw new UnsupportedSandboxProviderError(id);
  }
  return provider;
}

export function requireAvailableSandboxProvider(id: string): SandboxProvider {
  const provider = requireSandboxProvider(id);
  if (!provider.isAvailable()) {
    throw new UnsupportedSandboxProviderError(
      `${id} (registered but unavailable in this environment)`,
    );
  }
  return provider;
}
