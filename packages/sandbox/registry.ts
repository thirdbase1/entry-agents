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
import { connectModal } from "./modal/connect.ts";
import { connectBoxd } from "./boxd/connect.ts";
import { isBoxdConfigured } from "./boxd/config.ts";
import type { BoxdState } from "./boxd/state.ts";
import { isModalConfigured } from "./modal/client.ts";
import type { ModalState } from "./modal/state.ts";
import { connectLocal } from "./local/sandbox.ts";
import type { LocalSandboxConnectOptions } from "./local/sandbox.ts";

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

const boxdProvider: SandboxProvider = {
  id: "boxd",
  displayName: SANDBOX_PROVIDER_METADATA.boxd.displayName,
  description: SANDBOX_PROVIDER_METADATA.boxd.description,
  capabilities: SANDBOX_PROVIDER_METADATA.boxd.capabilities,

  async connect(state, options) {
    if (state.type !== "boxd") throw new UnsupportedSandboxProviderError(String(state.type));
    return connectBoxd(state as { type: "boxd" } & BoxdState & { sessionId: string }, options);
  },

  buildProvisionState({ existing, sessionId, source }) {
    const current = existing?.type === "boxd" ? (existing as { type: "boxd" } & BoxdState) : undefined;
    return {
      type: "boxd",
      ...(current?.machineId ? { machineId: current.machineId } : {}),
      ...(current?.machineName ? { machineName: current.machineName } : {}),
      ...(source ? { source } : {}),
    } as SandboxState;
  },

  isAvailable: () => isBoxdConfigured(),
};

const modalProvider: SandboxProvider = {
  id: "modal",
  displayName: SANDBOX_PROVIDER_METADATA.modal.displayName,
  description: SANDBOX_PROVIDER_METADATA.modal.description,
  capabilities: SANDBOX_PROVIDER_METADATA.modal.capabilities,

  async connect(state, options) {
    if (state.type !== "modal") {
      throw new UnsupportedSandboxProviderError(String(state.type));
    }
    return connectModal(
      state as { type: "modal" } & ModalState & { sessionId: string },
      options,
    );
  },

  buildProvisionState({ existing, sessionId, source, fresh }) {
    const current =
      existing?.type === "modal"
        ? (existing as { type: "modal" } & ModalState)
        : undefined;

    // The Volume is the durable identity, so it is carried across a
    // fresh provision; the sandbox id is NOT (it is a handle on a live
    // container and is always re-derived by connect()).
    const carry = carryForward(
      current,
      fresh ? ["sandboxId", "expiresAt"] : ["expiresAt"],
    );

    const volumeName =
      typeof carry.volumeName === "string" && carry.volumeName.length > 0
        ? carry.volumeName
        : `entry-workspace-${sessionId}`;

    return {
      type: "modal",
      ...carry,
      volumeName,
      ...(source ? { source } : {}),
    } as SandboxState;
  },

  isAvailable: () => isModalConfigured(),
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
    return connectLocal(
      state as { type: "local" } & { rootDir: string },
      options as LocalSandboxConnectOptions | undefined,
    );
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
  boxd: boxdProvider,
  modal: modalProvider,
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
