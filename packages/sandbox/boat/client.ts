/**
 * Minimal typed client for the Boat Public API v1 (https://boat.dev/api/v1).
 *
 * Implemented over `fetch` against the documented REST endpoints rather
 * than generated from an SDK so that (a) the error envelope can be folded
 * into a single `Error.message` the shared string matchers already
 * understand, and (b) the adapter stays trivially mockable in tests.
 * Every path/field used here is documented in docs.boat.dev/api/v1 and
 * the per-endpoint reference pages.
 *
 * Auth: a bearer `BOAT_API_KEY` (see docs.boat.dev/api-keys). Keys are
 * scoped, so the key used here needs at least `sandbox.create`,
 * `sandbox.read`, `sandbox.update`, `sandbox.stop`, `sandbox.resume`,
 * `exec`, `file.read`/`file.write` and `host`.
 */

export const DEFAULT_BOAT_BASE_PATH = "https://boat.dev/api/v1";

/** Boat's documented `ttlSeconds` ceiling. */
export const BOAT_MAX_TTL_SECONDS = 2_592_000;

/**
 * The ceiling we actually request, and the default when no timeout is given.
 *
 * Free-trial Boat accounts reject any sandbox that has auto-stop disabled:
 * a create/resume/PATCH without a TTL comes back as
 *   400 trial_auto_stop_required - Free-trial Sandboxes cannot run without
 *   auto-stop. Set a TTL of 2 hours or less...
 * and that single constraint was failing provisioning, sandbox-state
 * persistence, auto-commit and the diff-cache refresh in production.
 * We therefore never send `null` (unlimited) and never ask for more than
 * 2h. Raise this only after the account is paid -- a longer TTL on a trial
 * account reproduces the same 400.
 */
export const BOAT_TTL_CEILING_SECONDS = 7_200;

/** Synchronous command timeout bounds (docs: 1-600s, else 400 invalid_timeout). */
export const BOAT_MIN_COMMAND_TIMEOUT_SECONDS = 1;
export const BOAT_MAX_COMMAND_TIMEOUT_SECONDS = 600;

export class BoatConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoatConfigurationError";
  }
}

export class BoatApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
  }) {
    // The `status code NNN` phrasing is intentional: the shared
    // isSandboxNotFoundError/isSandboxUnavailableError matchers in
    // apps/web/lib/sandbox/utils.ts (and packages/sandbox) are
    // string-based and Vercel-shaped. Including it lets Boat failures
    // flow through the same retry/clear-state paths without a
    // provider-name branch in those helpers.
    super(
      `Boat API error status code ${params.status}: ${params.code} - ${params.message}`,
    );
    this.name = "BoatApiError";
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
  }
}

export function getBoatConfig(): {
  basePath: string;
  accessToken: string;
} {
  const accessToken = process.env.BOAT_API_KEY;
  if (!accessToken) {
    throw new BoatConfigurationError(
      "Boat sandbox selected but BOAT_API_KEY is not set. " +
        "Create a scoped key in the Boat dashboard (docs.boat.dev/api-keys) " +
        "and configure BOAT_API_KEY. Entry never falls back to another " +
        "provider when the selected one is unavailable.",
    );
  }

  return {
    basePath: process.env.BOAT_API_BASE ?? DEFAULT_BOAT_BASE_PATH,
    accessToken,
  };
}

export function isBoatConfigured(): boolean {
  return Boolean(process.env.BOAT_API_KEY);
}

interface BoatErrorEnvelope {
  ok?: boolean;
  status?: number;
  code?: string;
  message?: string;
  requestId?: string;
  error?: { code?: string; message?: string; status?: number };
}

export interface BoatSandboxRecord {
  id: string;
  name?: string | null;
  /** provisioning | provisioned | cloning | ready | idle | running | archiving | archived | error */
  state: string;
  type?: string;
  vcpu?: number;
  memoryGB?: number;
  url?: string | null;
  subdomain?: string | null;
  ip?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** ISO timestamp of the auto-stop (archive) deadline. */
  archiveAfter?: string | null;
  snapshotAvailable?: boolean;
  snapshotCompletedAt?: string | null;
}

export interface BoatCommandResult {
  ok: boolean;
  type: string;
  success: boolean;
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  oomKilled?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  cwd?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Present for `detached: true` starts. */
  processId?: number;
  pid?: number;
}

export interface BoatFileReadResponse {
  ok: boolean;
  type: string;
  success: boolean;
  path: string;
  encoding: "utf8" | "base64";
  size: number;
  content: string;
}

export interface BoatFileWriteResponse {
  ok: boolean;
  type: string;
  success: boolean;
  path: string;
  encoding: "utf8" | "base64";
  size: number;
}

export interface BoatSnapshotRecord {
  id: string;
  status?: string;
  createdAt?: string;
}

export interface BoatHostResponse {
  ok: boolean;
  type?: string;
  sandboxId?: string;
  port?: number;
  url?: string;
  access?: string;
  isProtected?: boolean;
}

export interface BoatRequestInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
}

function buildUrl(
  basePath: string,
  path: string,
  query?: BoatRequestInit["query"],
): string {
  const url = new URL(
    path.startsWith("/") ? `${basePath}${path}` : `${basePath}/${path}`,
  );

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function toBoatApiError(response: Response): Promise<BoatApiError> {
  let code = "http_error";
  let message = response.statusText || "Boat API request failed";
  let requestId: string | undefined;

  try {
    const parsed = (await response.json()) as BoatErrorEnvelope;
    const nested = parsed.error;
    code = parsed.code ?? nested?.code ?? code;
    message = parsed.message ?? nested?.message ?? message;
    requestId = parsed.requestId;
  } catch {
    // Non-JSON body (proxy/HTML error page) -- status alone is enough.
  }

  return new BoatApiError({
    status: response.status,
    code,
    message,
    requestId,
  });
}

/**
 * Perform a Boat API request. Rejects with {@link BoatApiError} carrying
 * the structured Boat error envelope (`status`, `code`, `requestId`).
 */
export async function boatRequest<T>(
  path: string,
  init: BoatRequestInit = {},
): Promise<T> {
  const { basePath, accessToken } = getBoatConfig();

  const response = await fetch(buildUrl(basePath, path, init.query), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });

  if (!response.ok) {
    throw await toBoatApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

export function isBoatApiError(error: unknown): error is BoatApiError {
  return error instanceof BoatApiError;
}

export function isBoatNotFoundError(error: unknown): boolean {
  return isBoatApiError(error) && error.status === 404;
}

export function isBoatRetryableStateError(error: unknown): boolean {
  if (!isBoatApiError(error)) return false;
  return (
    error.code === "machine_not_running" ||
    error.code === "boat_restoring" ||
    error.code === "boat_securing" ||
    error.code === "resume_failed"
  );
}
