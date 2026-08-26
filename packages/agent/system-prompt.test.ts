import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt guided frontend workflow", () => {
  test("omits the guided frontend workflow section by default", () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain("Guided Frontend Workflow");
    expect(prompt).not.toContain("design.md");
  });

  test("omits the section when explicitly false", () => {
    const prompt = buildSystemPrompt({ guidedFrontendWorkflow: false });
    expect(prompt).not.toContain("Guided Frontend Workflow");
  });

  test("injects the guided frontend workflow section when enabled", () => {
    const prompt = buildSystemPrompt({ guidedFrontendWorkflow: true });
    expect(prompt).toContain("Guided Frontend Workflow");
    expect(prompt).toContain("design.md");
  });

  test("guided frontend workflow section is appended after other sections", () => {
    const withSkills = buildSystemPrompt({
      guidedFrontendWorkflow: true,
      customInstructions: "Always use pnpm.",
      cwd: ".",
    });
    const customIdx = withSkills.indexOf("Always use pnpm.");
    const guidedIdx = withSkills.indexOf("Guided Frontend Workflow");
    expect(customIdx).toBeGreaterThan(-1);
    expect(guidedIdx).toBeGreaterThan(customIdx);
  });
});
