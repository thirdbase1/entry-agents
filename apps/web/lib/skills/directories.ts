import "server-only";

import path from "node:path";
import type { Sandbox } from "@entry/sandbox";
import { seedBuiltinSkills } from "@entry/agent";
import { resolveSandboxHomeDirectory } from "@/lib/sandbox/home-directory";

const PROJECT_SKILL_BASE_FOLDERS = [".claude", ".agents"];

export function getProjectSkillDirectories(workingDirectory: string): string[] {
  return PROJECT_SKILL_BASE_FOLDERS.map((folder) =>
    path.posix.join(workingDirectory, folder, "skills"),
  );
}

export function getGlobalSkillsDirectory(homeDirectory: string): string {
  return path.posix.join(homeDirectory, ".agents", "skills");
}

export async function getSandboxSkillDirectories(
  sandbox: Sandbox,
): Promise<string[]> {
  const homeDirectory = await resolveSandboxHomeDirectory(sandbox);
  const globalSkillsDirectory = getGlobalSkillsDirectory(homeDirectory);

  // Best-effort: make sure the curated built-in skills (browser automation,
  // no-API-key web search, ...) exist in every sandbox. Cheap no-op after the
  // first call for a given sandbox since seedBuiltinSkills skips skills that
  // are already present. Never let a seeding failure break skill discovery
  // for the rest of the session.
  try {
    await seedBuiltinSkills(sandbox, globalSkillsDirectory);
  } catch (error) {
    console.warn("[skills] Failed to seed built-in skills:", error);
  }

  return [
    ...getProjectSkillDirectories(sandbox.workingDirectory),
    globalSkillsDirectory,
  ];
}
