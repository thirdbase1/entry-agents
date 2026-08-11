import { z } from "zod";

export const MODEL_VARIANT_ID_PREFIX = "variant:";
export const BUILT_IN_VARIANT_ID_PREFIX = "variant:builtin:";
const MODEL_VARIANT_NAME_MAX_LENGTH = 80;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const modelVariantIdSchema = z
  .string()
  .trim()
  .min(1)
  .startsWith(MODEL_VARIANT_ID_PREFIX);

const modelVariantNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MODEL_VARIANT_NAME_MAX_LENGTH);

const baseModelIdSchema = z.string().trim().min(1);

export const providerOptionsSchema = z.record(z.string(), jsonValueSchema);

export const modelVariantSchema = z.object({
  id: modelVariantIdSchema,
  name: modelVariantNameSchema,
  baseModelId: baseModelIdSchema,
  providerOptions: providerOptionsSchema,
});

export const modelVariantsSchema = z.array(modelVariantSchema);

export type ModelVariant = z.infer<typeof modelVariantSchema>;

export const createModelVariantInputSchema = z.object({
  name: modelVariantNameSchema,
  baseModelId: baseModelIdSchema,
  providerOptions: providerOptionsSchema.default({}),
});

export const updateModelVariantInputSchema = z
  .object({
    id: modelVariantIdSchema,
    name: modelVariantNameSchema.optional(),
    baseModelId: baseModelIdSchema.optional(),
    providerOptions: providerOptionsSchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.baseModelId !== undefined ||
      input.providerOptions !== undefined,
    {
      message: "At least one field to update is required",
      path: ["id"],
    },
  );

export const deleteModelVariantInputSchema = z.object({
  id: modelVariantIdSchema,
});

export type ProviderOptionsByProvider = Record<
  string,
  Record<string, JsonValue>
>;

// All model calls in this app go through a single createOpenAI()-based
// client pointed at entry-gateway (see packages/agent/models.ts), regardless
// of which upstream model actually serves the request (Kimi K3, DeepSeek,
// Qwen, GPT-5.4, ...). The AI SDK's OpenAI provider always looks up its
// settings under the literal key "openai" in providerOptions -- NOT a key
// derived from the model id -- so every variant's providerOptions must be
// nested under "openai" no matter what the base model actually is. (This
// was a real bug: baseModelId.split("/")[0] produced keys like "kimi-k3"
// for flat reseller ids, which the SDK silently ignored -- reasoning
// effort overrides were never actually reaching the request.)
function withVariantProviderDefaults(
  providerOptions: Record<string, JsonValue>,
): Record<string, JsonValue> {
  // OpenAI Responses items are not persisted when store is false. Ensure
  // variants always carry the non-persistent setting so follow-up turns never
  // try to reference missing rs_* items. Harmless no-op for non-OpenAI
  // upstream models since entry-gateway ignores fields it doesn't recognize.
  return {
    ...providerOptions,
    store: false,
  };
}

export function toProviderOptionsByProvider(
  baseModelId: string,
  providerOptions: Record<string, JsonValue>,
): ProviderOptionsByProvider | undefined {
  if (!baseModelId) {
    return undefined;
  }

  const providerOptionsWithDefaults = withVariantProviderDefaults(providerOptions);
  if (Object.keys(providerOptionsWithDefaults).length === 0) {
    return undefined;
  }

  return {
    openai: providerOptionsWithDefaults,
  };
}

export interface ResolvedModelSelection {
  resolvedModelId: string;
  providerOptionsByProvider?: ProviderOptionsByProvider;
  isMissingVariant: boolean;
}

export function resolveModelSelection(
  selectedModelId: string,
  variants: ModelVariant[],
): ResolvedModelSelection {
  if (!selectedModelId.startsWith(MODEL_VARIANT_ID_PREFIX)) {
    return {
      resolvedModelId: selectedModelId,
      isMissingVariant: false,
    };
  }

  const variant = variants.find((item) => item.id === selectedModelId);
  if (!variant) {
    return {
      resolvedModelId: selectedModelId,
      isMissingVariant: true,
    };
  }

  return {
    resolvedModelId: variant.baseModelId,
    providerOptionsByProvider: toProviderOptionsByProvider(
      variant.baseModelId,
      variant.providerOptions,
    ),
    isMissingVariant: false,
  };
}

export function isBuiltInVariant(variantId: string): boolean {
  return variantId.startsWith(BUILT_IN_VARIANT_ID_PREFIX);
}

// Two real presets, each pinning a genuine tunable knob on a model that's
// actually live in entry-gateway's flat catalog (see MODEL_ROUTES_JSON --
// post Vercel-AI-Gateway -> Opencode-Zen swap, model ids are flat, e.g.
// "kimi-k3", "deepseek-v4-pro", not "provider/model"). Both use
// reasoningEffort: "high", which is a value both AI SDK's OpenAI-compatible
// enum (none/minimal/low/medium/high/xhigh) AND each upstream model's own
// native reasoning_effort docs accept, so it survives the SDK's strict
// provider-options schema without needing an unsupported passthrough value
// like "max".
// NOTE: kimi-k3 is deliberately NOT used for a built-in preset even though
// it's the RESTRICTED_MODEL_PREFIXES model in lib/model-access.ts (our
// priciest premium tier, gated for managed-trial sessions) -- it's
// *also* currently in lib/model-availability.ts's DISABLED_MODEL_IDS
// (Opencode Zen workspace has no payment method on file yet), so a
// built-in pinned to it would silently no-op back to the default model
// for every user, not just trial ones. Swap deepseek-v4-pro/glm-5.2 below
// for kimi-k3 once Opencode Zen billing is fixed and it's removed from
// DISABLED_MODEL_IDS.
export const BUILT_IN_VARIANTS: ModelVariant[] = [
  {
    id: `${BUILT_IN_VARIANT_ID_PREFIX}deepseek-v4-pro-high`,
    name: "DeepSeek V4 Pro (High Reasoning)",
    baseModelId: "deepseek-v4-pro",
    providerOptions: { reasoningEffort: "high" },
  },
  {
    id: `${BUILT_IN_VARIANT_ID_PREFIX}glm-5.2-high`,
    name: "GLM-5.2 (High Reasoning)",
    baseModelId: "glm-5.2",
    providerOptions: { reasoningEffort: "high" },
  },
];

/**
 * Combines built-in variants with user-defined variants.
 * Built-in variants appear first.
 */
export function getAllVariants(userVariants: ModelVariant[]): ModelVariant[] {
  return [...BUILT_IN_VARIANTS, ...userVariants];
}
