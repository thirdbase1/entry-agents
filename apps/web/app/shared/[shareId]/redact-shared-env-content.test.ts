import { describe, expect, test } from "bun:test";
import type { WebAgentUIMessage } from "@/app/types";
import { redactSharedEnvContent } from "./redact-shared-env-content";

// SECURITY REGRESSION TEST (2026-08-27, pentest finding): a shared
// session's raw `bash` tool stdout/stderr was never scanned for
// secret-looking lines at all, unlike read/write/edit which already
// had .env-path based redaction. Cover both the top-level bash call
// and a bash call nested inside a sub-agent's `task` output.
describe("redactSharedEnvContent", () => {
  test("redacts secret-looking lines from a top-level bash tool's stdout/stderr", () => {
    const message: WebAgentUIMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "call-1",
          state: "output-available",
          input: { command: "env | grep API" },
          output: {
            stdout:
              "some normal output\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\nmore normal output",
            stderr: "Authorization: Bearer some-real-token-value-here",
          },
        } as unknown as WebAgentUIMessage["parts"][number],
      ],
    };

    const redacted = redactSharedEnvContent(message);
    const part = redacted.parts[0] as unknown as {
      output: { stdout: string; stderr: string };
    };

    expect(part.output.stdout).toBe(
      "some normal output\n[line redacted from shared page -- looked like a secret]\nmore normal output",
    );
    expect(part.output.stderr).toBe(
      "[line redacted from shared page -- looked like a secret]",
    );
  });

  test("leaves ordinary bash output completely untouched", () => {
    const message: WebAgentUIMessage = {
      id: "m2",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "call-2",
          state: "output-available",
          input: { command: "npm test" },
          output: { stdout: "24 pass\n0 fail", stderr: "" },
        } as unknown as WebAgentUIMessage["parts"][number],
      ],
    };

    const redacted = redactSharedEnvContent(message);
    const part = redacted.parts[0] as unknown as {
      output: { stdout: string; stderr: string };
    };

    expect(part.output.stdout).toBe("24 pass\n0 fail");
    expect(part.output.stderr).toBe("");
  });

  test("redacts secret-looking lines from a bash call nested inside a sub-agent task's final output", () => {
    const message: WebAgentUIMessage = {
      id: "m3",
      role: "assistant",
      parts: [
        {
          type: "tool-task",
          toolCallId: "call-task",
          state: "output-available",
          input: { task: "Check env", subagentType: "executor" },
          output: {
            final: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call-bash-nested",
                    toolName: "bash",
                    input: { command: "cat .env" },
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-bash-nested",
                    output: {
                      stdout: "DATABASE_PASSWORD=super-secret-value",
                      stderr: "",
                    },
                  },
                ],
              },
            ],
          },
        } as unknown as WebAgentUIMessage["parts"][number],
      ],
    };

    const redacted = redactSharedEnvContent(message);
    const part = redacted.parts[0] as unknown as {
      output: { final: Array<{ content: Array<Record<string, unknown>> }> };
    };
    const nestedToolResult = part.output.final[1]?.content[0] as {
      output: { stdout: string; stderr: string };
    };

    expect(nestedToolResult.output.stdout).toBe(
      "[line redacted from shared page -- looked like a secret]",
    );
  });
});
