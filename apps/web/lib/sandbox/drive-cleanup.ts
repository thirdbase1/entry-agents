import "server-only";

import {
  cleanupStaleDrives,
  type DriveSessionStatus,
} from "@open-agents/sandbox";
import { getSessionByIds } from "@/lib/db/sessions";
import {
  getSessionDrivePrefix,
  SANDBOX_DRIVE_MAX_IDLE_MS,
} from "@/lib/sandbox/config";

/**
 * Reclaim per-session workspace drives that are no longer needed.
 *
 * Drives are created lazily by getSandboxDriveConfig() when a session
 * provisions a sandbox, one per session, and nothing else deletes them.
 * Without this they accumulate at 8 GiB of provisioned capacity each.
 *
 * Retention is driven by the DRIVE's own last-updated time (3 days), so a
 * drive that is still being written to is never a candidate regardless of
 * what its session record says.
 *
 * The Vercel SDK is only declared by @open-agents/sandbox, so the sweep
 * itself lives there; this wrapper resolves session liveness from the
 * database and applies this app's retention policy.
 */
export async function cleanupStaleSessionDrives(): Promise<{
  scanned: number;
  deleted: number;
  skipped: number;
  failed: number;
}> {
  const prefix = getSessionDrivePrefix();

  // Resolved lazily and cached: the sweep asks per drive, so we never
  // load sessions we do not need.
  const cache = new Map<string, DriveSessionStatus>();

  return cleanupStaleDrives({
    namePrefix: prefix,
    maxIdleMs: SANDBOX_DRIVE_MAX_IDLE_MS,
    resolveStatus: async (sessionId) => {
      const cached = cache.get(sessionId);
      if (cached) {
        return cached;
      }

      const records = await getSessionByIds([sessionId]);
      const session = records[0];

      const status: DriveSessionStatus = session
        ? {
            exists: true,
            archived: session.status === "archived",
          }
        : { exists: false, archived: false };

      cache.set(sessionId, status);
      return status;
    },
    onDecision: (driveName, action, reason) => {
      if (action === "deleted") {
        console.log("[drive-cleanup] Deleted " + driveName + " (" + reason + ").");
      } else if (action === "failed") {
        console.warn("[drive-cleanup] " + driveName + " failed: " + reason);
      }
    },
  });
}
