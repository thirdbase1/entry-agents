import "server-only";

import {
  cleanupStaleDrives,
  type DriveSessionStatus,
} from "@open-agents/sandbox";
import { getSessionByIds } from "@/lib/db/sessions";
import {
  getSessionDrivePrefix,
  SANDBOX_DRIVE_MAX_AGE_MS,
} from "@/lib/sandbox/config";

/**
 * Reclaim per-session workspace drives that are no longer needed.
 *
 * Drives are created lazily by getSandboxDriveConfig() when a session
 * provisions a sandbox, one per session, and nothing else deletes them.
 * Without this they accumulate at 8 GiB of provisioned capacity each.
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
    maxIdleMs: SANDBOX_DRIVE_MAX_AGE_MS,
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
            lastTouchedAt: session.updatedAt?.getTime() ?? 0,
          }
        : { exists: false, archived: false, lastTouchedAt: 0 };

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
