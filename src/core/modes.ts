// Mode profiles are data (ADR D4): the loop is the same, the tools, prompt and policy differ.

import type { AgentConfig } from "./config";
import { READ_ONLY_COMMANDS_NOTE, allowlistPolicy } from "./policy";
import { CODE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT, TASK_SYSTEM_PROMPT } from "./prompts";
import type { ModeName, ModeProfile } from "./types";

export function getProfile(mode: ModeName, config: AgentConfig): ModeProfile {
  switch (mode) {
    case "code":
      return {
        name: "code",
        model: config.models.code,
        systemPrompt: CODE_SYSTEM_PROMPT,
        tools: ["list_files", "read_file", "write_file", "apply_patch", "run_command", "update_plan", "ask_user", "finish"],
        policy: allowlistPolicy(),
        network: "off",
        sandboxSetup: "tarball@sha",
        onFinish: "open_pr",
        onTextReply: "wait",
      };
    case "review":
      return {
        name: "review",
        model: config.models.review,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        tools: ["list_files", "read_file", "run_command", "report_finding", "finish"],
        toolNotes: { run_command: READ_ONLY_COMMANDS_NOTE },
        policy: allowlistPolicy(),
        network: "off",
        sandboxSetup: "pr-head@sha",
        onFinish: "draft_review",
        onTextReply: "finish",
      };
    case "task":
      return {
        name: "task",
        model: config.models.task,
        systemPrompt: TASK_SYSTEM_PROMPT,
        tools: ["list_files", "read_file", "write_file", "apply_patch", "run_command", "update_plan", "ask_user"],
        policy: allowlistPolicy(),
        sandboxSetup: "empty",
        network: "get",
        onFinish: "answer",
        onTextReply: "wait",
      };
  }
}
