import "server-only";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/config";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";

export interface UserVercelAuthInfo {
  token: string;
  expiresAt: number;
  externalId: string;
}

async function getVercelAccountId(userId: string): Promise<string> {
  const rows = await db
    .select({ accountId: accounts.accountId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "vercel")))
    .limit(1);
  return rows[0]?.accountId ?? "";
}

/**
 * Cheap existence check for whether this user has a linked Vercel
 * account -- a single indexed row lookup, no live token refresh (that
 * needs next/headers() via better-auth, which only works within an
 * actual request context, not durable workflow/step scope). Used by
 * runAgentWorkflow (see app/workflows/chat.ts) to decide whether to
 * surface the vercel_cli tool's `connected` flag to the agent, mirroring
 * how `github.hasRepo` is derived from plain session columns rather than
 * a live GitHub API call.
 */
export async function hasVercelAccountLinked(userId: string): Promise<boolean> {
  try {
    const accountId = await getVercelAccountId(userId);
    return accountId.length > 0;
  } catch (error) {
    console.error("Error checking Vercel account link:", error);
    return false;
  }
}

/**
 * Get a valid Vercel access token plus CLI-relevant metadata for the given user.
 * better-auth auto-refreshes expired tokens via stored refresh token.
 */
export async function getUserVercelAuthInfo(
  userId: string,
): Promise<UserVercelAuthInfo | null> {
  try {
    const [result, externalId] = await Promise.all([
      auth.api.getAccessToken({
        body: { providerId: "vercel", userId },
        headers: await headers(),
      }),
      getVercelAccountId(userId),
    ]);

    if (!result?.accessToken) {
      return null;
    }

    return {
      token: result.accessToken,
      expiresAt: result.accessTokenExpiresAt
        ? Math.floor(new Date(result.accessTokenExpiresAt).getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 3600,
      externalId,
    };
  } catch (error) {
    console.error("Error fetching Vercel auth:", error);
    return null;
  }
}

/**
 * Get a valid Vercel access token for the given user.
 */
export async function getUserVercelToken(
  userId: string,
): Promise<string | null> {
  try {
    const result = await auth.api.getAccessToken({
      body: { providerId: "vercel", userId },
      headers: await headers(),
    });

    return result?.accessToken ?? null;
  } catch (error) {
    console.error("Error fetching Vercel token:", error);
    return null;
  }
}
