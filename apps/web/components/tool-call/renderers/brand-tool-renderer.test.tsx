import { describe, expect, test } from "bun:test";
import type { ToolRenderState } from "@open-agents/shared/lib/tool-state";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveBrandToolDisplay, BrandToolRenderer } from "./brand-tool-renderer";

const baseState: ToolRenderState = {
  running: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

describe("resolveBrandToolDisplay", () => {
  test("github commit_and_push shows the commit title (or a default)", () => {
    expect(
      resolveBrandToolDisplay("github_cli", {
        action: "commit_and_push",
        commitTitle: "fix: handle nested repos",
      }),
    ).toEqual({
      icon: "github",
      name: "GitHub",
      summary: "fix: handle nested repos",
    });
    expect(
      resolveBrandToolDisplay("github_cli", { action: "commit_and_push" })
        .summary,
    ).toBe("Commit & push changes");
  });

  test("github api action shows method + path, defaulting to GET", () => {
    expect(
      resolveBrandToolDisplay("github_cli", {
        action: "api",
        method: "POST",
        path: "issues/12/comments",
      }).summary,
    ).toBe("POST issues/12/comments");
    expect(
      resolveBrandToolDisplay("github_cli", { action: "api", path: "repos" })
        .summary,
    ).toBe("GET repos");
  });

  test("github cli action prefixes gh to the args", () => {
    expect(
      resolveBrandToolDisplay("github_cli", { action: "cli", args: "pr checks 12" })
        .summary,
    ).toBe("gh pr checks 12");
  });

  test("vercel_cli shows the vercel command", () => {
    expect(
      resolveBrandToolDisplay("vercel_cli", { args: "deploy --prod" }),
    ).toEqual({
      icon: "vercel",
      name: "Vercel",
      summary: "vercel deploy --prod",
    });
  });

  test("vercel_api shows method + path, defaulting to GET", () => {
    expect(
      resolveBrandToolDisplay("vercel_api", { path: "v13/deployments" }).summary,
    ).toBe("GET v13/deployments");
    expect(
      resolveBrandToolDisplay("vercel_api", {
        method: "PATCH",
        path: "v9/projects/entry/env",
      }).summary,
    ).toBe("PATCH v9/projects/entry/env");
  });

  test("empty inputs never render blank summaries", () => {
    expect(
      resolveBrandToolDisplay("github_cli", undefined).summary,
    ).toBe("...");
    expect(resolveBrandToolDisplay("vercel_api", undefined).summary).toBe(
      "GET ...",
    );
  });
});

describe("BrandToolRenderer", () => {
  test("renders the GitHub brand icon and clean name, not 'Github_cli'", () => {
    const part = {
      type: "tool-github_cli",
      state: "output-available",
      input: { action: "api", path: "repos/thirdbase1/entry-agents" },
      output: { data: {} },
    } as never;

    const html = renderToStaticMarkup(
      <BrandToolRenderer part={part} state={baseState} />,
    );

    expect(html).toContain("GitHub");
    expect(html).toContain("repos/thirdbase1/entry-agents");
    expect(html).not.toContain("Github_cli");
    expect(html).not.toContain("github_api");
    // A real SVG icon is rendered (brand mark, not a status dot).
    expect(html).toContain("<svg");
  });

  test("renders the Vercel brand icon and clean name, not 'Vercel_api'", () => {
    const part = {
      type: "tool-vercel_api",
      state: "output-available",
      input: { method: "GET", path: "v10/projects" },
      output: { data: {} },
    } as never;

    const html = renderToStaticMarkup(
      <BrandToolRenderer part={part} state={baseState} />,
    );

    expect(html).toContain("Vercel");
    expect(html).toContain("v10/projects");
    expect(html).not.toContain("Vercel_api");
    expect(html).toContain("<svg");
  });
});
