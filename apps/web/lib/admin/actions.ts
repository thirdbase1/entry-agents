"use server";

import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth/config";
import {
  getAdminActivityTrend,
  getAdminModelAlerts,
  getAdminModelHealth,
  type AdminActivityDayRow,
  type AdminModelAlertRow,
  type AdminModelHealthRow,
} from "@/lib/db/admin-activity";
import { checkAndNotifyTelegramAlerts } from "@/lib/telegram-alerts";
import {
  getAdminRecentSignups,
  searchAdminUsers,
  type AdminSignupRow,
  type AdminUserLookupRow,
} from "@/lib/db/admin-directory";
import {
  getAdminUserModelBreakdown,
  getAdminUserProfile,
  getAdminUserSessions,
  getAdminUserUsageTrend,
  type AdminUserModelRow,
  type AdminUserProfile,
  type AdminUserSessionRow,
  type AdminUserUsageDayRow,
} from "@/lib/db/admin-user-detail";
import {
  getAdminPlatformStats,
  type AdminPlatformStats,
} from "@/lib/db/admin-platform-stats";
import {
  getAdminPlatformUsageOverview,
  type AdminPlatformUsageOverview,
} from "@/lib/db/admin-usage";
import { db } from "@/lib/db/client";
import { accounts, authSessions, githubInstallations } from "@/lib/db/schema";
import { isUserAdmin } from "@/lib/db/users";
import {
  fetchAllLanguageModelsForAdmin,
  fetchAvailableLanguageModels,
} from "@/lib/models-with-context";
import { isModelHardBlocked } from "@/lib/model-availability";
import {
  getAllModelOverrides,
  setModelOverride,
} from "@/lib/db/model-overrides";
import { getServerSession } from "@/lib/session/get-server-session";
import { getProviderFromModelId } from "@/components/provider-icons";
import type { AvailableModelCost } from "@/lib/models";

async function requireAdmin(): Promise<string> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    throw new Error("Not authenticated");
  }
  const admin = await isUserAdmin(session.user.id);
  if (!admin) {
    throw new Error("Forbidden");
  }
  return session.user.id;
}

// ---------------------------------------------------------------------------
// GitHub revocation helpers
// ---------------------------------------------------------------------------

/**
 * Revoke a single GitHub OAuth token via the GitHub Applications API.
 * Uses HTTP Basic auth with clientId:clientSecret.
 */
async function revokeGitHubToken(token: string): Promise<boolean> {
  const clientId = process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return false;

  try {
    const res = await fetch(
      `https://api.github.com/applications/${clientId}/token`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          Accept: "application/vnd.github.v3+json",
        },
        body: JSON.stringify({ access_token: token }),
      },
    );
    // 204 = success, 422 = token already invalid — both are fine
    return res.status === 204 || res.status === 422;
  } catch (err) {
    console.error("GitHub token revocation failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Vercel revocation helpers
// ---------------------------------------------------------------------------

const VERCEL_REVOKE_URL = "https://api.vercel.com/login/oauth/token/revoke";

/**
 * Revoke a single Vercel OAuth token via the Vercel revocation endpoint.
 */
async function revokeVercelToken(token: string): Promise<boolean> {
  const clientId = process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
  const clientSecret = process.env.VERCEL_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return false;

  try {
    const res = await fetch(VERCEL_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Vercel token revocation failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bulk admin actions
// ---------------------------------------------------------------------------

/**
 * Revoke all GitHub tokens at the provider, then delete account links
 * and installations from the DB.
 *
 * Flow: decrypt each token via better-auth → revoke at GitHub API → delete DB rows.
 * Failures to revoke individual tokens are logged but don't block the operation;
 * we still delete the DB rows so the app no longer considers them connected.
 */
export async function revokeAllGitHubTokens(): Promise<{
  success: boolean;
  error?: string;
  revokedTokens?: number;
  deletedAccounts?: number;
  deletedInstallations?: number;
}> {
  try {
    await requireAdmin();

    // 1. Get all GitHub account rows to find unique user IDs
    const githubAccounts = await db
      .select({ id: accounts.id, userId: accounts.userId })
      .from(accounts)
      .where(eq(accounts.providerId, "github"));

    // 2. Decrypt + revoke each token at GitHub
    let revokedTokens = 0;
    const revokeResults = await Promise.allSettled(
      githubAccounts.map(async (acct) => {
        try {
          const result = await auth.api.getAccessToken({
            body: { providerId: "github", userId: acct.userId },
          });
          if (result?.accessToken) {
            const ok = await revokeGitHubToken(result.accessToken);
            if (ok) revokedTokens++;
          }
        } catch {
          // Token may already be expired/invalid — that's fine
        }
      }),
    );

    const failedRevocations = revokeResults.filter(
      (r) => r.status === "rejected",
    ).length;
    if (failedRevocations > 0) {
      console.warn(
        `${failedRevocations}/${githubAccounts.length} GitHub token revocations failed at the provider`,
      );
    }

    // 3. Delete all GitHub account links and installations from DB
    const [accountResult, installResult] = await Promise.all([
      db
        .delete(accounts)
        .where(eq(accounts.providerId, "github"))
        .returning({ id: accounts.id }),
      db.delete(githubInstallations).returning({ id: githubInstallations.id }),
    ]);

    return {
      success: true,
      revokedTokens,
      deletedAccounts: accountResult.length,
      deletedInstallations: installResult.length,
    };
  } catch (error) {
    console.error("Failed to revoke all GitHub tokens:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to revoke tokens",
    };
  }
}

/**
 * Revoke all Vercel tokens at the provider, then delete account links
 * and auth sessions from the DB.
 *
 * Flow: decrypt each token via better-auth → revoke at Vercel API → delete DB rows.
 * This will log out ALL users (including the admin) since auth sessions are cleared.
 */
export async function revokeAllVercelTokens(): Promise<{
  success: boolean;
  error?: string;
  revokedTokens?: number;
  deletedAccounts?: number;
  deletedSessions?: number;
}> {
  try {
    await requireAdmin();

    // 1. Get all Vercel account rows to find unique user IDs
    const vercelAccounts = await db
      .select({ id: accounts.id, userId: accounts.userId })
      .from(accounts)
      .where(eq(accounts.providerId, "vercel"));

    // 2. Decrypt + revoke each token at Vercel
    let revokedTokens = 0;
    const revokeResults = await Promise.allSettled(
      vercelAccounts.map(async (acct) => {
        const result = await auth.api.getAccessToken({
          body: { providerId: "vercel", userId: acct.userId },
        });
        if (result?.accessToken) {
          const ok = await revokeVercelToken(result.accessToken);
          if (ok) {
            revokedTokens++;
            return;
          }
        }

        throw new Error("Token revocation failed");
      }),
    );

    const failedRevocations = revokeResults.filter(
      (r) => r.status === "rejected",
    ).length;
    if (failedRevocations > 0) {
      console.warn(
        `${failedRevocations}/${vercelAccounts.length} Vercel token revocations failed at the provider`,
      );
    }

    // 3. Delete all Vercel account links and auth sessions from DB
    const [accountResult, sessionResult] = await Promise.all([
      db
        .delete(accounts)
        .where(eq(accounts.providerId, "vercel"))
        .returning({ id: accounts.id }),
      db.delete(authSessions).returning({ id: authSessions.id }),
    ]);

    return {
      success: true,
      revokedTokens,
      deletedAccounts: accountResult.length,
      deletedSessions: sessionResult.length,
    };
  } catch (error) {
    console.error("Failed to revoke all Vercel tokens:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to revoke tokens",
    };
  }
}

// ---------------------------------------------------------------------------
// Admin usage dashboard
// ---------------------------------------------------------------------------

/**
 * Platform-wide usage + estimated spend across every user, for the admin
 * usage dashboard. Admin-only -- throws for non-admins the same way the
 * revocation actions above do.
 */
export async function getAdminUsageOverview(
  days = 30,
): Promise<AdminPlatformUsageOverview> {
  await requireAdmin();

  const modelCostCatalog = await fetchAvailableLanguageModels().catch(() => []);

  return getAdminPlatformUsageOverview({
    days,
    modelCostCatalog,
  });
}

/**
 * All-time platform counters (users, sessions, connected accounts) for
 * the admin overview page. Admin-only.
 */
export async function getAdminStats(): Promise<AdminPlatformStats> {
  await requireAdmin();
  return getAdminPlatformStats();
}

/**
 * Daily turn volume + failure counts for the admin activity chart.
 * Admin-only.
 */
export async function getAdminActivity(
  days = 14,
): Promise<AdminActivityDayRow[]> {
  await requireAdmin();
  return getAdminActivityTrend(days);
}

/**
 * Per-model reliability breakdown (completed/aborted/failed, error rate,
 * avg duration) for the admin model-health table. Admin-only.
 */
export async function getAdminModelHealthReport(
  days = 7,
): Promise<AdminModelHealthRow[]> {
  await requireAdmin();
  return getAdminModelHealth(days);
}

export interface AdminModelCatalogRow {
  id: string;
  name: string;
  provider: string;
  cost?: AvailableModelCost;
  contextWindow?: number;
  /** Hard-blocked in code (billing issue, banned name, ...) -- not admin-togglable. */
  hardBlocked: boolean;
  /** Turned off via the DB override table -- instantly togglable. */
  adminDisabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * Full model catalog for the admin models page: every model the gateway
 * knows about, tagged with whether it's hard-blocked in code vs.
 * currently admin-disabled via the DB override table. Admin-only.
 */
export async function getAdminModelCatalog(): Promise<AdminModelCatalogRow[]> {
  await requireAdmin();

  const [models, overrides] = await Promise.all([
    fetchAllLanguageModelsForAdmin(),
    getAllModelOverrides(),
  ]);

  const overrideMap = new Map(overrides.map((row) => [row.modelId, row]));

  return models
    .map((model) => {
      const override = overrideMap.get(model.id);
      return {
        id: model.id,
        name: model.name,
        provider: getProviderFromModelId(model.id),
        cost: model.cost,
        contextWindow: model.context_window,
        hardBlocked: isModelHardBlocked(model.id),
        adminDisabled: override?.disabled ?? false,
        updatedAt: override?.updatedAt
          ? override.updatedAt.toISOString()
          : null,
        updatedBy: override?.updatedBy ?? null,
      };
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
}

/**
 * Instantly enable/disable a model for every user, no code change or
 * redeploy -- writes to the DB override table read by every chat turn
 * and every /api/models call. Refuses to toggle hard-blocked models
 * (those need a code change, they're blocked for a business reason, not
 * an on/off preference). Admin-only.
 */
export async function setAdminModelDisabled(
  modelId: string,
  disabled: boolean,
): Promise<void> {
  const adminUserId = await requireAdmin();

  if (isModelHardBlocked(modelId)) {
    throw new Error(
      "This model is disabled in code (billing issue or policy) and can't be toggled from here.",
    );
  }

  await setModelOverride(modelId, disabled, adminUserId);
}

/**
 * Most recently created accounts for the admin Users tab. Admin-only.
 */
export async function getAdminSignups(limit = 12): Promise<AdminSignupRow[]> {
  await requireAdmin();
  return getAdminRecentSignups(limit);
}

/**
 * Free-text user search (username/name/email) enriched with connection
 * flags and an all-time estimated-spend summary, for the admin Users
 * tab's lookup box. Admin-only.
 */
export async function lookupAdminUsers(
  query: string,
): Promise<AdminUserLookupRow[]> {
  await requireAdmin();
  const modelCostCatalog = await fetchAvailableLanguageModels().catch(() => []);
  return searchAdminUsers(query, modelCostCatalog);
}

/**
 * Live model error-rate alerts for the admin dashboard banner. Admin-only.
 */
export async function getAdminAlerts(): Promise<AdminModelAlertRow[]> {
  await requireAdmin();
  const alerts = await getAdminModelAlerts();
  // Fire-and-forget: push a Telegram notification if the alert state
  // changed (new failure or resolved). Never block the dashboard poll on
  // this -- it's a best-effort side channel, see lib/telegram-alerts.ts.
  checkAndNotifyTelegramAlerts(alerts).catch((err) => {
    console.error("[admin] telegram alert notify failed:", err);
  });
  return alerts;
}

/**
 * Full drill-down bundle for one user: profile + usage trend + model
 * breakdown + recent sessions. Admin-only. Returns null in `profile` if
 * the user doesn't exist (deleted account, bad id, etc.).
 */
export async function getAdminUserDetail(userId: string): Promise<{
  profile: AdminUserProfile | null;
  usageTrend: AdminUserUsageDayRow[];
  modelBreakdown: AdminUserModelRow[];
  sessions: AdminUserSessionRow[];
}> {
  await requireAdmin();

  const modelCostCatalog = await fetchAvailableLanguageModels().catch(() => []);

  const [profile, usageTrend, modelBreakdown, sessions] = await Promise.all([
    getAdminUserProfile(userId, modelCostCatalog),
    getAdminUserUsageTrend(userId, modelCostCatalog),
    getAdminUserModelBreakdown(userId, modelCostCatalog),
    getAdminUserSessions(userId),
  ]);

  return { profile, usageTrend, modelBreakdown, sessions };
}
