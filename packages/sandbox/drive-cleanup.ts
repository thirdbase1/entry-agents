import { Drive } from "@vercel/sandbox";

/**
 * A drive's liveness signal, as resolved by the caller.
 *
 * The sandbox package deliberately knows nothing about the database, so
 * the app resolves each drive's session and passes the verdict in. This
 * keeps the Vercel SDK dependency contained to the one package that
 * already declares it.
 */
export interface DriveSessionStatus {
  /** Session exists in the database. */
  exists: boolean;
  /** Session is archived. */
  archived: boolean;
  /** Last time the session was touched, epoch ms. */
  lastTouchedAt: number;
}

export interface DriveCleanupResult {
  scanned: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export interface DriveCleanupOptions {
  /** Only consider drives whose name starts with this. */
  namePrefix: string;
  /** Delete a drive when its session has been idle longer than this. */
  maxIdleMs: number;
  /** Resolve a session's status from the drive's session id. */
  resolveStatus: (sessionId: string) => Promise<DriveSessionStatus>;
  /** Called for each deletion decision, for logging. */
  onDecision?: (
    driveName: string,
    action: "deleted" | "skipped" | "failed",
    reason: string,
  ) => void;
}

/**
 * Reclaim drives that are no longer needed.
 *
 * A drive is deleted only when BOTH hold:
 *   1. It is not attached to a sandbox (`currentSandboxName` is unset) --
 *      an attached drive belongs to a live session, and the API rejects
 *      deleting it anyway.
 *   2. Its session is missing, archived, or idle past `maxIdleMs`.
 *
 * A drive failing to delete is counted and the sweep continues, so one
 * bad drive cannot strand the rest.
 */
export async function cleanupStaleDrives(
  options: DriveCleanupOptions,
): Promise<DriveCleanupResult> {
  const result: DriveCleanupResult = {
    scanned: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
  };

  let drives: Drive[];
  try {
    drives = await Drive.list({ limit: 100 }).then((p) => p.toArray());
  } catch (error) {
    options.onDecision?.(
      "*",
      "failed",
      `list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }

  const owned = drives.filter((d) => d.name.startsWith(options.namePrefix));
  if (owned.length === 0) {
    return result;
  }

  const now = Date.now();

  for (const drive of owned) {
    result.scanned++;

    if (drive.currentSandboxName) {
      result.skipped++;
      options.onDecision?.(drive.name, "skipped", "attached");
      continue;
    }

    const sessionId = drive.name.slice(options.namePrefix.length);
    if (!sessionId) {
      result.skipped++;
      options.onDecision?.(drive.name, "skipped", "no-session-id");
      continue;
    }

    let status: DriveSessionStatus;
    try {
      status = await options.resolveStatus(sessionId);
    } catch (error) {
      result.failed++;
      options.onDecision?.(
        drive.name,
        "failed",
        `status lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    let reason: string | null = null;
    if (!status.exists) {
      reason = "session-missing";
    } else if (status.archived) {
      reason = "session-archived";
    } else if (now - status.lastTouchedAt > options.maxIdleMs) {
      reason = "idle-too-long";
    }

    if (!reason) {
      result.skipped++;
      options.onDecision?.(drive.name, "skipped", "session-active");
      continue;
    }

    try {
      await drive.delete();
      result.deleted++;
      options.onDecision?.(drive.name, "deleted", reason);
    } catch (error) {
      result.failed++;
      options.onDecision?.(
        drive.name,
        "failed",
        `delete failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}
