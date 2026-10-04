import { describe, expect, test } from "bun:test";
import type { SkillMetadata } from "@open-agents/agent";
import { createSkillsCache, getSkillsCacheKey } from "./skills-cache";

const exampleSkills: SkillMetadata[] = [
  {
    name: "ship",
    description: "Deploy the current project",
    path: "/workspace/.agents/skills/ship",
    filename: "SKILL.md",
    options: {},
  },
];

describe("skills cache", () => {
  test("derives cache keys from the durable volume name, or local scope", () => {
    // The Modal volume is the only handle that outlives a sandbox, so it
    // is what the cache key is built from; without it the key falls back
    // to the untargeted "local" scope.
    expect(
      getSkillsCacheKey("session-1", {
        type: "modal",
        volumeName: "entry-workspace-session-1",
      }),
    ).toBe("skills:v1:session-1:entry-workspace-session-1");

    expect(
      getSkillsCacheKey("session-1", {
        type: "modal",
      }),
    ).toBe("skills:v1:session-1:local");
  });

  test("caches empty skill arrays in the in-memory fallback until TTL expires", async () => {
    let nowMs = 10_000;
    const cache = createSkillsCache({
      ttlSeconds: 1,
      now: () => nowMs,
      getRedisClient: () => null,
    });
    const sandboxState = { type: "modal" as const };

    await cache.set("session-1", sandboxState, []);

    expect(await cache.get("session-1", sandboxState)).toEqual([]);

    nowMs += 999;
    expect(await cache.get("session-1", sandboxState)).toEqual([]);

    nowMs += 2;
    expect(await cache.get("session-1", sandboxState)).toBeNull();
  });

  test("falls back to the in-memory cache when Redis reads fail", async () => {
    let redisAvailable = true;
    const loggerCalls: unknown[][] = [];
    const cache = createSkillsCache({
      getRedisClient: () =>
        redisAvailable
          ? {
              get: async () => {
                throw new Error("redis unavailable");
              },
              set: async () => "OK",
            }
          : null,
      logger: {
        error: (...args) => {
          loggerCalls.push(args);
        },
      },
    });
    const sandboxState = {
      type: "modal" as const,
      volumeName: "session_session-1",
    };

    await cache.set("session-1", sandboxState, exampleSkills);
    expect(await cache.get("session-1", sandboxState)).toEqual(exampleSkills);
    expect(loggerCalls).toHaveLength(1);
  });
});
