import type { Sandbox } from "../interface.ts";
import type { Source } from "../types.ts";
import type { BoatState } from "./state.ts";
import {
  boatRequest,
  getBoatConfig,
  isBoatNotFoundError,
  type BoatSandboxRecord,
} from "./client.ts";
import {
  bootstrapBoatWorkspace,
  BOAT_DEFAULT_WORKING_DIRECTORY,
  ensureBoatWorkingDirectory,
} from "./bootstrap.ts";
import {
  BoatSandbox,
  isBoatReadyState,
  type BoatSandboxConnectOptions,
} from "./sandbox.ts";

/** How long to poll `GET /sandboxes/{id}` before giving up. */
const READY_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;
const BOAT_MAX_TTL_SECONDS = 2_592_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ttlSecondsFromTimeout(timeoutMs?: number): number | null {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return Math.min(BOAT_MAX_TTL_SECONDS, Math.max(1, Math.ceil(timeoutMs / 1000)));
}

async function getRecord(sandboxId: string): Promise<BoatSandboxRecord> {
  const response = await boatRequest<{ sandbox: BoatSandboxRecord }>(
    `/sandboxes/${sandboxId}`,
  );
  return response.sandbox;
}

async function createSandbox(options: {
  ttlSeconds: number | null;
  machineType?: BoatSandboxConnectOptions["machineType"];
  env?: Record<string, string>;
}): Promise<BoatSandboxRecord> {
  const response = await boatRequest<{ sandbox: BoatSandboxRecord }>(
    "/sandboxes",
    {
      method: "POST",
      body: {
        ttlSeconds: options.ttlSeconds,
        ...(options.machineType ? { type: options.machineType } : {}),
        ...(options.env && Object.keys(options.env).length > 0
          ? { env: options.env }
          : {}),
      },
    },
  );

  return response.sandbox;
}

async function resumeSandbox(
  sandboxId: string,
  options: {
    ttlSeconds?: number | null;
    machineType?: BoatSandboxConnectOptions["machineType"];
  },
): Promise<void> {
  await boatRequest(`/sandboxes/${sandboxId}/resume`, {
    method: "POST",
    body: {
      ...(options.ttlSeconds === undefined
        ? {}
        : { ttlSeconds: options.ttlSeconds }),
      ...(options.machineType ? { type: options.machineType } : {}),
    },
  });
}

async function waitUntilReady(
  sandboxId: string,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<BoatSandboxRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  let lastError: unknown;

  while (Date.now() < deadline) {
    let record: BoatSandboxRecord | undefined;

    try {
      record = await getRecord(sandboxId);
      lastState = record.state;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }

    if (record) {
      if (isBoatReadyState(record.state)) {
        return record;
      }

      if (record.state === "error") {
        throw new Error(
          `Boat sandbox ${sandboxId} entered error state during provisioning`,
        );
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for Boat sandbox ${sandboxId} to become ready ` +
      `(last state: ${lastState}${lastError ? `, last error: ${String(lastError)}` : ""})`,
  );
}

async function registerHostedPorts(
  sandbox: BoatSandbox,
  ports: number[] | undefined,
): Promise<void> {
  if (!ports || ports.length === 0) return;

  await Promise.all(
    ports.map(async (port) => {
      try {
        // hostPort() caches the exact URL on the sandbox instance, which
        // domain() then serves. Registration is idempotent per port.
        await sandbox.hostPort(port);
      } catch {
        // Best-effort: domain() still falls back to the derived hostname
        // and the route can be registered again later.
      }
    }),
  );
}

/**
 * Connect to a Boat sandbox: resume an existing one when we still hold its
 * id, otherwise create a new VM, then wait for it to reach a usable state
 * and bootstrap the workspace.
 *
 * `createIfMissing` mirrors the Vercel adapter's meaning -- a persisted id
 * that Boat no longer knows about (404) results in a fresh sandbox instead
 * of a hard failure, which is what makes a permanently deleted or expired
 * Boat sandbox recoverable. Without it the 404 propagates, so callers can
 * still opt into strict behaviour.
 */
export async function connectBoat(
  state: BoatState,
  options?: BoatSandboxConnectOptions,
): Promise<Sandbox> {
  // Fail fast with an actionable message when Boat is selected but not
  // configured. Never falls through to another provider.
  getBoatConfig();

  const ttlSeconds = ttlSecondsFromTimeout(options?.timeout);
  const workingDirectory =
    options?.workingDirectory ?? BOAT_DEFAULT_WORKING_DIRECTORY;
  const source: Source | undefined = state.source;
  const existingId =
    typeof state.sandboxId === "string" && state.sandboxId.length > 0
      ? state.sandboxId
      : undefined;

  let record: BoatSandboxRecord | undefined;

  if (existingId) {
    try {
      record = await getRecord(existingId);
    } catch (error) {
      if (!isBoatNotFoundError(error) || !options?.createIfMissing) {
        throw error;
      }
      record = undefined;
    }
  }

  if (record && record.state === "archived") {
    await resumeSandbox(record.id, {
      ttlSeconds,
      ...(options?.machineType ? { machineType: options.machineType } : {}),
    });
    record = await waitUntilReady(record.id);
  } else if (record) {
    // ready/idle/running/provisioning/cloning -- wait for a usable state.
    record = await waitUntilReady(record.id, READY_TIMEOUT_MS);
  } else {
    record = await createSandbox({
      ttlSeconds,
      ...(options?.machineType ? { machineType: options.machineType } : {}),
      ...(options?.env ? { env: options.env } : {}),
    });
    record = await waitUntilReady(record.id);
  }

  const sandbox = new BoatSandbox(record, {
    workingDirectory,
    ...(source ? { source } : {}),
    ...(state.snapshotId ? { snapshotId: state.snapshotId } : {}),
    ...(options?.env ? { env: options.env } : {}),
    ...(options?.hooks ? { hooks: options.hooks } : {}),
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
  });

  await ensureBoatWorkingDirectory(sandbox);

  await bootstrapBoatWorkspace({
    sandbox,
    ...(source ? { source } : {}),
    ...(options?.gitUser ? { gitUser: options.gitUser } : {}),
    ...(options?.skipGitWorkspaceBootstrap !== undefined
      ? { skipGitWorkspaceBootstrap: options.skipGitWorkspaceBootstrap }
      : {}),
  });

  await registerHostedPorts(sandbox, options?.ports);

  if (options?.hooks?.afterStart) {
    await options.hooks.afterStart(sandbox);
  }

  return sandbox;
}
