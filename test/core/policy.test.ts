import { describe, expect, it } from "vitest";
import { allowlistPolicy, autoApprove } from "../../src/core/policy";
import type { PolicyInput } from "../../src/core/types";

const cmd = (command: string, mode: PolicyInput["mode"] = "code"): PolicyInput => ({
  mode,
  tool: "run_command",
  args: { command },
});

const DELETE_PATCH = `diff --git a/src/old.js b/src/old.js
deleted file mode 100644
--- a/src/old.js
+++ /dev/null
@@ -1 +0,0 @@
-export const x = 1;
`;

const EDIT_PATCH = `--- a/src/sum.js
+++ b/src/sum.js
@@ -1 +1 @@
-a
+b
`;

describe("S3: policy gates risky tool calls", () => {
  const policy = allowlistPolicy();

  it("Code mode allows every command; Review keeps the read-only allowlist", () => {
    // HI-j: the sandbox has no network and no secrets, and nothing leaves it without Approve.
    const commands = [
      "npm test",
      "ls -la",
      "mkdir -p site",
      "node build.js",
      "grep -rn foo src | head",
      "rm -rf tmp",
      "npm test && rm -rf /",
      "find . -delete",
      "git diff --output=patch.txt",
      "echo $(whoami) > out.txt",
    ];
    for (const c of commands) expect(policy.decide(cmd(c)), c).toEqual({ kind: "allow" });

    // What still asks in Code mode: finish, and a patch that deletes files.
    expect(policy.decide({ mode: "code", tool: "finish", args: { summary: "done" } })).toEqual({ kind: "ask", reason: "finishing requires approval" });
    const del = policy.decide({ mode: "code", tool: "apply_patch", args: { patch: DELETE_PATCH } });
    expect(del).toEqual({ kind: "ask", reason: "patch deletes files: src/old.js" });
    expect(policy.decide({ mode: "code", tool: "apply_patch", args: { patch: EDIT_PATCH } })).toEqual({ kind: "allow" });
    expect(policy.decide({ mode: "code", tool: "write_file", args: { path: "a.js", content: "" } })).toEqual({ kind: "allow" });
    expect(policy.decide({ mode: "code", tool: "read_file", args: { path: "a.js" } })).toEqual({ kind: "allow" });
    expect(policy.decide({ mode: "code", tool: "update_plan", args: { plan: [] } })).toEqual({ kind: "allow" });

    // Review is unchanged: allowlisted read-only commands run, anything else is denied.
    for (const c of ["npm test", "npm run test", "node --test", "ls -la", "cat src/sum.js", "git diff", "git status", "grep -rn sum src"]) {
      expect(policy.decide(cmd(c, "review")), c).toEqual({ kind: "allow" });
    }
    for (const c of ["mkdir -p site", "node build.js", "grep -rn foo src | head", "rm -rf tmp", "find . -delete", "git diff --output=patch.txt", "ls & rm -rf src", "cat $HOME/x"]) {
      expect(policy.decide(cmd(c, "review")).kind, c).toBe("deny");
    }
    // A trailing `2>&1` is a habit of models and changes nothing (output is already combined): it is ignored. Nothing else is.
    for (const c of ["node --test 2>&1", "npm test 2>&1", "cat src/sum.js  2>&1 "]) expect(policy.decide(cmd(c, "review")), c).toEqual({ kind: "allow" });
    for (const c of ['node --test 2>&1; echo "exit: $?"', "cat x 2>&1 | sh", "ls 2>&1 > out.txt", "ls 2>&1 2>&1", "node --test 2>out.txt", "node -e 1 2>&1", "2>&1"]) {
      expect(policy.decide(cmd(c, "review")).kind, c).toBe("deny");
    }
    // A refusal says what would be accepted, so the model has a next step instead of a guess.
    const refused = policy.decide(cmd("node -e 1 2>&1", "review"));
    expect(refused.kind === "deny" && refused.reason).toMatch(/^command not in allowlist: node\. /);
    const piped = policy.decide(cmd("cat a | head", "review"));
    expect(piped.kind === "deny" && piped.reason).toMatch(/^command uses shell operators\. /);
    for (const d of [refused, piped]) {
      const reason = d.kind === "deny" ? d.reason : "";
      for (const allowed of ["npm test", "node --test", "cat", "grep", "git show"]) expect(reason).toContain(allowed);
      expect(reason).toMatch(/no pipes/i);
    }
    const rm = policy.decide(cmd("rm -rf src", "review"));
    expect(rm.kind === "deny" && rm.reason).toContain("rm");
    // P4-b: a review ends at a gate ("Ready to post"), like a Code run.
    expect(policy.decide({ mode: "review", tool: "finish", args: { summary: "3 findings" } })).toEqual({ kind: "ask", reason: "posting requires your decision" });
  });

  it("autoApprove turns ask into an auto allow with the reason, and keeps deny", () => {
    const auto = autoApprove(policy);
    const d = auto.decide({ mode: "code", tool: "finish", args: { summary: "done" } });
    expect(d).toEqual({ kind: "allow", auto: { reason: "finishing requires approval" } });
    expect(auto.decide(cmd("npm test"))).toEqual({ kind: "allow" });
    expect(auto.decide(cmd("rm -rf src", "review")).kind).toBe("deny");
  });
});


it("task mode runs any command; a deleting patch still asks", () => {
  const policy = allowlistPolicy();
  const command = "curl -s https://example.com | head";
  expect(policy.decide(cmd(command, "task"))).toEqual({ kind: "allow" });
  expect(policy.decide(cmd(command, "review")).kind).toBe("deny");
  expect(policy.decide({ mode: "task", tool: "apply_patch", args: { patch: DELETE_PATCH } }).kind).toBe("ask");
});
