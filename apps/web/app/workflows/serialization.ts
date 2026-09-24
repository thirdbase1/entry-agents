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

/**
 * Walk `value` and log the exact path of every `undefined` found.
 *
 * The Workflow SDK only reports `problematicValue undefined` -- never which
 * property or which step -- so when a run still fails after sanitising the
 * obvious boundaries, this is what turns "somewhere there is an undefined"
 * into an actionable `path[0].foo.bar`. Call it BEFORE `withoutUndefined`
 * on any boundary you want to observe.
 *
 * Class instances are walked via own enumerable properties only (their
 * prototype is left alone), so instrumenting a live model or SDK object
 * does not mutate it.
 */
export function findUndefinedPaths(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>(),
): string[] {
  if (value === undefined) return [path];

  if (Array.isArray(value)) {
    if (seen.has(value)) return [];
    seen.add(value);
    const found: string[] = [];
    value.forEach((item, index) => {
      found.push(...findUndefinedPaths(item, `${path}[${index}]`, seen));
    });
    return found;
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return [];
    seen.add(value);
    const found: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      found.push(...findUndefinedPaths(item, `${path}.${key}`, seen));
    }
    return found;
  }

  return [];
}

/** Log `undefined` paths for a boundary. Never throws, never alters data. */
export function reportUndefined(label: string, value: unknown): void {
  const paths = findUndefinedPaths(value);
  if (paths.length > 0) {
    console.error(
      `[serialization] ${label} contains undefined at ${paths.length} path(s): ${paths
        .slice(0, 25)
        .join(", ")}${paths.length > 25 ? ", ..." : ""}`,
    );
  }
}
