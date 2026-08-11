"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { buildModelOptions, type ModelOption } from "@/lib/model-options";
import type { AvailableModel } from "@/lib/models";
import { fetcher } from "@/lib/swr";

interface ModelsResponse {
  models: AvailableModel[];
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
    loading:
      initialModelOptions.length === 0 &&
      !hasCompleteFetchedData &&
      modelsLoading,
    error: modelsError?.message ?? null,
  };
}
