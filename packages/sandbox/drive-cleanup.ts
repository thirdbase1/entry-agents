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
  /**
   * Delete a drive once the DRIVE itself has not been updated for this
   * long. Measured on the drive's own `updatedAt`, so an actively used
   * drive is never eligible no matter what its session record says.
   */
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
 *   2. The drive has not been updated for longer than `maxIdleMs` -- the
 *      primary guard, measured on the drive itself.
 *   3. Its session is missing or archived. A live session whose drive has
 *      been quiet for the full window is still treated as reclaimable.
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

    // Guard 2 comes FIRST and is independent of the session record: a
    // drive written to recently is live work, full stop.
    const driveIdleMs = now - drive.updatedAt.getTime();
    if (driveIdleMs <= options.maxIdleMs) {
      result.skipped++;
      options.onDecision?.(drive.name, "skipped", "drive-recently-updated");
      continue;
    }

    let reason: string;
    if (!status.exists) {
      reason = "session-missing";
    } else if (status.archived) {
      reason = "session-archived";
    } else {
      reason = "drive-idle-too-long";
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
