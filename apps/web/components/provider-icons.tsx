import {
  Anthropic,
  XAI as XAIBrand,
  Cohere,
  DeepSeek,
  Google,
  Groq,
  Meta,
  Mistral,
  Moonshot,
  OpenAI,
  Perplexity,
  XiaomiMiMo,
  Zhipu,
} from "@lobehub/icons";
import AntGroup from "@lobehub/icons/es/AntGroup";
import Hunyuan from "@lobehub/icons/es/Hunyuan";
import Minimax from "@lobehub/icons/es/Minimax";
import Qwen from "@lobehub/icons/es/Qwen";
import Stepfun from "@lobehub/icons/es/Stepfun";
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function AnthropicIcon(props: IconProps) {
  return <Anthropic {...props} />;
}

function OpenAIIcon(props: IconProps) {
  return <OpenAI {...props} />;
}

function GoogleIcon(props: IconProps) {
  return <Google.Color {...props} />;
}

function XAIIcon(props: IconProps) {
  return <XAIBrand {...props} />;
}

function GroqIcon(props: IconProps) {
  return <Groq {...props} />;
}

function MistralIcon(props: IconProps) {
  return <Mistral.Color {...props} />;
}

function DeepSeekIcon(props: IconProps) {
  return <DeepSeek.Color {...props} />;
}

function PerplexityIcon(props: IconProps) {
  return <Perplexity {...props} />;
}

function MoonshotIcon(props: IconProps) {
  return <Moonshot {...props} />;
}

function CohereIcon(props: IconProps) {
  return <Cohere.Color {...props} />;
}

function MetaIcon(props: IconProps) {
  return <Meta.Color {...props} />;
}

function ZAIIcon(props: IconProps) {
  return <Zhipu.Color {...props} />;
}

function XiaomiIcon(props: IconProps) {
  return <XiaomiMiMo {...props} />;
}

function LingIcon(props: IconProps) {
  return <AntGroup.Color {...props} />;
}

function Hy3Icon(props: IconProps) {
  return <Hunyuan.Color {...props} />;
}

function QwenIcon(props: IconProps) {
  return <Qwen.Color {...props} />;
}

function MinimaxIcon(props: IconProps) {
  return <Minimax.Color {...props} />;
}

function StepfunIcon(props: IconProps) {
  return <Stepfun {...props} />;
}

function DefaultProviderIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  );
}

export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "groq"
  | "mistral"
  | "deepseek"
  | "perplexity"
  | "moonshot"
  | "togetherai"
  | "cohere"
  | "fireworks"
  | "meta"
  | "zai"
  | "xiaomi"
  | "ling"
  | "hy3"
  | "qwen"
  | "minimax"
  | "stepfun"
  | string;

const providerIconMap: Record<string, React.FC<IconProps>> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  google: GoogleIcon,
  xai: XAIIcon,
  groq: GroqIcon,
  mistral: MistralIcon,
  deepseek: DeepSeekIcon,
  perplexity: PerplexityIcon,
  moonshot: MoonshotIcon,
  cohere: CohereIcon,
  meta: MetaIcon,
  zai: ZAIIcon,
  xiaomi: XiaomiIcon,
  ling: LingIcon,
  hy3: Hy3Icon,
  qwen: QwenIcon,
  minimax: MinimaxIcon,
  stepfun: StepfunIcon,
};

const providerDisplayNames: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  moonshot: "Moonshot",
  togetherai: "Together AI",
  cohere: "Cohere",
  fireworks: "Fireworks",
  meta: "Meta",
  zai: "ZAI",
  xiaomi: "Xiaomi",
  ling: "Ling",
  hy3: "Hy3",
  qwen: "Qwen",
  minimax: "MiniMax",
  stepfun: "StepFun",
};

/** Prefixes in model display names that match the provider brand (stripped in compact UI). */
const providerLabelPrefixes: Record<string, string[]> = {
  anthropic: ["Claude"],
  google: ["Gemini"],
  xai: ["Grok"],
  mistral: ["Mistral"],
  deepseek: ["DeepSeek"],
  meta: ["Meta"],
};

/**
 * Entry's model gateway (entry-gateway, wrapping Opencode Zen) returns flat
 * catalog IDs with no "provider/model" namespace, e.g. "grok-4.5",
 * "kimi-k3", "mimo-v2.5-free", "ling-3.0-flash-free", "hy3-free" -- so we
 * can't just split on "/" for those. Infer the vendor from the model's
 * well-known family prefix instead; namespaced IDs (used by some direct
 * provider call sites, e.g. "anthropic/claude-...") still take the
 * slash-prefix fast path first.
 */
const flatModelIdProviderPrefixes: [prefix: string, provider: string][] = [
  ["grok", "xai"],
  ["kimi", "moonshot"],
  ["mimo", "xiaomi"],
  ["ling", "ling"],
  ["hy3", "hy3"],
  ["qwen", "qwen"],
  ["minimax", "minimax"],
  ["step", "stepfun"],
  ["deepseek", "deepseek"],
  ["claude", "anthropic"],
  ["gpt-", "openai"],
  ["gemini", "google"],
  ["glm", "zai"],
  ["mistral", "mistral"],
  ["llama", "meta"],
  ["command", "cohere"],
  ["grouq", "groq"],
];

export function getProviderFromModelId(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  if (slashIndex !== -1) return modelId.slice(0, slashIndex);

  const lower = modelId.toLowerCase();
  for (const [prefix, provider] of flatModelIdProviderPrefixes) {
    if (lower.startsWith(prefix) || lower.includes(`-${prefix}`)) {
      return provider;
    }
  }
  return modelId;
}

/**
 * Strip the provider brand prefix from a model label for compact display.
 * e.g. "Claude Opus 4.6" → "Opus 4.6", "GPT-5.4" → "GPT-5.4"
 */
export function stripProviderPrefix(label: string, provider: string): string {
  const prefixes = providerLabelPrefixes[provider];
  if (!prefixes) return label;
  for (const prefix of prefixes) {
    if (label.startsWith(prefix + " ")) {
      return label.slice(prefix.length + 1);
    }
  }
  return label;
}

export function getProviderDisplayName(provider: string): string {
  return (
    providerDisplayNames[provider] ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

interface ProviderIconProps extends IconProps {
  provider: string;
}

export function ProviderIcon({ provider, ...props }: ProviderIconProps) {
  const Icon = providerIconMap[provider] ?? DefaultProviderIcon;
  return <Icon {...props} />;
}
