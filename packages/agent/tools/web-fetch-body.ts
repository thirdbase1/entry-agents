/**
 * Sandbox-side persistence path for large web_fetch bodies (upstream
 * open-agents #781 / PR #813).
 *
 * When a fetched response exceeds MAX_BODY_LENGTH, the full body is
 * saved into the sandbox under WEB_FETCH_BODY_DIR and only the first
 * MAX_BODY_LENGTH characters enter the model's context. The agent can
 * then grep/read the saved file instead of re-fetching or blowing up
 * the context window.
 */

export const WEB_FETCH_BODY_DIR = ".open-harness/web-fetch";

/**
 * Deterministic djb2 hash rendered as fixed-width hex. Deterministic on
 * purpose: re-fetching the same URL overwrites the same file instead of
 * piling up near-duplicate copies in the sandbox.
 */
function djb2Hex(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 48);
}

/** Human-ish, deterministic, filesystem-safe file name for a fetched body. */
export function buildWebFetchBodyFileName(url: string): string {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  const host = parsed?.hostname ?? "unknown";
  const path = parsed ? parsed.pathname.replace(/^\//, "") : "";
  const query = parsed?.search ?? "";

  const base = slugify(path ? `${host}/${path}` : host);
  const hash = djb2Hex(`${host}${path}${query}`);

  return `fetch-${base}-${hash}.txt`;
}
