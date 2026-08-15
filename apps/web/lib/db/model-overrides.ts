import "server-only";

import { eq } from "drizzle-orm";
import { db } from "./client";
import { modelOverrides } from "./schema";

/**
 * Admin-controlled model kill switch (see modelOverrides in schema.ts).
 * Backed by the DB instead of a hardcoded array so toggling a model off
 * takes effect for every user on their next request -- no code change,
 * no redeploy. Queried fresh each call: this table stays tiny (one row
 * per model the admin has ever touched) so an extra indexed read per
 * chat turn / /api/models call is cheap, and staleness here would be
 * worse than the cost of skipping a cache.
 */
export async function getDisabledModelIdSet(): Promise<Set<string>> {
  const rows = await db
    .select({
      modelId: modelOverrides.modelId,
      disabled: modelOverrides.disabled,
    })
    .from(modelOverrides)
    .where(eq(modelOverrides.disabled, true));

  return new Set(rows.map((row) => row.modelId));
}

export interface ModelOverrideRow {
  modelId: string;
  disabled: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

/** All override rows (both disabled and previously-re-enabled), for the admin page's audit column. */
export async function getAllModelOverrides(): Promise<ModelOverrideRow[]> {
  return db.select().from(modelOverrides);
}

export async function setModelOverride(
  modelId: string,
  disabled: boolean,
  updatedBy: string,
): Promise<void> {
  await db
    .insert(modelOverrides)
    .values({ modelId, disabled, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: modelOverrides.modelId,
      set: { disabled, updatedBy, updatedAt: new Date() },
    });
}
