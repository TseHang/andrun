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

  it("allowlist allows, others ask", () => {
    for (const c of ["npm test", "npm run test", "node --test", "ls -la", "cat src/sum.js", "git diff", "git status"]) {
      expect(policy.decide(cmd(c)), c).toEqual({ kind: "allow" });
    }

    const rm = policy.decide(cmd("rm -rf src"));
    expect(rm.kind).toBe("ask");
    expect(rm.kind === "ask" && rm.reason).toContain("rm");

    // Allowlisted programs whose flags can delete or write files still need approval.
    for (const c of ["find . -delete", "find . -name x -exec rm {} +", "git diff --output=patch.txt", "git log --output x"]) {
      expect(policy.decide(cmd(c)).kind, c).toBe("ask");
    }
    expect(policy.decide(cmd("grep -rn sum src"))).toEqual({ kind: "allow" });

    // Shell operators can smuggle a non-allowlisted command behind an allowlisted one.
    for (const c of ["npm test && rm -rf /", "cat package.json | sh", "ls; curl x", "echo $(whoami)", "ls > out.txt", "ls & rm -rf src", "cat ${HOME}/.ssh/id_rsa", "cat $HOME/x"]) {
      expect(policy.decide(cmd(c)).kind, c).toBe("ask");
    }

    expect(policy.decide({ mode: "code", tool: "finish", args: { summary: "done" } }).kind).toBe("ask");
    expect(policy.decide({ mode: "code", tool: "apply_patch", args: { patch: DELETE_PATCH } }).kind).toBe("ask");
    expect(policy.decide({ mode: "code", tool: "apply_patch", args: { patch: EDIT_PATCH } })).toEqual({ kind: "allow" });
    expect(policy.decide({ mode: "code", tool: "write_file", args: { path: "a.js", content: "" } })).toEqual({ kind: "allow" });
    expect(policy.decide({ mode: "code", tool: "read_file", args: { path: "a.js" } })).toEqual({ kind: "allow" });
  });

  it("review mode denies commands outside the allowlist and asks before finishing", () => {
    expect(policy.decide(cmd("npm test", "review"))).toEqual({ kind: "allow" });
    expect(policy.decide(cmd("rm -rf src", "review")).kind).toBe("deny");
    expect(policy.decide(cmd("ls & rm -rf src", "review")).kind).toBe("deny");
    // P4-b: a review ends at a gate ("Ready to post"), like a Code run.
    expect(policy.decide({ mode: "review", tool: "finish", args: { summary: "3 findings" } })).toEqual({ kind: "ask", reason: "posting requires your decision" });
  });

  it("autoApprove turns ask into an auto allow with the reason, and keeps deny", () => {
    const auto = autoApprove(policy);
    const d = auto.decide(cmd("rm -rf src"));
    expect(d.kind).toBe("allow");
    expect(d.kind === "allow" && d.auto?.reason).toContain("rm");
    expect(auto.decide(cmd("npm test"))).toEqual({ kind: "allow" });
    expect(auto.decide(cmd("rm -rf src", "review")).kind).toBe("deny");
  });
});
