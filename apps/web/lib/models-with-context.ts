import "server-only";

import { fetch as workflowFetch } from "workflow";
import { z } from "zod";
import { filterDisabledModels } from "./model-availability";
import type {
  AvailableModel,
  AvailableModelCost,
  AvailableModelCostTier,
  GatewayAvailableModel,
} from "./models";

// Kept for the (currently unused, best-effort) models.dev context-window
// enrichment below -- harmless no-op for our static catalog since none of
// our model IDs match models.dev's namespacing, but left in place in case
// Opencode Zen model IDs ever get added there.
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 750;

type GatewayModel = GatewayAvailableModel;

interface ModelsDevMetadata {
  contextWindow?: number;
  cost?: AvailableModelCost;
}

const recordSchema = z.object({}).catchall(z.unknown());

const modelsDevLimitSchema = z
  .object({
    context: z.number().finite().positive().optional(),
  })
  .passthrough();

const modelsDevCostTierSchema = z
  .object({
    input: z.number().finite().optional(),
    output: z.number().finite().optional(),
    cache_read: z.number().finite().optional(),
  })
  .passthrough();

function getModelsDevCostTier(
  value: unknown,
): AvailableModelCostTier | undefined {
  const parsed = modelsDevCostTierSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }

  const { input, output, cache_read } = parsed.data;
  if (input === undefined && output === undefined && cache_read === undefined) {
    return undefined;
  }

  return {
    input,
    output,
    cache_read,
  };
}

function getModelsDevCost(value: unknown): AvailableModelCost | undefined {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }

  const baseCost = getModelsDevCostTier(parsed.data);
  const contextOver200k = getModelsDevCostTier(parsed.data.context_over_200k);

  if (!baseCost && !contextOver200k) {
    return undefined;
  }

  return {
    ...baseCost,
    ...(contextOver200k ? { context_over_200k: contextOver200k } : {}),
  };
}

function getModelsDevMetadataMap(
  data: unknown,
): Map<string, ModelsDevMetadata> {
  const metadataMap = new Map<string, ModelsDevMetadata>();
  const providers = recordSchema.safeParse(data);
  if (!providers.success) {
    return metadataMap;
  }

  for (const [providerKey, providerValue] of Object.entries(providers.data)) {
    const provider = recordSchema.safeParse(providerValue);
    if (!provider.success) {
      continue;
    }

    const models = recordSchema.safeParse(provider.data.models);
    if (!models.success) {
      continue;
    }

    for (const [modelKey, modelValue] of Object.entries(models.data)) {
      const model = recordSchema.safeParse(modelValue);
      if (!model.success) {
        continue;
      }

      const parsedId = z.string().safeParse(model.data.id);
      const rawId = parsedId.success ? parsedId.data : modelKey;
      const modelId = rawId.includes("/") ? rawId : `${providerKey}/${rawId}`;

      const parsedLimit = modelsDevLimitSchema.safeParse(model.data.limit);
      const contextWindow = parsedLimit.success
        ? parsedLimit.data.context
        : undefined;
      const cost = getModelsDevCost(model.data.cost);

      if (contextWindow === undefined && cost === undefined) {
        continue;
      }

      metadataMap.set(modelId, {
        contextWindow,
        cost,
      });
    }
  }

  return metadataMap;
}

async function fetchModelsDevMetadataMap(): Promise<
  Map<string, ModelsDevMetadata>
> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);

  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return new Map();
    }
    const data: unknown = await response.json();
    return getModelsDevMetadataMap(data);
  } catch {
    return new Map();
  } finally {
    clearTimeout(timeoutId);
  }
}

function addModelsDevMetadata(
  model: GatewayModel,
  metadataMap: Map<string, ModelsDevMetadata>,
): AvailableModel {
  const metadata = metadataMap.get(model.id);
  if (!metadata) {
    return applyFallbackCachePricing(model);
  }

  const nextModel: AvailableModel = { ...model };

  if (
    typeof metadata.contextWindow === "number" &&
    metadata.contextWindow > 0
  ) {
    nextModel.context_window = metadata.contextWindow;
  }

  if (metadata.cost) {
    nextModel.cost = metadata.cost;
  }

  return applyFallbackCachePricing(nextModel);
}

/**
 * Mirrors the CACHE_RATE_MULTIPLIERS_BY_PREFIX fallback in the gateway's
 * server.js (added 2026-08-17, see that file for the full rationale and
 * pricing-ratio sourcing) -- purely so the UI's cost pill/estimate
 * matches what the gateway will actually bill. gpt-5.6-sol/terra/luna's
 * routes don't have cost.cache_read/cache_write set in the gateway's own
 * config, so without this the picker/composer would display an inflated
 * estimate (full input rate on cached tokens) even though the gateway
 * itself already applies the discount when computing the real charge.
 * Only fills in the two fields when they're genuinely absent -- any
 * route with real configured rates (e.g. Claude's) passes through
 * unchanged.
 *
 * Ratios sourced from OpenAI's own published gpt-5.6-sol pricing ($5.00
 * input / $0.50 cached input / $6.25 cache write / $30.00 output --
 * 0.50/5.00 = 0.1x, 6.25/5.00 = 1.25x), independently corroborated on
 * the OpenAI community forum for gpt-5.6-luna post price-cut ("1.25x for
 * write cache and 0.1x for read cache"). See gateway server.js for the
 * matching fallback used for real billing.
 */
const CACHE_RATE_MULTIPLIERS_BY_PREFIX: Array<
  [string, { cacheRead: number; cacheWrite: number }]
> = [["gpt-5.6-", { cacheRead: 0.1, cacheWrite: 1.25 }]];

function applyFallbackCachePricing(model: AvailableModel): AvailableModel {
  const cost = model.cost;
  if (!cost || typeof cost.input !== "number") {
    return model;
  }
  if (
    typeof cost.cache_read === "number" &&
    typeof cost.cache_write === "number"
  ) {
    return model;
  }

  const multipliers = CACHE_RATE_MULTIPLIERS_BY_PREFIX.find(([prefix]) =>
    model.id.startsWith(prefix),
  )?.[1];
  if (!multipliers) {
    return model;
  }

  return {
    ...model,
    cost: {
      ...cost,
      cache_read: cost.cache_read ?? cost.input * multipliers.cacheRead,
      cache_write: cost.cache_write ?? cost.input * multipliers.cacheWrite,
    },
  };
}

const gatewayModelsResponseSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string(),
        name: z.string().optional(),
        description: z.string().nullish(),
        modelType: z.string().nullish(),
        context_window: z.number().finite().positive().optional(),
        cost: z
          .object({
            input: z.number().finite().optional(),
            output: z.number().finite().optional(),
            cache_read: z.number().finite().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  ),
});

/**
 * Fetches the live model list from Entry's self-hosted gateway
 * (entry-gateway, deployed on Vercel). This is intentionally a live network call, not a
 * hardcoded catalog -- adding/removing a model is a config change on the
 * gateway (GATEWAY env vars in its own dashboard), and this app picks it
 * up automatically on the next fetch, no redeploy needed.
 */
async function fetchGatewayModels(): Promise<GatewayModel[]> {
  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;

  if (!baseURL || !apiKey) {
    throw new Error(
      "GATEWAY_BASE_URL / GATEWAY_API_KEY must be set to fetch the model list from Entry's self-hosted gateway.",
    );
  }

  // NOTE: deliberately no `next: { revalidate }` cache option here. That
  // Next.js-specific fetch directive only works inside a request-scoped
  // Next.js execution context (route handlers). The Vercel Workflow SDK's
  // "use workflow"/"use step" durable-execution context is NOT a normal
  // per-request Next.js context, so passing it there causes this fetch to
  // throw -- which upstream callers (chat.ts) caught with a bare
  // `.catch(() => [])`, silently emptying the pricing catalog on every
  // real chat turn while the same function worked fine when called from
  // /api/models (a plain route handler). That was the root cause of the
  // per-turn cost pill never showing anything in production. Model list
  // changes rarely enough that fetching it fresh each call is fine.
  // Use the Workflow SDK's hoisted `fetch` step, not global `fetch` --
  // this function is called from inside `runAgentWorkflow` ("use workflow"),
  // where global fetch throws ("Global fetch is unavailable in workflow
  // functions"). The workflow-step fetch is a safe drop-in outside of a
  // workflow context too (it's a no-op wrapper around globalThis.fetch when
  // there's no active workflow run), so this one import works for both the
  // plain /api/models route handler and the workflow call site.
  const response = await workflowFetch(`${baseURL.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models from gateway (${response.status}): ${await response.text()}`,
    );
  }

  const parsed = gatewayModelsResponseSchema.parse(await response.json());
  return parsed.data.map((model) => ({
    ...model,
    modelType: model.modelType ?? "language",
    name: model.name ?? model.id,
  }));
}

export async function fetchAvailableLanguageModels(): Promise<
  AvailableModel[]
> {
  const models = await fetchGatewayModels();
  return filterDisabledModels(
    models.filter((model) => model.modelType === "language"),
  );
}

/**
 * Pricing-only catalog: every language model the gateway knows about,
 * INCLUDING ones an admin has disabled (or that are hard-blocked in
 * code). Deliberately skips filterDisabledModels.
 *
 * FIXED 2026-08-17: usage/spend reporting (admin platform overview, admin
 * user profile, and the user-facing /settings/profile usage page) was
 * pricing already-recorded usage_events rows against
 * fetchAvailableLanguageModels()'s filtered catalog. That catalog drops
 * any model an admin has since disabled -- so costForModel() returned
 * undefined for that model's historical rows, and those dollars silently
 * vanished from the displayed total (hasUnpricedUsage flips true instead
 * of the real cost being summed). Reported case: a user's real all-time
 * spend was ~$600 across qwen3.8-max, an Opus model, and others; once an
 * admin disabled a couple of those models the same profile page dropped
 * to ~$200, because usage against the now-disabled models stopped being
 * priced -- even though it had already happened and was already billed
 * (the credit ledger's debitUsage was never touched, only this read-time
 * display estimate). Disabling a model should only stop *new* usage; it
 * must never retroactively re-price or hide usage that already
 * happened. Every cost-lookup call site should use this function, not
 * fetchAvailableLanguageModels(), which stays reserved for
 * picker/availability checks (what a user is allowed to select *now*).
 */
export async function fetchModelCostCatalog(): Promise<AvailableModel[]> {
  const models = await fetchGatewayModels();
  return models.filter((model) => model.modelType === "language");
}

export async function fetchAvailableLanguageModelsWithContext(): Promise<
  AvailableModel[]
> {
  const [models, modelsDevMetadataMap] = await Promise.all([
    fetchAvailableLanguageModels(),
    fetchModelsDevMetadataMap(),
  ]);

  return models.map((model) =>
    addModelsDevMetadata(model, modelsDevMetadataMap),
  );
}

/**
 * Every language model the gateway knows about, unfiltered by disabled
 * status -- for the admin models page (settings/admin/models), which
 * needs to show (and let an admin re-enable) models that are currently
 * hidden from the regular picker.
 */
export async function fetchAllLanguageModelsForAdmin(): Promise<
  AvailableModel[]
> {
  const [models, modelsDevMetadataMap] = await Promise.all([
    fetchGatewayModels(),
    fetchModelsDevMetadataMap(),
  ]);

  return models
    .filter((model) => model.modelType === "language")
    .map((model) => addModelsDevMetadata(model, modelsDevMetadataMap));
}
