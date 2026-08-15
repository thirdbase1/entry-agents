import "server-only";

import { eq } from "drizzle-orm";
import { db } from "./client";
import { platformSettings } from "./schema";

/**
 * Singleton row id -- there is exactly one platform_settings row, upserted
 * in place on every admin change. See schema.ts's platformSettings comment
 * for why a singleton table instead of a generic key/value store: this is
 * the only platform-wide setting so far, and a real column beats a
 * stringly-typed KV row for the boolean + reason pair.
 */
const SETTINGS_ID = "singleton";

export interface FreeTierGateStatus {
  enabled: boolean;
  reason: string | null;
}

const DEFAULT_STATUS: FreeTierGateStatus = { enabled: true, reason: null };

/**
 * Read fresh from the DB every call, deliberately no caching -- this is
 * polled every ~150ms from inside an in-flight chat turn's stop monitor
 * (see startStopMonitor in app/workflows/chat.ts) specifically so an admin
 * flipping the switch takes effect on already-streaming turns within one
 * poll tick, not after some cache TTL. A single-row indexed read is cheap
 * enough for that polling cadence.
 */
export async function getFreeTierGateStatus(): Promise<FreeTierGateStatus> {
  const [row] = await db
    .select({
      freeTierEnabled: platformSettings.freeTierEnabled,
      disabledReason: platformSettings.disabledReason,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, SETTINGS_ID))
    .limit(1);

  if (!row) {
    return DEFAULT_STATUS;
  }

  return { enabled: row.freeTierEnabled, reason: row.disabledReason };
}

export async function setFreeTierGateStatus(
  enabled: boolean,
  reason: string | null,
  updatedBy: string,
): Promise<void> {
  await db
    .insert(platformSettings)
    .values({
      id: SETTINGS_ID,
      freeTierEnabled: enabled,
      disabledReason: reason,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: {
        freeTierEnabled: enabled,
        disabledReason: reason,
        updatedBy,
        updatedAt: new Date(),
      },
    });
}

export interface PlatformSettingsRow {
  freeTierEnabled: boolean;
  disabledReason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/** For the admin settings page -- includes audit fields the gate check itself doesn't need. */
export async function getPlatformSettingsRow(): Promise<PlatformSettingsRow> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, SETTINGS_ID))
    .limit(1);

  if (!row) {
    return {
      freeTierEnabled: true,
      disabledReason: null,
      updatedBy: null,
      updatedAt: new Date(0),
    };
  }

  return {
    freeTierEnabled: row.freeTierEnabled,
    disabledReason: row.disabledReason,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}
