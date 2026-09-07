import * as path from "path";
import { isPathWithinDirectory } from "./utils";

/**
 * Resolve a bash tool cwd without allowing the model to escape the sandbox
 * workspace. The public tool contract intentionally accepts only
 * workspace-relative directories.
 */
export function resolveBashWorkingDirectory(
  cwd: string | undefined,
  workingDirectory: string,
): string | null {
  if (!cwd) {
    return workingDirectory;
  }

  if (path.isAbsolute(cwd)) {
    return null;
  }

  const resolved = path.resolve(workingDirectory, cwd);
  return isPathWithinDirectory(resolved, workingDirectory) ? resolved : null;
}
