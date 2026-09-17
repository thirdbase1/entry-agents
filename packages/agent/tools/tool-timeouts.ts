/**
 * Configurable per-tool timeouts (upstream open-agents #798).
 *
 * Every tool that enforces an execution timeout takes its ceiling from
 * here. The default is the tool's own sane constant; operators can
 * override it per deployment with an environment variable of the form
 *
 *   TOOL_TIMEOUT_<NAME>_MS
 *
 * e.g. TOOL_TIMEOUT_BASH_MS=300000, TOOL_TIMEOUT_FETCH_MS=60000.
 * Invalid values (non-numeric, zero, negative, NaN) are ignored and the
 * default is used, so a bad env var can never zero out a timeout.
 */

export function getToolTimeoutMs(toolName: string, defaultMs: number): number {
  const envKey = `TOOL_TIMEOUT_${toolName.toUpperCase()}_MS`;
  const raw = process.env[envKey];

  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return defaultMs;
}
