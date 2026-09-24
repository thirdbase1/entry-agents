/**
 * Workflow-step boundary hygiene.
 *
 * The Workflow SDK persists every step argument and step return value in
 * its event log, and its serializer supports only JSON primitives, arrays
 * and plain objects -- `undefined` is NOT supported (see
 * https://workflow-sdk.dev/docs/errors/serialization-failed). A single
 * `undefined` property anywhere in a value makes the SDK log
 *
 *   [workflow-sdk] Serialization failed
 *     context step value | context step arguments
 *     problematicValue undefined
 *
 * and then fail the whole run with a non-retryable SerializationError
 * (code USER_ERROR) while committing the workflow suspension.
 *
 * TypeScript makes this invisible: `{ a?: string }` happily assigns to a
 * property typed `string | undefined`, so an optional field that was never
 * set still arrives at the boundary as an explicit `undefined`. Call
 * `withoutUndefined()` on anything crossing a step boundary instead of
 * trying to track which optional fields happen to be populated.
 *
 * Deliberately dependency-free (no node: imports) so it can be imported
 * from a restricted "use workflow" bundle as well as from "use step".
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep copy of `value` with every `undefined` property removed.
 *
 * - plain objects: `undefined` keys are dropped entirely (so `{ b: undefined }`
 *   becomes `{}`, matching how JSON would treat it)
 * - arrays: `undefined` elements become `null`, because dropping a slot would
 *   shift every later index and silently corrupt list-shaped data
 * - everything else (primitives, Date, RegExp, Map, Set, class instances) is
 *   returned as-is; the SDK is responsible for rejecting whatever it cannot
 *   represent, and rewriting those here would hide the real problem.
 */
export function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : withoutUndefined(item),
    ) as unknown as T;
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      result[key] = withoutUndefined(item);
    }
    return result as unknown as T;
  }

  return value;
}
