/**
 * Theme preference storage.
 *
 * Renamed from `open-agents-theme` (the pre-rename product name) to
 * `entry-theme`. The old key is still read once and migrated so nobody
 * silently loses a light/dark choice they already made.
 */
export const THEME_STORAGE_KEY = "entry-theme";
export const LEGACY_THEME_STORAGE_KEY = "open-agents-theme";

export type ThemePreference = "light" | "dark" | "system";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Read the stored preference, adopting (and then dropping) the legacy key
 * on first run. Client-only: touches localStorage.
 */
export function readStoredTheme(): string | null {
  const current = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (current !== null) {
    return current;
  }

  const legacy = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (legacy === null) {
    return null;
  }

  window.localStorage.setItem(THEME_STORAGE_KEY, legacy);
  window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
  return legacy;
}
