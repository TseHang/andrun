// Agent limits and model choices (ADR D2, D17, D19). Prices and windows from the ai& model list (2026-09-30).

export interface AgentConfig {
  models: { code: string; review: string; task: string };
  /** Context window per model id, in tokens. */
  contextWindows: Record<string, number>;
  /** Optional step cap (eval cases set it); the product limit is `maxTurnCost`. */
  maxSteps?: number;
  /** Safety limit per turn, in yen (a turn is what one user message starts). */
  maxTurnCost: number;
  /** The same limit in tokens, for a model with no price. */
  maxTurnTokens: number;
  /** Yen: only reported to the UI, which tells the user the turn has cost this much. */
  costNotice: number;
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
    "deepseek-ai/deepseek-v4.1-flash": 1_000_000,
    "zai-org/glm-5.3-flash": 1_000_000,
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
    "deepseek-ai/deepseek-v4.1-flash": { in: 45, out: 90 },
    "zai-org/glm-5.3-flash": { in: 23, out: 75 },
    "deepseek-ai/deepseek-v4-pro": { in: 160, out: 400 },
    "openai/gpt-oss-120b": { in: 25, out: 95 },
  },
  maxTurnCost: 50,
  maxTurnTokens: 4_000_000,
  costNotice: 10,
  commandTimeoutMs: 120_000,
};

/** Models a user may pick for a session (P3-c), in display order, with the `reasoning_effort` values ai& accepts for each (model list, 2026-10-04). The first effort is the default. */
export const selectableModels: { id: string; efforts: string[] }[] = [
  { id: "deepseek-ai/deepseek-v4-flash", efforts: ["none", "high", "max"] },
  { id: "deepseek-ai/deepseek-v4.1-flash", efforts: ["none", "high", "max"] },
  { id: "zai-org/glm-5.3-flash", efforts: ["low", "high", "max"] },
];

/** The model choice that lets &run pick the model and effort for each turn (see `auto.ts`). */
export const AUTO_MODEL = "auto";

export type TaskKind = "daily" | "complex";

export interface ModelRoute {
  model: string;
  reasoning: string;
}

/** Auto mode: the classifier that sorts a turn, and the model each kind of turn goes to. */
export const autoConfig: { classifier: ModelRoute; routes: Record<TaskKind, ModelRoute> } = {
  classifier: { model: DEFAULT_MODEL, reasoning: "none" },
  routes: {
    daily: { model: DEFAULT_MODEL, reasoning: "high" },
    complex: { model: "deepseek-ai/deepseek-v4.1-flash", reasoning: "high" },
  },
};

export function contextWindowFor(config: AgentConfig, model: string): number {
  return config.contextWindows[model] ?? DEFAULT_CONTEXT_WINDOW;
}
