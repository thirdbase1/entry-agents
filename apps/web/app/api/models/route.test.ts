import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MockGatewayModel extends Record<string, unknown> {
  id: string;
  name?: string;
  description?: string | null;
  modelType: string;
  context_window?: number;
}

const gatewayModels: MockGatewayModel[] = [];
const requestedUrls: string[] = [];

let gatewayError: unknown = null;
let modelsDevApiData: unknown = {};
let currentSession: {
  authProvider?: "vercel" | "github";
  user: { id: string; email?: string; username?: string; avatar?: string };
} | null = null;

const originalFetch = globalThis.fetch;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

mock.module("server-only", () => ({}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => currentSession,
}));

// The route + fetchAvailableLanguageModelsWithContext also touch billing
// / admin / free-tier-gate DB reads on every call (added by the billing
// feature after this test file was last updated -- see chat.test.ts's
// equivalent gap, same root cause). Defaults: non-admin, free-tier gate
// open, paid plan with balance, so none of the gating branches fire and
// every test's plain model-list assertions are unaffected. Only the
// "hides Claude Opus" test actually has a logged-in user, so only that
// one exercises the real isUserAdmin/getUserBillingState calls.
mock.module("@/lib/db/users", () => ({
  isUserAdmin: mock(() => Promise.resolve(false)),
}));
mock.module("@/lib/db/platform-settings", () => ({
  getFreeTierGateStatus: mock(() =>
    Promise.resolve({ enabled: true, reason: null }),
  ),
}));
mock.module("@/lib/billing/credit-ledger", () => ({
  getUserBillingState: mock(() =>
    Promise.resolve({
      plan: "pro",
      creditBalanceCents: 100_000,
      billingCycleAnchor: null,
      paystackCustomerCode: null,
      paystackSubscriptionCode: null,
    }),
  ),
}));
// filterDisabledModels/isModelDisabled (real logic, kept as-is) both
// read the admin kill-switch table through this leaf -- mocked to "no
// admin overrides" so real filtering logic still runs, just without a
// live DB.
mock.module("@/lib/db/model-overrides", () => ({
  getDisabledModelIdSet: mock(() => Promise.resolve(new Set<string>())),
}));

const originalGatewayBaseUrl = process.env.GATEWAY_BASE_URL;
const originalGatewayApiKey = process.env.GATEWAY_API_KEY;
const GATEWAY_BASE_URL = "https://entry-gateway.test";

const routeModulePromise = import("./route");

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GATEWAY_BASE_URL = originalGatewayBaseUrl;
  process.env.GATEWAY_API_KEY = originalGatewayApiKey;
});

describe("/api/models context window enrichment", () => {
  beforeEach(() => {
    gatewayModels.length = 0;
    requestedUrls.length = 0;
    gatewayError = null;
    modelsDevApiData = {};
    currentSession = null;
    process.env.GATEWAY_BASE_URL = GATEWAY_BASE_URL;
    process.env.GATEWAY_API_KEY = "test-gateway-key";

    globalThis.fetch = mock((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = getRequestUrl(input);
      requestedUrls.push(url);

      if (url === `${GATEWAY_BASE_URL}/models`) {
        if (gatewayError) {
          return Promise.resolve(
            new Response(JSON.stringify(gatewayError), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: gatewayModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify(modelsDevApiData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  });

  test("overrides gateway context windows from models.dev", async () => {
    gatewayModels.push(
      {
        id: "openai/gpt-5.3-codex",
        modelType: "language",
        context_window: 200_000,
      },
      {
        id: "anthropic/claude-opus-4.6",
        modelType: "language",
        context_window: 200_000,
      },
      {
        id: "openai/gpt-4o-mini",
        modelType: "language",
        context_window: 128_000,
      },
      {
        id: "openai/image-gen",
        modelType: "image",
        context_window: 200_000,
      },
    );

    modelsDevApiData = {
      openai: {
        models: {
          "gpt-5.3-codex": {
            limit: { context: 400_000 },
          },
        },
      },
      anthropic: {
        models: {
          "claude-opus-4.6": {
            limit: { context: 1_000_000 },
          },
        },
      },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(new Request("http://localhost/api/models"));

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      models: Array<{ id: string; context_window?: number }>;
    };
    const contextById = new Map(
      body.models.map((model) => [model.id, model.context_window]),
    );

    expect(contextById.get("openai/gpt-5.3-codex")).toBe(400_000);
    expect(contextById.get("anthropic/claude-opus-4.6")).toBe(1_000_000);
    expect(contextById.get("openai/gpt-4o-mini")).toBe(128_000);
    expect(contextById.has("openai/image-gen")).toBe(false);
    expect(requestedUrls).toContain("https://models.dev/api.json");
  });

  // Renamed 2026-08-20: the restricted model in the hosted demo changed
  // from Claude Opus to kimi-k3 when the app moved off the Vercel AI
  // Gateway onto entry-gateway (see RESTRICTED_MODEL_PREFIXES's comment
  // in lib/model-access.ts) -- this test still asserted the old model
  // id and always failed post-migration.
  test("hides kimi-k3 models for managed trial users", async () => {
    gatewayModels.push(
      {
        id: "kimi-k3",
        modelType: "language",
      },
      {
        id: "anthropic/claude-haiku-4.5",
        modelType: "language",
      },
    );
    currentSession = {
      authProvider: "vercel",
      user: { id: "user-1", email: "person@example.com" },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(
      new Request("https://open-agents.dev/api/models"),
    );
    const body = (await response.json()) as {
      models: Array<{ id: string }>;
    };

    expect(body.models.map((model) => model.id)).toEqual([
      "anthropic/claude-haiku-4.5",
    ]);
  });

  test("keeps gateway context window when models.dev only has related ids", async () => {
    gatewayModels.push({
      id: "openai/gpt-5.3-codex-2026-02-15",
      modelType: "language",
      context_window: 200_000,
    });

    modelsDevApiData = {
      openai: {
        models: {
          "gpt-5": {
            limit: { context: 272_000 },
          },
          "gpt-5.3-codex": {
            limit: { context: 400_000 },
          },
        },
      },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(new Request("http://localhost/api/models"));

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      models: Array<{ id: string; context_window?: number }>;
    };

    expect(body.models).toHaveLength(1);
    expect(body.models[0]?.context_window).toBe(200_000);
  });

  test("keeps valid models.dev metadata when sibling fields are invalid", async () => {
    gatewayModels.push({
      id: "openai/gpt-5.3-codex",
      modelType: "language",
      context_window: 200_000,
    });

    modelsDevApiData = {
      invalidProvider: "bad",
      openai: {
        models: {
          "gpt-5.3-codex": {
            limit: { context: "400_000" },
            cost: {
              input: 1.25,
              output: 10,
              context_over_200k: {
                input: 2.5,
              },
            },
          },
          broken: {
            limit: { context: "not-a-number" },
            cost: { input: "expensive" },
          },
        },
      },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(new Request("http://localhost/api/models"));

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      models: Array<{
        id: string;
        context_window?: number;
        cost?: {
          input?: number;
          output?: number;
          context_over_200k?: {
            input?: number;
          };
        };
      }>;
    };

    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      id: "openai/gpt-5.3-codex",
      context_window: 200_000,
      cost: {
        input: 1.25,
        output: 10,
        context_over_200k: {
          input: 2.5,
        },
      },
    });
  });

  // SKIPPED 2026-08-20: this test targets a partial-recovery behavior
  // ("one malformed model among valid ones shouldn't fail the whole
  // list") that belonged to the old Vercel AI Gateway SDK
  // (`ai`'s `gateway.getAvailableModels()` used to throw an error object
  // carrying `.response.models` as a best-effort raw list on validation
  // failure -- app code caught that shape to recover). Confirmed via
  // code read: fetchGatewayModels() in lib/models-with-context.ts (the
  // self-hosted-gateway implementation that replaced the AI SDK gateway,
  // see the "Opencode Zen" migration) has no such recovery path --
  // gatewayModelsResponseSchema.parse() either succeeds for the whole
  // response or throws, and a non-2xx HTTP response throws a plain
  // Error with no per-item fallback. Re-enabling this test as-is would
  // require adding that recovery logic for real, which is a product
  // decision (is silently dropping one bad model entry from the picker
  // desirable, or should a malformed gateway response fail loud?) --
  // not something to sneak in as a side effect of a test-mock fix.
  // Flagged to the owner as an open follow-up; not implemented here.
  test.skip("recovers from gateway validation errors when response still includes models", async () => {
    gatewayError = {
      response: {
        models: [
          {
            id: "openai/gpt-5.4",
            name: "GPT 5.4",
            description: "Latest GPT model",
            modelType: "language",
          },
          {
            id: "openai/gpt-5.4-broken",
            modelType: "language",
          },
          {
            id: "cohere/rerank-v3.5",
            name: "Cohere Rerank 3.5",
            description: "Reranking model",
            modelType: "reranking",
          },
        ],
      },
    };

    const { GET } = await routeModulePromise;
    const response = await GET(new Request("http://localhost/api/models"));

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      models: Array<{
        id: string;
        name: string;
        description?: string | null;
        modelType?: string;
      }>;
    };

    expect(body.models).toEqual([
      {
        id: "openai/gpt-5.4",
        name: "GPT 5.4",
        description: "Latest GPT model",
        modelType: "language",
      },
    ]);
  });
});
