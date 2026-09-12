import { beforeEach, describe, expect, mock, test } from "bun:test";

// Regression test for the 2026-09 bug: getUserVercelToken /
// getUserVercelAuthInfo used to pass `headers: await headers()` into
// better-auth's getAccessToken. next/headers() only works inside a real
// Next.js request scope -- it throws when called from a durable Workflow
// "use step" function (exactly where vercel_cli/vercel_api call these),
// and that throw was silently swallowed by the surrounding try/catch, so
// every user looked "not connected" even after linking/logging in with
// Vercel. Mirrors apps/web/lib/github/token.test.ts, whose equivalent
// GitHub path never called headers() and never hit this bug.

let getAccessTokenResult: {
  accessToken?: string | null;
  accessTokenExpiresAt?: string | Date;
} | null;
let getAccessTokenError: Error | null;
let accountRows: { accountId: string }[];

const getAccessTokenSpy = mock(
  async (_input: { body: { providerId: string; userId: string } }) => {
    if (getAccessTokenError) {
      throw getAccessTokenError;
    }
    return getAccessTokenResult;
  },
);

mock.module("server-only", () => ({}));

mock.module("next/headers", () => ({
  headers: async () => {
    throw new Error(
      "headers should not be called -- there is no request scope inside a Workflow step",
    );
  },
}));

mock.module("@/lib/auth/config", () => ({
  auth: {
    api: {
      getAccessToken: getAccessTokenSpy,
    },
  },
}));

mock.module("@/lib/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => accountRows,
        }),
      }),
    }),
  },
}));

mock.module("@/lib/db/schema", () => ({
  accounts: {
    userId: "userId",
    providerId: "providerId",
    accountId: "accountId",
  },
}));

const tokenModulePromise = import("./token");

describe("getUserVercelToken", () => {
  beforeEach(() => {
    getAccessTokenSpy.mockClear();
    getAccessTokenResult = { accessToken: "vercel_test_token" };
    getAccessTokenError = null;
    accountRows = [{ accountId: "acct-1" }];
  });

  test("looks up access tokens by user id without request headers", async () => {
    const { getUserVercelToken } = await tokenModulePromise;

    const token = await getUserVercelToken("user-1");

    expect(token).toBe("vercel_test_token");
    expect(getAccessTokenSpy).toHaveBeenCalledTimes(1);
    expect(getAccessTokenSpy.mock.calls[0]?.[0]).toEqual({
      body: { providerId: "vercel", userId: "user-1" },
    });
  });

  test("returns null when better-auth token lookup fails, without throwing", async () => {
    const { getUserVercelToken } = await tokenModulePromise;
    getAccessTokenError = new Error("boom");

    const token = await getUserVercelToken("user-1");

    expect(token).toBeNull();
  });
});

describe("getUserVercelAuthInfo", () => {
  beforeEach(() => {
    getAccessTokenSpy.mockClear();
    getAccessTokenResult = {
      accessToken: "vercel_test_token",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    getAccessTokenError = null;
    accountRows = [{ accountId: "acct-1" }];
  });

  test("returns token + externalId for a genuinely linked account, without request headers", async () => {
    const { getUserVercelAuthInfo } = await tokenModulePromise;

    const info = await getUserVercelAuthInfo("user-1");

    expect(info).not.toBeNull();
    expect(info?.token).toBe("vercel_test_token");
    expect(info?.externalId).toBe("acct-1");
    expect(getAccessTokenSpy.mock.calls[0]?.[0]).toEqual({
      body: { providerId: "vercel", userId: "user-1" },
    });
  });

  test("returns null when better-auth has no access token, without throwing", async () => {
    const { getUserVercelAuthInfo } = await tokenModulePromise;
    getAccessTokenResult = { accessToken: null };

    const info = await getUserVercelAuthInfo("user-1");

    expect(info).toBeNull();
  });
});

describe("hasVercelAccountLinked", () => {
  test("true when an accounts row exists for providerId=vercel", async () => {
    const { hasVercelAccountLinked } = await tokenModulePromise;
    accountRows = [{ accountId: "acct-1" }];

    expect(await hasVercelAccountLinked("user-1")).toBe(true);
  });

  test("false when no accounts row exists", async () => {
    const { hasVercelAccountLinked } = await tokenModulePromise;
    accountRows = [];

    expect(await hasVercelAccountLinked("user-1")).toBe(false);
  });
});
