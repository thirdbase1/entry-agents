import { APP_DEFAULT_MODEL_ID } from "@/lib/models";

const DISABLED_OPENAI_GPT_PREFIX = "openai/gpt-";
const DISABLED_OPENAI_PRO_SUFFIX = "-pro";

// Owner standing instruction: hide any "Mythos" model entirely from the
// picker, regardless of which upstream provider routes it.
const DISABLED_NAME_SUBSTRINGS = ["mythos"];

export function isModelDisabled(modelId: string): boolean {
  const lowerId = modelId.toLowerCase();

  if (
    modelId.startsWith(DISABLED_OPENAI_GPT_PREFIX) &&
    modelId.endsWith(DISABLED_OPENAI_PRO_SUFFIX)
  ) {
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
