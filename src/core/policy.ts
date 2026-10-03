// Approval policy (spec §6): allowlisted commands run freely; risky calls ask (code) or are denied (review).

import { pathsInPatch } from "./diff";
import type { ApprovalPolicy, Decision, PolicyInput } from "./types";

export const COMMAND_ALLOWLIST = [
  "npm test",
  "npm run test",
  "npm run lint",
  "node --test",
  "pnpm test",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "find",
  "pwd",
  "git diff",
  "git status",
  "git log",
  "git show",
];

// Any of these lets an allowlisted prefix chain, redirect or expand into something else.
const SHELL_OPERATORS = /[;&|<>`$\n\r]/;
// Flags that let an allowlisted program delete, execute or write files.
const WRITE_FLAGS = /(^|\s)(-delete|-exec|-execdir|-ok|-okdir|-fprint\S*|-fls|--output)(=|\s|$)/;

function isAllowlisted(command: string): boolean {
  const c = command.trim();
  if (SHELL_OPERATORS.test(c) || WRITE_FLAGS.test(c)) return false;
  return COMMAND_ALLOWLIST.some((p) => c === p || c.startsWith(`${p} `) || c.startsWith(`${p}\t`));
}

function decideCommand(mode: PolicyInput["mode"], command: string): Decision {
  if (isAllowlisted(command)) return { kind: "allow" };
  const reason = SHELL_OPERATORS.test(command)
    ? "command uses shell operators"
    : `command not in allowlist: ${command.trim().split(/\s+/)[0] ?? ""}`;
  return mode === "review" ? { kind: "deny", reason } : { kind: "ask", reason };
}

export function allowlistPolicy(): ApprovalPolicy {
  return {
    decide({ mode, tool, args }) {
      switch (tool) {
        case "run_command":
          return decideCommand(mode, typeof args.command === "string" ? args.command : "");
        case "finish":
          return { kind: "ask", reason: mode === "code" ? "finishing requires approval" : "posting requires your decision" };
        case "apply_patch": {
          const patch = typeof args.patch === "string" ? args.patch : "";
          const deleted = pathsInPatch(patch).filter((f) => f.deleted);
          return deleted.length > 0
            ? { kind: "ask", reason: `patch deletes files: ${deleted.map((f) => f.path).join(", ")}` }
            : { kind: "allow" };
        }
        default:
          return { kind: "allow" };
      }
    },
  };
}

export function autoApprove(inner: ApprovalPolicy): ApprovalPolicy {
  return {
    decide(input) {
      const d = inner.decide(input);
      return d.kind === "ask" ? { kind: "allow", auto: { reason: d.reason } } : d;
    },
  };
}
