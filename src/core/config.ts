// Agent limits and model choices (ADR D2, D17, D19). Prices and windows from the ai& model list (2026-09-30).

export interface AgentConfig {
  models: { code: string; review: string; task: string };
  /** Context window per model id, in tokens. */
  contextWindows: Record<string, number>;
  maxSteps: number;
  maxTokens: number;
  commandTimeoutMs: number;
  /** Yen per million tokens, per model id (ai& list price, uncached input). Cost is omitted when unknown. */
  prices?: Record<string, { in: number; out: number }>;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;

const DEFAULT_MODEL = "deepseek-ai/deepseek-v4-flash";

export const defaultConfig: AgentConfig = {
  models: { code: DEFAULT_MODEL, review: DEFAULT_MODEL, task: DEFAULT_MODEL },
  contextWindows: {
    "zai-org/glm-5.3": 1_000_000,
    "zai-org/glm-5.2": 1_000_000,
    "moonshotai/kimi-k3": 1_000_000,
    "moonshotai/kimi-k2.7-code": 262_144,
    "qwen/qwen3.8-27b": 262_144,
    "qwen/qwen3.6-27b": 262_144,
    "google/gemma-4-31b-it": 262_144,
    "motif-technologies/motif-3": 262_144,
    "deepseek-ai/deepseek-v4-flash": 1_000_000,
    "deepseek-ai/deepseek-v4-pro": 1_000_000,
    "openai/gpt-oss-120b": 131_072,
  },
  prices: {
    "zai-org/glm-5.3": { in: 160, out: 650 },
    "zai-org/glm-5.2": { in: 160, out: 650 },
    "moonshotai/kimi-k3": { in: 480, out: 2000 },
    "moonshotai/kimi-k2.7-code": { in: 125, out: 560 },
    "qwen/qwen3.8-27b": { in: 60, out: 480 },
    "qwen/qwen3.6-27b": { in: 50, out: 510 },
    "google/gemma-4-31b-it": { in: 30, out: 80 },
    "motif-technologies/motif-3": { in: 80, out: 320 },
    "deepseek-ai/deepseek-v4-flash": { in: 25, out: 40 },
    "deepseek-ai/deepseek-v4-pro": { in: 160, out: 400 },
    "openai/gpt-oss-120b": { in: 25, out: 95 },
  },
  maxSteps: 30,
  maxTokens: 400_000,
  commandTimeoutMs: 120_000,
};

/** Models a user may pick for a session (P3-c), in display order. */
export const selectableModels = [
  "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v4-pro",
  "moonshotai/kimi-k2.7-code",
  "zai-org/glm-5.3",
];

export function contextWindowFor(config: AgentConfig, model: string): number {
  return config.contextWindows[model] ?? DEFAULT_CONTEXT_WINDOW;
}
