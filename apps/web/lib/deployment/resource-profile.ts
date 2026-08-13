export type EntryResourceProfile = "standard" | "hobby";

export function getEntryResourceProfile(): EntryResourceProfile {
  return process.env.ENTRY_RESOURCE_PROFILE === "hobby"
    ? "hobby"
    : "standard";
}

export function isHobbyResourceProfile(): boolean {
  return getEntryResourceProfile() === "hobby";
}
