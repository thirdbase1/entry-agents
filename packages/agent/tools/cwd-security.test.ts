import { describe, expect, test } from "bun:test";
import { resolveBashWorkingDirectory } from "./cwd-security";

describe("resolveBashWorkingDirectory", () => {
  const workspace = "/sandbox/workspace";

  test("defaults to the workspace", () => {
    expect(resolveBashWorkingDirectory(undefined, workspace)).toBe(workspace);
  });

  test("resolves workspace-relative directories", () => {
    expect(resolveBashWorkingDirectory("apps/web", workspace)).toBe(
      "/sandbox/workspace/apps/web",
    );
  });

  test("rejects absolute paths", () => {
    expect(resolveBashWorkingDirectory("/tmp", workspace)).toBeNull();
    expect(resolveBashWorkingDirectory("/sandbox/workspace/apps", workspace)).toBeNull();
  });

  test("rejects parent traversal", () => {
    expect(resolveBashWorkingDirectory("../secrets", workspace)).toBeNull();
    expect(resolveBashWorkingDirectory("apps/web/../../../../etc", workspace)).toBeNull();
  });

  test("accepts the workspace itself", () => {
    expect(resolveBashWorkingDirectory(".", workspace)).toBe(workspace);
  });
});
