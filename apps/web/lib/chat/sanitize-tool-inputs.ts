import type { WebAgentUIMessage } from "@/app/types";

/**
 * Sanitizes tool part inputs so that a tool-call sent to the model can NEVER
 * carry invalid/missing arguments.
 *
 * WHY THIS EXISTS (real incident, 2026-09-14/15, chat 8372eec6):
 * a turn died mid-stream on an upstream error while a bash tool call was
 * still streaming its arguments. The persisted tool part has
 * `state: "output-error"` with `rawInput` set to a TRUNCATED, invalid JSON
 * string (`{"command": "ls -la && cat package.json 2`) and `input` never
 * present -- `input` only materializes once the args fully parse. The AI
 * SDK's convertToModelMessages sends `part.input ?? part.rawInput` for
 * output-error parts, so every retry of that turn re-sent a tool-call
 * whose arguments were not valid JSON. The upstream (OneAPI-family
 * provider) rejected every attempt with a deterministic 400 --
 * `The "***.arguments" parameter of the code model must be in JSON format.`
 * -- so the Workflow SDK's step retries all failed identically and the
 * turn died with AI_NoOutputGeneratedError. The chat was permanently
 * wedged: retrying always rebuilt the same poisoned history.
 *
 * This runs in the convertMessages chain BEFORE convertToModelMessages,
 * so both fresh turns and retries send a parseable `{}` for any tool part
 * whose effective input (input ?? rawInput) is missing or not valid JSON.
 * The model still sees the tool call AND its error result (errorText), so
 * it can continue the turn -- it just can't be poisoned by it.
 */
function isValidToolInput(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeToolPartInput(
  part: Record<string, unknown>,
): Record<string, unknown> {
  // Only tool parts ("tool-*" / "dynamic-tool") carry tool-call inputs.
  if (
    part === null ||
    (String(part.type).startsWith("tool-") === false &&
      part.type !== "dynamic-tool")
  ) {
    return part;
  }

  const input = part.input as unknown;
  if (isValidToolInput(input)) {
    return part;
  }

  // `input` missing or not a plain object -- try rawInput as a fallback.
  // rawInput is either the already-parsed object or the raw streamed string.
  const rawInput = part.rawInput as unknown;
  if (isValidToolInput(rawInput)) {
    return { ...part, input: rawInput };
  }
  if (typeof rawInput === "string") {
    try {
      const parsed: unknown = JSON.parse(rawInput);
      if (isValidToolInput(parsed)) {
        return { ...part, input: parsed };
      }
    } catch {
      // fall through to {}
    }
  }

  // Nothing recoverable -- send valid JSON `{}` so the request is accepted.
  return { ...part, input: {} };
}

export function sanitizeMessageToolInputs(message: WebAgentUIMessage): WebAgentUIMessage {
  return (() => {
    let mutated = false;
    const parts = message.parts.map((part) => {
      const sanitized = sanitizeToolPartInput(
        part as unknown as Record<string, unknown>,
      );
      if (sanitized !== part) {
        mutated = true;
      }
      return sanitized;
    });
    return mutated ? ({ ...message, parts } as WebAgentUIMessage) : message;
  })();
}

export function sanitizeToolInputs(messages: WebAgentUIMessage[]): WebAgentUIMessage[] {
  return messages.map(sanitizeMessageToolInputs);
}
