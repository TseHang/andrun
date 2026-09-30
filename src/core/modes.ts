// Mode profiles are data (ADR D4): the loop is the same, the tools, prompt and policy differ.

import type { AgentConfig } from "./config";
import { allowlistPolicy } from "./policy";
import { CODE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT } from "./prompts";
import type { ModeName, ModeProfile } from "./types";

export function getProfile(mode: ModeName, config: AgentConfig): ModeProfile {
  switch (mode) {
    case "code":
      return {
        name: "code",
        model: config.models.code,
        systemPrompt: CODE_SYSTEM_PROMPT,
        tools: ["list_files", "read_file", "write_file", "apply_patch", "run_command", "finish"],
        policy: allowlistPolicy(),
        sandboxSetup: "tarball@sha",
        onFinish: "open_pr",
      };
    case "review":
      return {
        name: "review",
        model: config.models.review,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        tools: ["list_files", "read_file", "run_command", "report_finding", "finish"],
        policy: allowlistPolicy(),
        sandboxSetup: "pr-head@sha",
        onFinish: "draft_review",
      };
    case "task":
      throw new Error("task mode is not implemented yet (Phase 5)");
  }
}
