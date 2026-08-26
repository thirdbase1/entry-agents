import { eq } from "drizzle-orm";
import { db } from "./client";
import { composioSessions } from "./schema";

/**
 * Looks up the Composio session ID Entry previously minted for this
 * user, if any. See lib/mcp/composio.ts for how this is used to
 * resume a session (per Composio's own guidance: persist the session
 * ID and resume it across turns instead of creating a fresh one on
 * every message).
 */
export async function getComposioSessionId(
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: composioSessions.sessionId })
    .from(composioSessions)
    .where(eq(composioSessions.userId, userId));

  return row?.sessionId ?? null;
}

/**
 * Upserts the Composio session ID for a user -- called once right
 * after minting a brand new session, and again whenever a stored
 * session ID turns out to be stale/unresumable and a fresh one had to
 * be created in its place.
 */
export async function setComposioSessionId(
  userId: string,
  sessionId: string,
): Promise<void> {
  await db
    .insert(composioSessions)
    .values({ userId, sessionId })
    .onConflictDoUpdate({
      target: composioSessions.userId,
      set: { sessionId, updatedAt: new Date() },
    });
}
