import {
  APP_DEFAULT_MODEL_ID,
  type AvailableModel,
  type AvailableModelCost,
  getModelDisplayName,
} from "@/lib/models";
import {
  getProviderFromModelId,
  stripProviderPrefix,
} from "@/components/provider-icons";

export interface ModelOption {
  id: string;
  label: string;
  shortLabel: string;
  description?: string;
  contextWindow?: number;
  cost?: AvailableModelCost;
  provider: string;
}

function toBaseModelOption(model: AvailableModel): ModelOption {
  const label = getModelDisplayName(model);
  const provider = getProviderFromModelId(model.id);
  return {
    id: model.id,
    label,
    shortLabel: stripProviderPrefix(label, provider),
    description: model.description ?? undefined,
    contextWindow: model.context_window,
    ...(model.cost ? { cost: model.cost } : {}),
    provider,
  };
}

/** Providers pinned to the top of the list, in order. */
const PRIORITY_PROVIDERS = ["anthropic", "openai"];

export interface ModelGroup {
  provider: string;
  label: string;
  options: ModelOption[];
}

/**
 * Group options by provider, sort groups (priority first, then alphabetical).
 */
export function groupByProvider(options: ModelOption[]): ModelGroup[] {
  const groups: Record<string, ModelOption[]> = {};
  const providers: string[] = [];
  for (const option of options) {
    const { provider } = option;
    if (!groups[provider]) {
      groups[provider] = [];
      providers.push(provider);
    }
    groups[provider].push(option);
  }

  // Sort: priority providers first (in order), then rest alphabetically
  providers.sort((a, b) => {
    const aIdx = PRIORITY_PROVIDERS.indexOf(a);
    const bIdx = PRIORITY_PROVIDERS.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });

  return providers.map((provider) => ({
    provider,
    label: provider,
    options: groups[provider],
  }));
}

export function buildModelOptions(models: AvailableModel[]): ModelOption[] {
  return models.map(toBaseModelOption);
}

export function buildSessionChatModelOptions(
  models: AvailableModel[],
): ModelOption[] {
  return buildModelOptions(models);
}

export function withMissingModelOption(
  modelOptions: ModelOption[],
  modelId: string | null | undefined,
): ModelOption[] {
  if (!modelId || modelOptions.some((option) => option.id === modelId)) {
    return modelOptions;
  }

  return [
    ...modelOptions,
    {
      id: modelId,
      label: `${modelId} (unavailable)`,
      shortLabel: `${modelId} (unavailable)`,
      description: "Model no longer available",
      contextWindow: undefined,
      provider: "unknown",
    },
  ];
}

export function getDefaultModelOptionId(modelOptions: ModelOption[]): string {
  if (modelOptions.some((option) => option.id === APP_DEFAULT_MODEL_ID)) {
    return APP_DEFAULT_MODEL_ID;
  }

  return modelOptions[0]?.id ?? APP_DEFAULT_MODEL_ID;
}
