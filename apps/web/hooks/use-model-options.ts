"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { buildModelOptions, type ModelOption } from "@/lib/model-options";
import type { AvailableModel } from "@/lib/models";
import { fetcher } from "@/lib/swr";

/** Mirrors the shape returned by GET /api/models when the free-tier kill
 * switch is off for this (non-admin) user. `null` means either the gate
 * is on, or the user is an admin -- the API always sends null for admins
 * so their UI never changes. */
export interface FreeTierGateStatus {
  enabled: false;
  reason: string | null;
}

interface ModelsResponse {
  models: AvailableModel[];
  freeTierGate?: FreeTierGateStatus | null;
}

interface UseModelOptionsConfig {
  initialModelOptions?: ModelOption[];
}

const EMPTY_MODELS: AvailableModel[] = [];
const EMPTY_MODEL_OPTIONS: ModelOption[] = [];

export function useModelOptions(config: UseModelOptionsConfig = {}) {
  const {
    data: modelsData,
    error: modelsError,
    isLoading: modelsLoading,
  } = useSWR<ModelsResponse>("/api/models", fetcher);

  const models = modelsData?.models ?? EMPTY_MODELS;
  const initialModelOptions = config.initialModelOptions ?? EMPTY_MODEL_OPTIONS;
  const hasCompleteFetchedData = modelsData !== undefined;

  const fetchedModelOptions = useMemo<ModelOption[]>(
    () => buildModelOptions(models),
    [models],
  );

  const modelOptions =
    hasCompleteFetchedData || initialModelOptions.length === 0
      ? fetchedModelOptions
      : initialModelOptions;

  return {
    modelOptions,
    models,
    // Proactive UX signal only -- the real enforcement lives server-side
    // in resolveChatModelRuntime/startStopMonitor. Defaults to null while
    // loading so the composer never flashes a false-positive block.
    freeTierGate: modelsData?.freeTierGate ?? null,
    loading:
      initialModelOptions.length === 0 &&
      !hasCompleteFetchedData &&
      modelsLoading,
    error: modelsError?.message ?? null,
  };
}
