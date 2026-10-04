import { ModalCloudSandbox, type ModalSandboxConfig } from "./sandbox.ts";
import {
  createModalClient,
  getModalVolume,
  isModalConfigured,
  isModalResourceExhaustedError,
  isModalSandboxGoneError,
  toErrorMessage,
} from "./client.ts";
import {
  MODAL_CHEAP_MEMORY_MIB,
  MODAL_DEFAULT_CPU,
  MODAL_DEFAULT_MEMORY_MIB,
} from "./config.ts";
import type { ModalState } from "./state.ts";
import type { ConnectOptions } from "../factory.ts";
import type { Sandbox } from "../interface.ts";

/** Modal's state shape, plus the session id Entry joins on. */
export type ModalConnectState = ModalState & {
  /** Entry session id -- the volume's durable identity comes from this. */
  sessionId: string;
};

/**
 * Connect to a Modal sandbox.
 *
 * The stable per-session identity is the VOLUME, not the sandbox. A
 * sandbox id is only a handle on something alive right now (Modal caps a
 * sandbox at 24h), while the volume is what holds the user's files. So:
 *
 *   1. resolve the session's workspace Volume, creating it if missing;
 *   2. if state carries a sandboxId that is still alive, reattach;
 *   3. otherwise -- expired, reaped, or a fresh session -- provision a
 *      new sandbox on the SAME volume.
 *
 * Step 3 is what replaces the Vercel/Boat workspace-migration dance: the
 * filesystem is already durable, so re-provisioning costs one container
 * boot and zero data transfer. There is no workspace pack/restore step
 * and nothing to move.
 */
export async function connectModal(
  state: ModalConnectState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  if (!isModalConfigured()) {
    throw new Error(
      "Modal is not configured: set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
    );
  }

  const client = createModalClient();

  // The volume name is the session's durable identity. Sessions that
  // predate volumes get a deterministic, session-derived name so they
  // keep working (and start building their volume) with no data
  // migration at all -- they simply re-clone on first connect.
  const volumeName = state.volumeName ?? `entry-workspace-${state.sessionId}`;
  const volume = await getModalVolume(client, volumeName);

  const shared: Pick<
    ModalSandboxConfig,
    "name" | "volume" | "env" | "hooks" | "ports"
  > = {
    name: `entry-${state.sessionId}`,
    volume,
    ...(options?.env ? { env: options.env } : {}),
    ...(options?.hooks ? { hooks: options.hooks } : {}),
    ...(options?.ports?.length ? { ports: options.ports } : {}),
  };

  if (state.sandboxId && options?.resume !== false) {
    try {
      const sdk = await client.sandboxes.fromId(state.sandboxId);
      return await ModalCloudSandbox.reconnect(client, sdk, shared);
    } catch (error) {
      if (!isModalSandboxGoneError(toErrorMessage(error))) {
        throw error;
      }
      // The recorded sandbox is dead. That is expected near the 24h cap:
      // fall through and provision a fresh one on the same volume. The
      // workspace is untouched, so the session continues where it left off.
    }
  }

  return createWithQuotaFallback({
    client,
    ...shared,
    ...(state.source?.repo
      ? {
          source: {
            url: state.source.repo,
            ...(state.source.branch ? { branch: state.source.branch } : {}),
            ...(state.source.newBranch
              ? { newBranch: state.source.newBranch }
              : {}),
          },
        }
      : {}),
    ...(options?.gitUser ? { gitUser: options.gitUser } : {}),
    ...(options?.vcpus !== undefined ? { cpu: options.vcpus } : {}),
    ...(options?.skipGitWorkspaceBootstrap
      ? { skipGitWorkspaceBootstrap: true }
      : {}),
  });
}

/**
 * Create a sandbox, retrying at the cheapest shape when Modal refuses
 * the default one for quota/capacity reasons.
 *
 * Losing the dev-server tunnels on the retry is intentional: a working
 * command shell beats a 507. The next connect() re-requests them.
 */
async function createWithQuotaFallback(
  config: ModalSandboxConfig,
): Promise<Sandbox> {
  try {
    return await ModalCloudSandbox.create(config);
  } catch (error) {
    if (!isModalResourceExhaustedError(toErrorMessage(error))) {
      throw error;
    }
    console.warn(
      "[ModalSandbox] create was quota-blocked; retrying at the cheapest shape:",
      toErrorMessage(error),
    );
    return ModalCloudSandbox.create({
      ...config,
      cpu: MODAL_DEFAULT_CPU,
      // Keep any explicitly-requested memory; only the default is reduced.
      memoryMiB:
        config.memoryMiB === undefined || config.memoryMiB === MODAL_DEFAULT_MEMORY_MIB
          ? MODAL_CHEAP_MEMORY_MIB
          : config.memoryMiB,
      ports: undefined,
    });
  }
}
