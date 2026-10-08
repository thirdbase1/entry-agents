import type { UserPreferencesData } from "@/lib/db/user-preferences";
import type { Session } from "@/lib/session/types";

type SessionLike = Pick<Session, "authProvider" | "user"> | null | undefined;

export function isRestrictedModelIdForSession(
  _modelId: string,
  _session: SessionLike,
  _url: string | URL,
): boolean {
  return false;
}

export function filterModelsForSession<T extends { id: string }>(
  models: T[],
  _session: SessionLike,
  _url: string | URL,
): T[] {
  return models;
}

export function sanitizeSelectedModelIdForSession(
  modelId: string | null | undefined,
  _session: SessionLike,
  _url: string | URL,
): string | null | undefined {
  return modelId;
}

export function sanitizeUserPreferencesForSession(
  preferences: UserPreferencesData,
  _session: SessionLike,
  _url: string | URL,
): UserPreferencesData {
  return preferences;
}
