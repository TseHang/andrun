// Agent limits and model choices (ADR D2, D17, D19). Model ids are placeholders until ai& access.

export interface AgentConfig {
  models: { code: string; review: string; task: string };
  /** Context window per model id, in tokens. */
  contextWindows: Record<string, number>;
  maxSteps: number;
  maxTokens: number;
  commandTimeoutMs: number;
  /** USD per million tokens, per model id. Optional: cost is omitted when unknown. */
  prices?: Record<string, { in: number; out: number }>;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;

export const defaultConfig: AgentConfig = {
  models: { code: "kimi-code", review: "kimi-code", task: "kimi-code" },
  contextWindows: {},
  maxSteps: 30,
  maxTokens: 400_000,
  commandTimeoutMs: 120_000,
};

export function contextWindowFor(config: AgentConfig, model: string): number {
  return config.contextWindows[model] ?? DEFAULT_CONTEXT_WINDOW;
}
