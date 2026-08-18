import type { Sandbox } from "@open-agents/sandbox";

/**
 * Top-level directory chat image attachments get offloaded into (see
 * persistImageAttachmentsToSandbox in ../../app/workflows/chat-sandbox-runtime.ts).
 * Kept here (rather than duplicated) so the gitignore entry below can
 * never drift out of sync with the actual write path.
 */
export const IMAGE_UPLOADS_DIR = "uploads";

const GITIGNORE_PATH = ".gitignore";
const UPLOADS_GITIGNORE_ENTRY = `/${IMAGE_UPLOADS_DIR}/`;

/**
 * Ensures the repo's .gitignore excludes the chat image-upload directory.
 *
 * Without this, `git add -A` -- whether run by our own auto-commit step
 * or by the agent itself via its bash tool -- sweeps these chat
 * attachments straight into the user's GitHub repo. This is exactly what
 * happened with a stray `uploads/*.webp` file found in a real PR: the
 * image was never meant to be part of the project, it just happened to
 * live in the same working directory as the cloned repo (images are
 * written under the sandbox's working directory, which *is* the repo
 * root -- `git clone ... .` clones straight into it, there's no separate
 * non-repo path in this sandbox setup).
 *
 * Root-anchored (`/uploads/`) so it only excludes this exact top-level
 * directory, not a same-named nested directory a real project might
 * legitimately have and want tracked (e.g. `apps/web/public/uploads`).
 * Idempotent -- checks for an existing matching line first, appends a
 * commented entry if missing, creates the file if it doesn't exist yet.
 */
export async function ensureUploadsGitignored(sandbox: Sandbox): Promise<void> {
  let existing = "";
  try {
    existing = await sandbox.readFile(GITIGNORE_PATH, "utf-8");
  } catch {
    // No .gitignore yet in this repo -- fine, we'll create one.
  }

  const alreadyIgnored = existing.split("\n").some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === UPLOADS_GITIGNORE_ENTRY ||
      trimmed === IMAGE_UPLOADS_DIR ||
      trimmed === `${IMAGE_UPLOADS_DIR}/`
    );
  });

  if (alreadyIgnored) {
    return;
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const updated =
    existing +
    (needsLeadingNewline ? "\n" : "") +
    (existing.length > 0 ? "\n" : "") +
    "# Entry: chat image attachments, offloaded into the sandbox but not part of the project\n" +
    `${UPLOADS_GITIGNORE_ENTRY}\n`;

  await sandbox.writeFile(GITIGNORE_PATH, updated, "utf-8");
}
