/**
 * Server-side integration route tests (Project-B / desktop-backend).
 *
 * Verifies: session auth required, provider validation, not_connected →
 * 404, revoked/expired refresh fail-closed, token only returned to the
 * authenticated desktop, disconnect removes the account row.
 *
 * DB + OAuth endpoints are exercised against a postgres.js mock; the
 * route module is imported directly.
 */
import { describe, expect, test } from "bun:test";

// ---- mock state ---------------------------------------------------------

let accounts: Array<Record<string, unknown>> = [];
let oauthCalls: Array<{ url: string; body: Record<string, string> }> = [];
let oauthResponse: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: { access_token: "fresh_token", expires_in: 3600, scope: "repo" },
};

// postgres template-tag mock
const sqlMock = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (/SELECT [\s\S]* FROM accounts/i.test(text)) {
      const userId = values[0];
      const provider = values[1];
      return accounts.filter((a) => a.user_id === userId && a.provider_id === provider);
    }
    if (/UPDATE accounts/i.test(text)) {
      const accessToken = values[0];
      const expiresAt = values[1];
      const scope = values[2];
      const userId = values[3];
      const provider = values[4];
      for (const a of accounts) {
        if (a.user_id === userId && a.provider_id === provider) {
          a.access_token = accessToken;
          a.access_token_expires_at = expiresAt;
          if (scope) a.scope = scope;
        }
      }
      return [];
    }
    if (/DELETE FROM accounts/i.test(text)) {
      const userId = values[0];
      const provider = values[1];
      accounts = accounts.filter((a) => !(a.user_id === userId && a.provider_id === provider));
      return [];
    }
    return [];
  },
  {},
);

// module mocks BEFORE importing the route
const { mock } = await import("bun:test");
mock.module("@/lib/sql", () => ({ getSql: () => sqlMock }));

process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID = "gh_client";
process.env.GITHUB_CLIENT_SECRET = "gh_secret";
process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID = "vc_client";
process.env.VERCEL_APP_CLIENT_SECRET = "vc_secret";

// global fetch capture for provider token refresh
const REAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = (async (url: string | URL, init?: RequestInit) => {
  const text = String(url);
  if (text.includes("access_token") || text.includes("github.com/login/oauth") || text.includes("vercel.com")) {
    const body: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(String(init?.body ?? ""))) body[k] = v;
    oauthCalls.push({ url: text, body });
    return new Response(JSON.stringify(oauthResponse.body), { status: oauthResponse.status });
  }
  return REAL_FETCH(url as never, init);
}) as typeof fetch;

// auth mock: user controlled by variable
let mockUser: { id: string; email: string } | null = { id: "user-1", email: "t@x.dev" };
mock.module("@/lib/auth", () => ({
  requireDesktopUser: async () => mockUser,
  unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}));

const { GET, POST, DELETE } = await import("./route.js");

function req(method: string, body?: unknown): Request {
  return new Request("https://b.test/api/desktop/integrations", {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  }) as never;
}

function reset(): void {
  accounts = [];
  oauthCalls = [];
  oauthResponse = { status: 200, body: { access_token: "fresh_token", expires_in: 3600, scope: "repo" } };
  mockUser = { id: "user-1", email: "t@x.dev" };
}

// ---- tests ---------------------------------------------------------------

describe("integrations route — auth", () => {
  test("401 without a valid desktop session", async () => {
    reset();
    mockUser = null;
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
  });
});

describe("integrations route — status", () => {
  test("reports connected + disconnected providers", async () => {
    reset();
    accounts = [
      { user_id: "user-1", provider_id: "github", account_id: "octo-1", access_token: "tok", refresh_token: null, access_token_expires_at: null, scope: "repo" },
    ];
    const res = await GET(req("GET"));
    const data = (await res.json()) as { integrations: Array<{ provider: string; connected: boolean; accountLogin: string | null }> };
    const gh = data.integrations.find((i) => i.provider === "github")!;
    const vc = data.integrations.find((i) => i.provider === "vercel")!;
    expect(gh.connected).toBe(true);
    expect(gh.accountLogin).toBe("octo-1");
    expect(vc.connected).toBe(false);
    expect(JSON.stringify(data)).not.toContain("tok");
  });
});

describe("integrations route — token minting", () => {
  test("valid provider token returned for a live connection", async () => {
    reset();
    accounts = [
      { user_id: "user-1", provider_id: "github", account_id: "octo-1", access_token: "live_gh", refresh_token: null, access_token_expires_at: null, scope: "repo" },
    ];
    const res = await POST(req("POST", { provider: "github" }));
    const data = (await res.json()) as { token?: string };
    expect(data.token).toBe("live_gh");
  });

  test("invalid provider rejected", async () => {
    reset();
    const res = await POST(req("POST", { provider: "gitlab" }));
    expect(res.status).toBe(400);
  });

  test("not_connected → 404", async () => {
    reset();
    const res = await POST(req("POST", { provider: "vercel" }));
    expect(res.status).toBe(404);
  });

  test("expired token triggers server-side refresh and persists result", async () => {
    reset();
    accounts = [
      { user_id: "user-1", provider_id: "github", account_id: "octo-1", access_token: "expired", refresh_token: "rt", access_token_expires_at: new Date(Date.now() - 60_000), scope: "repo" },
    ];
    const res = await POST(req("POST", { provider: "github" }));
    const data = (await res.json()) as { token?: string };
    expect(data.token).toBe("fresh_token");
    expect(oauthCalls.length).toBe(1);
    expect(oauthCalls[0].body.refresh_token).toBe("rt");
    expect(oauthCalls[0].body.client_secret).toBe("gh_secret");
    expect(accounts[0].access_token).toBe("fresh_token");
  });

  test("revoked refresh (provider rejects) fails closed with 401", async () => {
    reset();
    oauthResponse = { status: 400, body: { error: "bad_refresh_token" } };
    accounts = [
      { user_id: "user-1", provider_id: "vercel", account_id: "v1", access_token: null, refresh_token: "rt", access_token_expires_at: null, scope: null },
    ];
    const res = await POST(req("POST", { provider: "vercel" }));
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe("revoked");
  });

  test("expired token without refresh token → reconnected_required", async () => {
    reset();
    accounts = [
      { user_id: "user-1", provider_id: "github", account_id: "g", access_token: "expired", refresh_token: null, access_token_expires_at: new Date(Date.now() - 60_000), scope: null },
    ];
    const res = await POST(req("POST", { provider: "github" }));
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe("reconnected_required");
  });
});

describe("integrations route — disconnect", () => {
  test("removes the account row", async () => {
    reset();
    accounts = [
      { user_id: "user-1", provider_id: "github", account_id: "g", access_token: "t" },
    ];
    const res = await DELETE(req("DELETE", { provider: "github" }));
    const data = (await res.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);
    expect(accounts.length).toBe(0);
  });
});
