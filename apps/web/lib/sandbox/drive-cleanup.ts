import "server-only";

import { Drive } from "@vercel/sandbox";
import { getSessionByIds, type SessionRecord } from "@/lib/db/sessions";
import { SANDBOX_DRIVE_MAX_AGE_MS } from "@/lib/sandbox/config";

/**
 * Reclaim per-session drives that are no longer needed.
 *
 * Drives are created lazily by `getSandboxDriveConfig()` when a session
 * provisions a sandbox, one per session. Nothing deletes them otherwise,
 * so without this they accumulate forever -- 8 GiB of provisioned
 * capacity per abandoned session.
 *
 * A drive is deleted when BOTH hold:
 *   1. It is not attached to any sandbox (currentSandboxName is unset).
 *   2. Its session is archived, missing, or has been idle for longer than
 *      SANDBOX_DRIVE_MAX_AGE_MS.
 *
 * Deliberately conservative: a drive belonging to a live session is never
 * touched, and an in-use drive cannot be deleted anyway (the API rejects
 * it), so the attachment check is mainly to skip work.
 */
export async function cleanupStaleSessionDrives(): Promise<{
  scanned: number;
  deleted: number;
  skipped: number;
  failed: number;
}> {
  const result = { scanned: 0, deleted: 0, skipped: 0, failed: 0 };

  let drives: Drive[];
  try {
    drives = await Drive.list({ limit: 100 }).then((p) => p.toArray());
  } catch (error) {
    console.warn(
      "[drive-cleanup] Failed to list drives; aborting this run:",
      error,
    );
    return result;
  }

  // Only consider drives this app owns.
  const sessionDrives = drives.filter((d) => d.name.startsWith("entry-agents-session-"));
  if (sessionDrives.length === 0) {
    return result;
  }

  // Map drive -> session id so we can look up liveness in one query.
  const prefix = "entry-agents-session-";
  const sessionIds = sessionDrives
    .map((d) => d.name.slice(prefix.length))
    .filter((id) => id.length > 0);

  let sessions = new Map<string, SessionRecord>();
  try {
    const records = await getSessionByIds(sessionIds);
    sessions = new Map(records.map((r) => [r.id, r]));
  } catch (error) {
    console.warn(
      "[drive-cleanup] Failed to load sessions; treating all as unknown:",
      error,
    );
  }

  const now = Date.now();

  for (const drive of sessionDrives) {
    result.scanned++;

    // Never race an attached drive -- the API would reject the delete, and
    // more importantly the session is actively using it.
    if (drive.currentSandboxName) {
      result.skipped++;
      continue;
    }

    const sessionId = drive.name.slice(prefix.length);
    const session = sessions.get(sessionId);

    if (!session) {
      // Session is gone entirely; its drive is reclaimable.
      await deleteDrive(drive, result, "session-missing");
      continue;
    }

    if (session.status === "archived") {
      await deleteDrive(drive, result, "session-archived");
      continue;
    }

    const lastTouched = Math.max(
      session.updatedAt?.getTime() ?? 0,
      drive.updatedAt.getTime(),
    );
    if (now - lastTouched > SANDBOX_DRIVE_MAX_AGE_MS) {
      await deleteDrive(drive, result, "idle-too-long");
      continue;
    }

    result.skipped++;
  }

  return result;
}

async function deleteDrive(
  drive: Drive,
  result: { deleted: number; failed: number },
  reason: string,
): Promise<void> {
  try {
    await drive.delete();
    result.deleted++;
    console.log(`[drive-cleanup] Deleted ${drive.name} (${reason}).`);
  } catch (error) {
    result.failed++;
    console.warn(
      `[drive-cleanup] Failed to delete ${drive.name} (${reason}):`,
      error,
    );
  }
}
