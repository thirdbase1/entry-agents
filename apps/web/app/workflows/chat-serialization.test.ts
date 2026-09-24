import { describe, expect, test } from "bun:test";

/**
 * Regression test for the production run `wrun_41M3880KMW0GVKCWFQNXBGM686`
 * that died with:
 *
 *   [workflow-sdk] Serialization failed
 *     context step arguments
 *     problematicValue undefined
 *   [workflow-sdk] Non-retryable error while committing workflow suspension
 *
 * The Workflow SDK persists step arguments and return values across
 * process boundaries, and it cannot serialize `undefined`. A `USER_ERROR`
 * of this kind is not retried -- it terminates the run, which is why a
 * single agent tool call could kill a whole chat turn.
 *
 * The trigger: `vercel.request` and `github_cli`'s api action both
 * declare `params` as OPTIONAL in their tool schemas
 * (packages/agent/types.ts), because a call genuinely needs no params.
 * The agent then omits it, and the workflow closure passed that raw
 * `undefined` straight into a `"use step"` function.
 *
 * So the invariant under test is narrow and worth pinning: whatever the
 * agent tool hands a step must never contain `undefined`, and a step's
 * declared parameter shape must make `undefined` unrepresentable so
 * TypeScript enforces it at every call site.
 */

/**
 * Mirrors how the SDK validates a step payload: any `undefined` value in
 * an argument object is unserializable. Rebuilt locally because the SDK
 * package is not resolvable in a dependency-less checkout.
 */
function isSerializableStepArgument(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (value === null || typeof value !== "object") {
    return true;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!isSerializableStepArgument(entry)) {
      return false;
    }
  }
  return true;
}

describe("step argument serialization", () => {
  test("an omitted tool params must not reach a step as undefined", () => {
    // The exact shape the agent's `vercel.request` tool produces when it
    // calls an endpoint that needs no params.
    const toolInput: { params?: Record<string, unknown> } = {
      method: "GET",
      path: "v13/deployments",
    };

    const stepArguments = {
      userId: "user-1",
      method: toolInput.method,
      path: toolInput.path,
      params: toolInput.params ?? {},
    };

    expect(isSerializableStepArgument(stepArguments)).toBe(true);
    expect(stepArguments.params).toEqual({});
  });

  test("the pre-fix shape (raw passthrough) is exactly what failed", () => {
    // Documents why the guard exists: without `?? {}` the argument object
    // is unserializable, which is the reported production failure.
    const toolInput: { params?: Record<string, unknown> } = {
      method: "GET",
      path: "v13/deployments",
    };

    const brokenArguments = {
      userId: "user-1",
      method: toolInput.method,
      path: toolInput.path,
      params: toolInput.params,
    };

    expect(isSerializableStepArgument(brokenArguments)).toBe(false);
  });

  test("a present params object is preserved untouched", () => {
    const stepArguments = {
      userId: "user-1",
      method: "POST",
      path: "v9/projects/x/env",
      params: { key: "DATABASE_URL", value: "postgres://..." } ?? {},
    };

    expect(isSerializableStepArgument(stepArguments)).toBe(true);
    expect(Object.keys(stepArguments.params)).toEqual(["key", "value"]);
  });

  test("nested undefined anywhere in a step argument is rejected", () => {
    // The failure is not specific to a top-level field -- the SDK walks
    // the whole payload, so a nested `undefined` fails the same way.
    expect(
      isSerializableStepArgument({ a: { b: undefined }, c: 1 }),
    ).toBe(false);
  });
});

describe("the workflow source keeps the step boundary undefined-free", () => {
  /**
   * Source-level guard. Both tool closures that feed the two steps must
   * normalise `input.params`, and the step signatures must declare
   * `params` as required. This test fails loudly if someone reintroduces
   * the raw passthrough that took down production run
   * wrun_41M3880KMW0GVKCWFQNXBGM686.
   */
  const readChatSource = () =>
    Bun.file(new URL("./chat.ts", import.meta.url)).text();

  test("no step call passes `params: input.params` verbatim", async () => {
    const source = await readChatSource();
    expect(source).not.toContain("params: input.params,");
  });

  test("the two agent API steps normalise the tool input", async () => {
    const source = await readChatSource();
    const normalisations = source.match(/params: input\.params \?\? \{\}/g);
    // One for performAgentGithubApiRequest, one for
    // performAgentVercelApiRequest.
    expect(normalisations?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("the steps declare params as required, not optional", async () => {
    const source = await readChatSource();
    // The type-level backstop: making it required means any future caller
    // that forgets `?? {}` is a compile error rather than a runtime
    // non-retryable SerializationError.
    expect(source).not.toContain("params?: Record<string, unknown>;");
  });
});
