"use client";

/**
 * Brand-icon renderer for the GitHub and Vercel tool calls.
 *
 * Owner request 2026-09-12: whenever the agent uses a GitHub or Vercel
 * tool, the chat should show the REAL brand icon (GitHub mark, Vercel
 * triangle) -- same visual language as the model picker, which already
 * uses @lobehub/icons for provider branding -- instead of the raw tool
 * names ("github_cli", "vercel_api") that the DefaultRenderer used to
 * capitalize into "Github_cli" / "Vercel_api" with a JSON-blob summary.
 *
 * Kept in one renderer (rather than one per tool) because all three
 * tools share the exact same header shape: brand icon + clean display
 * name + a human-readable summary of the specific action taken
 * (commit title, REST method+path, or the CLI args).
 */
import { Github, Vercel } from "@lobehub/icons";
import type { SVGProps } from "react";
import type { WebAgentUIToolPart } from "@/app/types";
import type { ToolRenderState } from "@/app/lib/render-tool";
import { ToolLayout } from "../tool-layout";

type IconProps = SVGProps<SVGSVGElement>;

function GithubIcon(props: IconProps) {
  return <Github {...props} />;
}

function VercelIcon(props: IconProps) {
  return <Vercel {...props} />;
}

export type BrandToolRendererProps = {
  part: WebAgentUIToolPart;
  state: ToolRenderState;
  onApprove?: (id: string) => void;
  onDeny?: (id: string, reason?: string) => void;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve (icon, display name, summary) for a github_* or vercel_* tool
 * part. Extracted so it's unit-testable without React rendering.
 */
export function resolveBrandToolDisplay(
  toolName: string,
  input: Record<string, unknown> | undefined,
): {
  icon: "github" | "vercel";
  name: string;
  summary: string;
} {
  const inp = input ?? {};

  if (toolName.startsWith("github")) {
    const action = asString(inp.action);
    if (action === "commit_and_push") {
      return {
        icon: "github",
        name: "GitHub",
        summary: asString(inp.commitTitle) ?? "Commit & push changes",
      };
    }
    if (action === "api") {
      return {
        icon: "github",
        name: "GitHub",
        summary: `${asString(inp.method) ?? "GET"} ${asString(inp.path) ?? "..."}`,
      };
    }
    if (action === "cli") {
      return {
        icon: "github",
        name: "GitHub",
        summary: `gh ${asString(inp.args) ?? ""}`.trim(),
      };
    }
    return { icon: "github", name: "GitHub", summary: "..." };
  }

  // Everything else reaching this renderer is a Vercel tool
  // (vercel_cli / vercel_api).
  if (toolName === "vercel_cli") {
    return {
      icon: "vercel",
      name: "Vercel",
      summary: `vercel ${asString(inp.args) ?? ""}`.trim(),
    };
  }
  return {
    icon: "vercel",
    name: "Vercel",
    summary: `${asString(inp.method) ?? "GET"} ${asString(inp.path) ?? "..."}`,
  };
}

export function BrandToolRenderer({
  part,
  state,
  onApprove,
  onDeny,
}: BrandToolRendererProps) {
  const toolName =
    part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
  const input = (part.input ?? {}) as Record<string, unknown>;

  const { icon, name, summary } = resolveBrandToolDisplay(toolName, input);
  const meta = part.state === "output-available" ? "Done" : undefined;
  const IconComponent = icon === "github" ? GithubIcon : VercelIcon;

  return (
    <ToolLayout
      name={name}
      summary={summary}
      summaryClassName="font-mono"
      icon={<IconComponent className="h-3.5 w-3.5" />}
      meta={meta}
      state={state}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
