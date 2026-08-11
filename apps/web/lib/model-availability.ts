import { APP_DEFAULT_MODEL_ID } from "@/lib/models";

const DISABLED_OPENAI_GPT_PREFIX = "openai/gpt-";
const DISABLED_OPENAI_PRO_SUFFIX = "-pro";

// Owner standing instruction: hide any "Mythos" model entirely from the
// picker, regardless of which upstream provider routes it.
const DISABLED_NAME_SUBSTRINGS = ["mythos"];

// kimi-k3 and grok-4.5 are routed via Opencode Zen but that workspace has
// no payment method on file, so real requests to either one fail with a
// CreditsError. Hidden from the picker until billing is fixed upstream --
// remove from this list (or just delete the list) once that's resolved.
// (Both are correctly priced in entry-gateway's MODEL_ROUTES_JSON already,
// using Zen's own published rate card, so no further pricing work is
// needed once billing is fixed -- just delete them from this list.)
const DISABLED_MODEL_IDS = ["kimi-k3", "grok-4.5"];

export function isModelDisabled(modelId: string): boolean {
  const lowerId = modelId.toLowerCase();

  if (
    modelId.startsWith(DISABLED_OPENAI_GPT_PREFIX) &&
    modelId.endsWith(DISABLED_OPENAI_PRO_SUFFIX)
  ) {
    return true;
  }

  if (DISABLED_MODEL_IDS.includes(modelId)) {
    return true;
  }

  return DISABLED_NAME_SUBSTRINGS.some((substring) =>
    lowerId.includes(substring),
  );
}

export function filterDisabledModels<T extends { id: string }>(
  models: T[],
): T[] {
  return models.filter((model) => !isModelDisabled(model.id));
}

export function resolveAvailableModelId(modelId: string): string {
  if (isModelDisabled(modelId)) {
    return APP_DEFAULT_MODEL_ID;
  }

  return modelId;
}
