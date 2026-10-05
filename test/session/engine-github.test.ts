import { afterEach, describe, expect, it } from "vitest";
import { BOT, HUMAN } from "../support/fake-github";
import { ScriptedModelClient, call } from "../support/scripted-model";
import { fixtureTarball } from "../support/tarball";
import {
  BRANCH,
  BRIEF,
  HAPPY,
  ID,
  IP,
  PR_FILES,
  SLUGIFY_FIXTURE,
  SUM_FIXTURE,
  TASK,
  codeAtGate,
  containers,
  findings,
  ofType,
  reviewAtGate,
  send,
  world,
} from "./github-world";

afterEach(async () => {
  await Promise.all(containers.splice(0).map((c) => c.cleanup()));
});

describe("Code: approve opens the pull request (S4–S7, S9)", () => {
  it("approve publishes from stored changes and ends as done", async () => {
    const g = await codeAtGate();
    await g.container.destroy(); // the sandbox idled out during the wait (L5)
    const starts = g.container.starts.length;
    const before = g.events().length;

    expect(await send(g.engine, { type: "approve", approvalId: g.approvalId })).toEqual([]);

    const tail = g.events().slice(before);
    expect(tail.map((e) => e.type)).toEqual(["pr_opened", "approval_resolved", "status", "status"]);
    expect(tail[0]).toMatchObject({ type: "pr_opened", url: "https://github.com/TseHang/andrun-demo/pull/12", number: 12, branch: BRANCH });
    expect(tail[0]).not.toHaveProperty("updated");
    expect(tail[1]).toMatchObject({ approved: true });
    expect(tail.at(-1)).toMatchObject({ status: "done" });

    expect(g.fake.pulls).toHaveLength(1);
    const pull = g.fake.pulls[0]!;
    expect(pull).toMatchObject({ user: BOT, headRef: BRANCH, baseRef: "main", title: "Fix the loop bound in sum()" });
    expect(pull.body).toContain("Fixed the loop bound in sum(): it skipped the last element.");
    expect(pull.body).toContain(TASK);
    expect(pull.body).toContain("src/sum.js");
    expect(pull.body).toContain("Opened by &run after a human approved it.");
    const head = g.fake.filesAt(g.fake.refs.get(BRANCH)!);
    expect(head["src/sum.js"]).toContain("i < values.length; i++");
    expect(head["README.md"]).toBe("# demo\n");

    expect(g.container.starts.length).toBe(starts); // approving never rebuilds the sandbox
    expect(g.tarballRequests).toHaveLength(1);
    expect(g.guarded).toEqual([IP]);
    expect(g.upserts.at(-1)).toMatchObject({ id: ID, status: "done", pr: 12 });
    expect(g.engine.snapshot()).toMatchObject({ status: "done", pending: null, baseBranch: "main", sha: g.fake.refs.get("main"), pr: { number: 12, url: "https://github.com/TseHang/andrun-demo/pull/12", branch: BRANCH } });
  });

  it("the pull request title falls back to the session title", async () => {
    const g = await codeAtGate([...HAPPY().slice(0, 2), call("finish", { summary: "Fixed it." })]);
    await send(g.engine, { type: "approve", approvalId: g.approvalId });
    expect(g.fake.pulls[0]!.title).toBe(TASK);
  });

  it("a later approve adds a commit to the same pull request", async () => {
    const g = await codeAtGate(HAPPY(), {}, [
      call("write_file", { path: "test/empty.test.js", content: "// empty\n" }),
      call("finish", { summary: "Added a test.", title: "Add a test" }),
    ]);
    await send(g.engine, { type: "approve", approvalId: g.approvalId });
    const head1 = g.fake.refs.get(BRANCH)!;

    await send(g.engine, { type: "message", text: "also add a test" });
    const again = g.engine.snapshot()!.pending!;
    await send(g.engine, { type: "approve", approvalId: again.approvalId });

    expect(g.fake.pulls).toHaveLength(1);
    expect(g.fake.commits.get(g.fake.refs.get(BRANCH)!)!.parents).toEqual([head1]);
    expect(g.fake.filesAt(g.fake.refs.get(BRANCH)!)["test/empty.test.js"]).toBe("// empty\n");
    expect(ofType(g.events(), "pr_opened").at(-1)).toMatchObject({ number: 12, branch: BRANCH, updated: true });
    expect(g.engine.snapshot()!.status).toBe("done");
  });

  it("a GitHub error is shown and approve can be retried", async () => {
    const g = await codeAtGate();
    g.fake.fail({ method: "POST", path: /\/pulls$/, status: 502, body: { message: "Bad Gateway" } });
    expect(await send(g.engine, { type: "approve", approvalId: g.approvalId })).toEqual([]);

    const error = ofType(g.events(), "error").at(-1)!;
    expect(error).toMatchObject({ source: "github", next: "Approve again to retry." });
    expect(error.message).toMatch(/502/);
    expect(ofType(g.events(), "pr_opened")).toEqual([]);
    expect(g.engine.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { approvalId: g.approvalId } });
    expect(g.events().at(-1)!.type).not.toBe("status"); // the status did not change, so none is emitted

    await send(g.engine, { type: "approve", approvalId: g.approvalId });
    expect(g.fake.pulls).toHaveLength(1);
    expect(g.engine.snapshot()!.status).toBe("done");
  });

  it("a rate limit says when it resets", async () => {
    const g = await codeAtGate();
    const reset = Math.floor(Date.parse("2026-10-03T00:30:00Z") / 1000);
    g.fake.fail({ path: /\/git\//, status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    await send(g.engine, { type: "approve", approvalId: g.approvalId });
    const error = ofType(g.events(), "error").at(-1)!;
    expect(error.source).toBe("github");
    expect(error.message).toMatch(/rate limit/i);
    expect(error.message).toMatch(/00:30/);
    expect(g.engine.snapshot()!.status).toBe("awaiting_approval");
  });

  it("a file that was not stored blocks the pull request", async () => {
    const g = await codeAtGate();
    await g.container.destroy();
    g.store().putChange({ path: "logo.png", beforeSha: null, afterSha: "f".repeat(40), content: null, deleted: false, skipped: true });

    await send(g.engine, { type: "approve", approvalId: g.approvalId });

    expect(g.fake.writes()).toEqual([]);
    expect(ofType(g.events(), "error").at(-1)).toMatchObject({
      source: "github",
      message: "The pull request was not opened: logo.png cannot be pushed (binary or over 1 MB).",
      next: "Ask the agent to remove or replace it.",
    });
    expect(g.engine.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { approvalId: g.approvalId } });
  });

  it("kill switch and rate limit refuse GitHub writes", async () => {
    for (const reason of ["GitHub writes are disabled", "Too many requests. Try again in 60 seconds."]) {
      const g = await codeAtGate(HAPPY(), { guard: () => reason });
      const before = g.events().length;
      expect(await send(g.engine, { type: "approve", approvalId: g.approvalId })).toEqual([{ type: "rejected", reason }]);
      expect(g.fake.requests).toEqual([]);
      expect(g.events()).toHaveLength(before);
      expect(g.engine.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { approvalId: g.approvalId } });

      const r = await reviewAtGate({ guard: () => reason });
      expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT" })).toEqual([{ type: "rejected", reason }]);
      expect(r.fake.reviews).toEqual([]);
      expect(r.engine.snapshot()!.status).toBe("awaiting_approval");
    }
  });

  it("a reject at the gate is not a GitHub write", async () => {
    const g = await codeAtGate(HAPPY(), { guard: () => "GitHub writes are disabled" }, [call("finish", { summary: "Again." })]);
    expect(await send(g.engine, { type: "reject", approvalId: g.approvalId, comment: "look again" })).toEqual([]);
    expect(g.guarded).toEqual([]);
    expect(g.engine.snapshot()!.status).toBe("awaiting_approval");
  });

  it("no changes, no pull request", async () => {
    const g = await codeAtGate([call("finish", { summary: "Nothing to change." })]);
    await send(g.engine, { type: "approve", approvalId: g.approvalId });
    expect(g.fake.writes()).toEqual([]);
    expect(ofType(g.events(), "pr_opened")).toEqual([]);
    expect(ofType(g.events(), "error")).toEqual([]);
    expect(g.engine.snapshot()).toMatchObject({ status: "done", pr: null });

    // Code review: with nothing to write, the kill switch does not hold the session at the gate.
    const off = await codeAtGate([call("finish", { summary: "Nothing to change." })], { guard: () => "GitHub writes are disabled" });
    expect(await send(off.engine, { type: "approve", approvalId: off.approvalId })).not.toContainEqual({ type: "rejected", reason: "GitHub writes are disabled" });
    expect(off.engine.snapshot()).toMatchObject({ status: "done", pr: null });
  });

  it("a session without stored GitHub state", async () => {
    // Created the Phase 3 way: no sha, no base branch. The base branch is resolved when it is approved.
    const w = world();
    const engine = w.engine(new ScriptedModelClient(HAPPY()));
    engine.create({ id: ID, mode: "code", task: TASK });
    await engine.idle();
    await send(engine, { type: "approve", approvalId: engine.snapshot()!.pending!.approvalId });
    expect(w.fake.pulls[0]).toMatchObject({ baseRef: "main", headRef: BRANCH });
    expect(engine.snapshot()!.status).toBe("done");
  });

  it("a command-only change gets a file_changed event at the pause", async () => {
    const tarball = fixtureTarball(SUM_FIXTURE, {
      "package.json": '{ "name": "sum-demo", "private": true, "type": "module", "scripts": { "test": "node scripts/format.js" } }\n',
      "scripts/format.js": 'import { appendFileSync } from "node:fs";\nif (!process.env.SKIP) appendFileSync("src/sum.js", "// formatted\\n");\n',
    });
    const g = await codeAtGate([call("run_command", { command: "npm test" }), call("finish", { summary: "Formatted." })], { tarball }, [
      call("list_files", {}),
      call("finish", { summary: "Still formatted." }),
    ]);

    const changed = ofType(g.events(), "file_changed");
    expect(changed.map((e) => e.path)).toEqual(["src/sum.js"]);
    expect(changed[0]!.diff).toContain("+// formatted");
    expect(g.events().findIndex((e) => e.type === "file_changed")).toBeGreaterThan(g.events().findIndex((e) => e.type === "approval_required"));

    // Nothing changed in the next segment: the diff is not emitted again.
    await send(g.engine, { type: "reject", approvalId: g.approvalId, comment: "check once more" });
    expect(g.engine.snapshot()!.status).toBe("awaiting_approval");
    expect(ofType(g.events(), "file_changed")).toHaveLength(1);
  });
});

describe("Review: draft, gate, post (S11, S12, S14)", () => {
  it("the review task carries the numbered diff", async () => {
    const r = await reviewAtGate();
    const first = ofType(r.events(), "message")[0]!;
    expect(first).toMatchObject({ role: "user", text: BRIEF }); // the timeline shows only the brief

    const prompt = String(r.model.requests[0]!.messages.find((m) => m.role === "user")!.content);
    expect(prompt.startsWith(BRIEF)).toBe(true);
    expect(prompt).toContain("Pull request #14: Add slugify helper");
    expect(prompt).toContain("src/slugify.js");
    expect(prompt).toMatch(/^\s*2\s+\+\s{2}return title\.toLowerCase\(\)/m);

    expect(r.engine.snapshot()).toMatchObject({ mode: "review", title: "Review PR #14: Add slugify helper", sha: r.pull.headSha, pr: { number: 14 } });
    expect(r.upserts[0]).toMatchObject({ mode: "review", pr: 14 });
    expect(r.tarballRequests).toEqual([{ repo: "TseHang/andrun-demo", sha: r.pull.headSha }]);
  });

  it("a large diff is cut to file names", async () => {
    const big = "@@ -0,0 +1,3000 @@\n" + Array.from({ length: 3000 }, (_, i) => `+const value${i} = "0123456789abcdef";`).join("\n");
    const r = await reviewAtGate({ files: [...PR_FILES, { path: "src/big.js", status: "added", additions: 3000, deletions: 0, patch: big }] });
    const prompt = String(r.model.requests[0]!.messages.find((m) => m.role === "user")!.content);
    expect(prompt.length).toBeLessThan(70_000);
    expect(prompt).not.toContain("value2999");
    expect(prompt).toContain("src/big.js");
    expect(prompt).toContain("src/slugify.js");
    expect(prompt).toMatch(/too large to include.*read the files/is);
  });

  it("a review drafts findings and waits at the gate", async () => {
    const r = await reviewAtGate();
    const drafted = findings(r.events());
    expect(drafted.map((f) => [f.path, f.line, f.severity, f.inline])).toEqual([
      ["src/slugify.js", 2, "high", true],
      ["src/slugify.js", 3, "low", true],
      ["README.md", 3, "medium", false],
      ["src/slugify.js", 1, "low", true],
    ]);
    expect(drafted.every((f) => !f.dismissed && !f.edited)).toBe(true);

    // The write attempt was denied and the model was told; nothing in the workspace changed.
    const transcript = JSON.stringify(r.store().loadState()!.messages);
    expect(transcript).toMatch(/not in allowlist/);
    expect(r.container.calls.some((c) => c.argv.join(" ").includes("rm -rf src"))).toBe(false);
    expect(r.store().changes()).toEqual([]);

    expect(r.engine.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { tool: "finish", reason: "posting requires your decision" } });
    expect(r.fake.writes()).toEqual([]);

    expect(await send(r.engine, { type: "approve", approvalId: r.approvalId })).toEqual([{ type: "rejected", reason: "Choose a verdict and post the review." }]);
    expect(r.engine.snapshot()!.status).toBe("awaiting_approval");
  });

  it("post review sends kept findings with the PAT", async () => {
    const r = await reviewAtGate();
    const [high, , , nit] = findings(r.events());
    await send(r.engine, { type: "finding", id: high!.id, text: "Runs of separators must collapse into one hyphen." });
    await send(r.engine, { type: "finding", id: nit!.id, dismissed: true });
    const before = r.events().length;

    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "REQUEST_CHANGES" })).toEqual([]);

    expect(r.fake.reviews).toHaveLength(1);
    const review = r.fake.reviews[0]!;
    expect(review).toMatchObject({ pull: 14, user: HUMAN, commit_id: r.pull.headSha, event: "REQUEST_CHANGES" });
    expect(review.comments.map((c) => [c.path, c.line, c.side])).toEqual([
      ["src/slugify.js", 2, "RIGHT"],
      ["src/slugify.js", 3, "RIGHT"],
    ]);
    expect(review.comments[0]!.body).toContain("Runs of separators must collapse into one hyphen.");
    expect(review.comments[0]!.body).not.toContain("Repeated separators are not collapsed.");
    expect(review.body).toContain("README.md:3");
    expect(review.body).toContain("The README does not mention slugify.");
    expect(review.body).not.toContain("Consider a default export.");
    expect(review.body).not.toContain("Four findings"); // the agent's summary is not posted (P4-m)

    const tail = r.events().slice(before);
    expect(tail.map((e) => e.type)).toEqual(["review_posted", "approval_resolved", "status", "status"]);
    expect(tail[0]).toMatchObject({ verdict: "REQUEST_CHANGES", url: expect.stringMatching(/pullrequestreview-\d+$/) as string });
    expect(tail.at(-1)).toMatchObject({ status: "done" });
    expect(r.guarded).toEqual([IP]);
    expect(r.upserts.at(-1)).toMatchObject({ status: "done", pr: 14 });
    expect(Object.fromEntries(r.fake.refs)).toEqual({ main: r.pull.headSha }); // nothing in the repo changed
  });

  it("GitHub's refusal keeps the review at the gate", async () => {
    const r = await reviewAtGate({ author: HUMAN });
    await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "REQUEST_CHANGES" });
    const error = ofType(r.events(), "error").at(-1)!;
    expect(error.source).toBe("github");
    expect(error.message).toMatch(/your own pull request/);
    expect(ofType(r.events(), "review_posted")).toEqual([]);
    expect(r.engine.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { approvalId: r.approvalId } });

    // A comment-only review is allowed on one's own pull request.
    await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT" });
    expect(r.fake.reviews).toHaveLength(1);
    expect(r.engine.snapshot()!.status).toBe("done");
  });

  it("findings survive a sandbox rebuild", async () => {
    const r = await reviewAtGate({ extra: [call("run_command", { command: "npm test" }), call("finish", { summary: "Same findings." })] });
    await r.container.destroy();
    await send(r.engine, { type: "message", text: "run the tests too" }); // Reject + comment at the gate
    expect(r.engine.snapshot()!.status).toBe("awaiting_approval");
    expect(r.tarballRequests.map((t) => t.sha)).toEqual([r.pull.headSha, r.pull.headSha]);
    expect(findings(r.events())).toHaveLength(4);

    await send(r.engine, { type: "post_review", approvalId: r.engine.snapshot()!.pending!.approvalId, verdict: "COMMENT" });
    expect(r.fake.reviews[0]!.comments).toHaveLength(3);
  });

  it("the review profile is rebuilt from the pull request head, not the default branch", async () => {
    const w = world({ tarball: fixtureTarball(SLUGIFY_FIXTURE) });
    const head = w.fake.putCommit({ tree: w.fake.putTree({}), parents: [w.fake.refs.get("main")!], message: "head", author: "octocat" });
    const engine = w.engine(new ScriptedModelClient([call("finish", { summary: "Nothing found." })]));
    engine.create({ id: ID, mode: "review", task: BRIEF, sha: head, pr: { number: 14, title: "T", files: PR_FILES } });
    await engine.idle();
    expect(w.tarballRequests).toEqual([{ repo: "TseHang/andrun-demo", sha: head }]);
    expect(engine.snapshot()).toMatchObject({ sha: head, status: "awaiting_approval" });
  });
});

describe("Harness improvement: finish handling is the profile's (HI-d)", () => {
  it("finish handling follows the profile's onFinish", async () => {
    // open_pr: Approve opens the pull request, and the session keeps taking messages (round 2 adds a commit, G9).
    const g = await codeAtGate(HAPPY(), {}, [
      call("write_file", { path: "test/empty.test.js", content: "// empty\n" }),
      call("finish", { summary: "Added a test.", title: "Add a test" }),
    ]);
    expect(await send(g.engine, { type: "approve", approvalId: g.approvalId })).toEqual([]);
    expect(g.engine.snapshot()).toMatchObject({ status: "done", pr: { number: 12 } });
    expect(await send(g.engine, { type: "message", text: "also add a test" })).toEqual([]);
    expect(g.engine.snapshot()!.status).toBe("awaiting_approval");
    await send(g.engine, { type: "approve", approvalId: g.engine.snapshot()!.pending!.approvalId });
    expect(g.fake.pulls).toHaveLength(1);
    expect(ofType(g.events(), "pr_opened").map((e) => e.updated ?? false)).toEqual([false, true]);
    expect(g.engine.snapshot()!.status).toBe("done");

    // draft_review: Approve is not how a review ends; a posted review takes more messages (findings.test.ts).
    const r = await reviewAtGate();
    expect(await send(r.engine, { type: "approve", approvalId: r.approvalId })).toEqual([{ type: "rejected", reason: "Choose a verdict and post the review." }]);
    expect(r.engine.snapshot()).toMatchObject({ status: "awaiting_approval", pending: { approvalId: r.approvalId } });
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT" })).toEqual([]);
    expect(ofType(r.events(), "review_posted")).toHaveLength(1);
    // A Code session never accepts post_review.
    expect(await send(g.engine, { type: "post_review", approvalId: "x", verdict: "COMMENT" })).toEqual([{ type: "rejected", reason: "post_review is only for review sessions" }]);
  });
});

describe("A merged or closed pull request closes its sessions (A26)", () => {
  const MERGED = "Pull request #12 was merged. Start a new session to continue.";

  /** A Code session whose pull request #12 is open on GitHub. */
  async function published() {
    const g = await codeAtGate();
    await send(g.engine, { type: "approve", approvalId: g.approvalId });
    return g;
  }

  it("a Code session takes no more messages once its pull request is merged", async () => {
    const g = await published();
    await g.engine.refreshPr();
    expect(g.engine.snapshot()).toMatchObject({ status: "done", pr: { number: 12, state: "open" } });
    expect(g.upserts.at(-1)).not.toHaveProperty("prState");

    Object.assign(g.fake.pulls[0]!, { state: "closed", merged: true });
    await g.engine.refreshPr();
    expect(g.engine.snapshot()).toMatchObject({ status: "done", pr: { number: 12, state: "merged" } });
    expect(g.upserts.at(-1)).toMatchObject({ id: ID, status: "done", pr: 12, prState: "merged" });

    const events = g.events().length;
    const writes = g.fake.writes().length;
    expect(await send(g.engine, { type: "message", text: "also add a test" })).toEqual([{ type: "rejected", reason: MERGED }]);
    expect(g.events()).toHaveLength(events);
    expect(g.fake.writes()).toHaveLength(writes);

    // A merge is final: GitHub is not asked again.
    const requests = g.fake.requests.length;
    await g.engine.refreshPr();
    expect(g.fake.requests).toHaveLength(requests);
  });

  it("receive asks GitHub before it handles the frame", async () => {
    const g = await published();
    Object.assign(g.fake.pulls[0]!, { state: "closed", merged: true });
    const replies: unknown[] = [];
    await g.engine.receive(JSON.stringify({ type: "message", text: "also add a test" }), (r) => replies.push(r), { ip: IP });
    await g.engine.idle();
    expect(replies).toEqual([{ type: "rejected", reason: MERGED }]);
    expect(g.engine.snapshot()).toMatchObject({ status: "done", pr: { state: "merged" } });
  });

  it("many frames in a row ask GitHub once", async () => {
    const g = await published();
    const requests = () => g.fake.requests.filter((r) => r.path.endsWith("/pulls/12")).length;
    const before = requests();
    for (let i = 0; i < 5; i++) await g.engine.receive(JSON.stringify({ type: "approve", approvalId: "nope" }), () => {}, { ip: IP });
    expect(requests()).toBe(before + 1);
  });

  it("a gate that waits when the pull request is merged cannot be approved", async () => {
    const g = await codeAtGate(HAPPY(), {}, [
      call("write_file", { path: "test/empty.test.js", content: "// empty\n" }),
      call("finish", { summary: "Added a test.", title: "Add a test" }),
    ]);
    await send(g.engine, { type: "approve", approvalId: g.approvalId });
    await send(g.engine, { type: "message", text: "also add a test" });
    const approvalId = g.engine.snapshot()!.pending!.approvalId;
    Object.assign(g.fake.pulls[0]!, { state: "closed", merged: true });
    await g.engine.refreshPr();
    const writes = g.fake.writes().length;
    for (const frame of [{ type: "approve", approvalId }, { type: "reject", approvalId, comment: "no" }]) {
      expect(await send(g.engine, frame)).toEqual([{ type: "rejected", reason: MERGED }]);
    }
    expect(g.fake.writes()).toHaveLength(writes);
  });

  it("a Review session posts nothing and takes no messages once the pull request is merged", async () => {
    const r = await reviewAtGate();
    Object.assign(r.pull, { state: "closed", merged: true });
    await r.engine.refreshPr();
    expect(r.engine.snapshot()).toMatchObject({ pr: { number: 14, state: "merged" } });
    expect(r.upserts.at(-1)).toMatchObject({ mode: "review", pr: 14, prState: "merged" });
    const reason = "Pull request #14 was merged. Start a new session to continue.";
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT", comment: "Looks fine." })).toEqual([{ type: "rejected", reason }]);
    expect(await send(r.engine, { type: "message", text: "look again" })).toEqual([{ type: "rejected", reason }]);
    expect(await send(r.engine, { type: "finding", id: findings(r.events())[0]!.id, dismissed: true })).toEqual([{ type: "rejected", reason }]);
    expect(r.fake.reviews).toHaveLength(0);
  });

  it("a closed pull request closes the session until it is reopened", async () => {
    const g = await published();
    Object.assign(g.fake.pulls[0]!, { state: "closed" });
    await g.engine.refreshPr();
    expect(g.engine.snapshot()).toMatchObject({ pr: { state: "closed" } });
    expect(g.upserts.at(-1)).toMatchObject({ prState: "closed" });
    expect(await send(g.engine, { type: "message", text: "more" })).toEqual([{ type: "rejected", reason: "Pull request #12 was closed. Start a new session to continue." }]);

    Object.assign(g.fake.pulls[0]!, { state: "open" });
    await g.engine.refreshPr();
    expect(g.engine.snapshot()).toMatchObject({ pr: { state: "open" } });
    expect(g.upserts.at(-1)).not.toHaveProperty("prState");
  });

  it("keeps what it knew when GitHub cannot be reached, and asks at most once per maxAge", async () => {
    const g = await published();
    g.fake.fail({ path: /\/pulls\/12$/, status: 502 });
    await g.engine.refreshPr();
    expect(g.engine.snapshot()).toMatchObject({ pr: { state: "open" } });

    await g.engine.refreshPr();
    const requests = g.fake.requests.length;
    await g.engine.refreshPr(30_000);
    expect(g.fake.requests).toHaveLength(requests);
  });

  it("a frame that arrives while GitHub is being asked waits for that answer", async () => {
    const g = await published();
    Object.assign(g.fake.pulls[0]!, { state: "closed", merged: true });
    const requests = () => g.fake.requests.filter((r) => r.path.endsWith("/pulls/12")).length;
    const before = requests();
    const replies: unknown[] = [];
    const frame = JSON.stringify({ type: "message", text: "also add a test" });
    await Promise.all([g.engine.receive(frame, (r) => replies.push(r), { ip: IP }), g.engine.receive(frame, (r) => replies.push(r), { ip: IP })]);
    await g.engine.idle();
    expect(replies).toEqual([{ type: "rejected", reason: MERGED }, { type: "rejected", reason: MERGED }]);
    expect(requests()).toBe(before + 1);
  });

  it("a session without a pull request never asks GitHub", async () => {
    const g = await codeAtGate();
    const requests = g.fake.requests.length;
    await g.engine.refreshPr();
    expect(g.fake.requests).toHaveLength(requests);
    expect(g.engine.snapshot()!.pr).toBeNull();
  });
});
