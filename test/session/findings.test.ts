import { afterEach, describe, expect, it } from "vitest";
import { REVIEW_FOOTER } from "../../src/github";
import { ScriptedModelClient, call } from "../support/scripted-model";
import { fixtureTarball } from "../support/tarball";
import { BRIEF, ID, PR_FILES, REVIEW_SCRIPT, SLUGIFY_FIXTURE, codeAtGate, containers, findings, ofType, reviewAtGate, send, world } from "./github-world";

afterEach(async () => {
  await Promise.all(containers.splice(0).map((c) => c.cleanup()));
});

describe("findings (S13, P4-c, P4-d)", () => {
  it("edit, dismiss and restore are stored and replayed", async () => {
    const r = await reviewAtGate();
    const [a, b] = findings(r.events());
    const count = ofType(r.events(), "review_finding").length;

    expect(await send(r.engine, { type: "finding", id: a!.id, text: "  new text  " })).toEqual([]);
    expect(findings(r.events())[0]).toMatchObject({ id: a!.id, path: a!.path, line: a!.line, severity: a!.severity, text: "new text", edited: true, dismissed: false, inline: true });

    await send(r.engine, { type: "finding", id: b!.id, dismissed: true });
    expect(findings(r.events())[1]).toMatchObject({ id: b!.id, text: b!.text, dismissed: true, edited: false });
    await send(r.engine, { type: "finding", id: b!.id, dismissed: false });
    expect(findings(r.events())[1]).toMatchObject({ id: b!.id, dismissed: false });

    // One event per accepted frame, each also broadcast; the order of the list is unchanged.
    expect(ofType(r.events(), "review_finding")).toHaveLength(count + 3);
    expect(r.frames.filter((f) => f.type === "review_finding")).toHaveLength(count + 3);
    expect(findings(r.events()).map((f) => f.id)).toEqual(findings(r.events().slice(0, -3)).map((f) => f.id));
    const seqs = r.events().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(r.engine.snapshot()!.status).toBe("awaiting_approval");

    // A new engine over the same storage (an evicted Durable Object) posts the edited state.
    const woken = r.engine; // the engine keeps nothing about findings in memory: the post reads the table
    await send(woken, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT" });
    expect(r.fake.reviews[0]!.comments[0]!.body).toContain("new text");
  });

  it("invalid finding frames are refused", async () => {
    const r = await reviewAtGate();
    const [a] = findings(r.events());
    const before = r.events().length;
    const refused = async (frame: Record<string, unknown>, reason: RegExp) => {
      const replies = await send(r.engine, frame);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ type: "rejected" });
      expect((replies[0] as { reason: string }).reason).toMatch(reason);
    };
    await refused({ type: "finding", id: "nope", dismissed: true }, /no such finding/);
    await refused({ type: "finding", id: a!.id, text: "   " }, /text/);
    await refused({ type: "finding", id: a!.id, text: "x".repeat(4001) }, /4000/);
    await refused({ type: "finding", id: a!.id }, /text or dismissed/);
    await refused({ type: "finding", id: a!.id, dismissed: "yes" }, /dismissed/);
    expect(r.events()).toHaveLength(before);
  });

  it("findings cannot be edited while the agent runs", async () => {
    const w = world({ tarball: fixtureTarball(SLUGIFY_FIXTURE) });
    const engine = w.engine(new ScriptedModelClient(REVIEW_SCRIPT()));
    engine.create({ id: ID, mode: "review", task: BRIEF, sha: w.fake.refs.get("main")!, pr: { number: 14, title: "T", files: PR_FILES } });
    const replies: unknown[] = [];
    engine.handleFrame(JSON.stringify({ type: "finding", id: "any", dismissed: true }), (f) => replies.push(f));
    expect(replies).toEqual([{ type: "rejected", reason: "You can edit findings when the agent has finished." }]);
    await engine.idle();
  });

  it("a finding frame sent the moment the gate appears waits for the run to wind down", async () => {
    // Found by the E2E run: "Ready to post" is broadcast while the segment is still saving changes.
    // A click in that window must not be refused as "the agent is running".
    const w = world({ tarball: fixtureTarball(SLUGIFY_FIXTURE) });
    const replies: unknown[] = [];
    let id: string | undefined;
    const engine: ReturnType<typeof w.engine> = w.engine(new ScriptedModelClient(REVIEW_SCRIPT()), {
      broadcast: (frame) => {
        if (frame.type === "review_finding") id ??= frame.id;
        if (frame.type === "status" && frame.status === "awaiting_approval") {
          engine.handleFrame(JSON.stringify({ type: "finding", id, dismissed: true }), (f) => replies.push(f));
        }
      },
    });
    engine.create({ id: ID, mode: "review", task: BRIEF, sha: w.fake.refs.get("main")!, pr: { number: 14, title: "T", files: PR_FILES } });
    await engine.idle();
    expect(replies).toEqual([]);
    expect(findings(w.events())[0]).toMatchObject({ id, dismissed: true });
  });

  it("invalid post_review frames are refused", async () => {
    const r = await reviewAtGate();
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "MERGE" })).toMatchObject([{ type: "rejected" }]);
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId })).toMatchObject([{ type: "rejected" }]);
    expect(await send(r.engine, { type: "post_review", approvalId: "stale", verdict: "COMMENT" })).toEqual([{ type: "rejected", reason: "no such pending approval" }]);
    expect(r.fake.reviews).toEqual([]);

    const g = await codeAtGate();
    expect(await send(g.engine, { type: "post_review", approvalId: g.approvalId, verdict: "COMMENT" })).toMatchObject([{ type: "rejected" }]);
    expect(await send(g.engine, { type: "finding", id: "x", dismissed: true })).toMatchObject([{ type: "rejected" }]);
    expect(g.engine.snapshot()!.status).toBe("awaiting_approval");
  });

  it("the reviewer's comment is posted at the top of the review body", async () => {
    const r = await reviewAtGate();
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT", comment: 42 })).toMatchObject([{ type: "rejected" }]);
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT", comment: "x".repeat(4001) })).toMatchObject([{ type: "rejected" }]);
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT", comment: "  Please fix the hyphens first.  " })).toEqual([]);
    expect(r.fake.reviews).toHaveLength(1);
    expect(r.fake.reviews[0]!.body).toMatch(/^Please fix the hyphens first\.\n\n/);
    expect(r.fake.reviews[0]!.body.endsWith(REVIEW_FOOTER)).toBe(true);
  });

  it("a review that says nothing is refused, except an approval", async () => {
    const r = await reviewAtGate();
    for (const f of findings(r.events())) await send(r.engine, { type: "finding", id: f.id, dismissed: true });
    const refused = [{ type: "rejected", reason: "Write a comment or keep a finding to post this review." }];
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT" })).toEqual(refused);
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "REQUEST_CHANGES", comment: "   " })).toEqual(refused);
    expect(r.fake.reviews).toEqual([]);
    expect(r.engine.snapshot()!.status).toBe("awaiting_approval");

    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT", comment: "Nothing to add." })).toEqual([]);
    expect(r.fake.reviews[0]).toMatchObject({ event: "COMMENT", body: `Nothing to add.\n\n${REVIEW_FOOTER}`, comments: [] });
  });

  it("a review that was posted is not posted twice", async () => {
    // Security review: the review reached GitHub, but the session was interrupted before the gate closed.
    const r = await reviewAtGate();
    const url = "https://github.com/TseHang/andrun-demo/pull/14#pullrequestreview-1";
    r.store().saveGithubState({ posted: { url, verdict: "COMMENT", approvalId: r.approvalId } });
    expect(await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT" })).toEqual([]);
    expect(r.fake.reviews).toEqual([]); // GitHub is not asked again
    expect(ofType(r.events(), "review_posted")).toEqual([]);
    expect(r.engine.snapshot()!.status).toBe("done");

    // A record from before gates were stored (no approvalId) is this gate's too.
    const old = await reviewAtGate({ extra: [call("finish", { summary: "Nothing new." })] });
    old.store().saveGithubState({ posted: { url, verdict: "COMMENT" } });
    expect(await send(old.engine, { type: "post_review", approvalId: old.approvalId, verdict: "COMMENT" })).toEqual([]);
    expect(old.fake.reviews).toEqual([]);
    // A message after it opens the next round: the old findings count as posted, and the next post goes out.
    await send(old.engine, { type: "message", text: "anything else?" });
    const next = old.engine.snapshot()!.pending!.approvalId;
    expect(await send(old.engine, { type: "post_review", approvalId: next, verdict: "COMMENT", comment: "No." })).toEqual([]);
    expect(old.fake.reviews).toHaveLength(1);
    expect(old.fake.reviews[0]).toMatchObject({ body: `No.\n\n${REVIEW_FOOTER}`, comments: [] });
  });

  it("a posted review stays open: the next review carries only what is new", async () => {
    const r = await reviewAtGate({
      extra: [call("report_finding", { path: "src/slugify.js", line: 3, severity: "medium", text: "Digits are dropped." }), call("finish", { summary: "One more finding." })],
    });
    await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT" });
    expect(r.engine.snapshot()!.status).toBe("done");
    const [a] = findings(r.events());

    // What is on GitHub cannot be edited any more.
    expect(await send(r.engine, { type: "finding", id: a!.id, dismissed: true })).toEqual([{ type: "rejected", reason: "This finding was posted." }]);

    // A message sends the agent back in; its finish asks again.
    expect(await send(r.engine, { type: "message", text: "look at digits too" })).toEqual([]);
    const second = r.engine.snapshot()!;
    expect(second.status).toBe("awaiting_approval");
    expect(second.pending!.approvalId).not.toBe(r.approvalId);
    expect(await send(r.engine, { type: "finding", id: a!.id, dismissed: true })).toEqual([{ type: "rejected", reason: "This finding was posted." }]);

    expect(await send(r.engine, { type: "post_review", approvalId: second.pending!.approvalId, verdict: "REQUEST_CHANGES", comment: "One more." })).toEqual([]);
    expect(r.fake.reviews).toHaveLength(2);
    expect(r.fake.reviews[1]).toMatchObject({ event: "REQUEST_CHANGES", body: `One more.\n\n${REVIEW_FOOTER}` });
    expect(r.fake.reviews[1]!.comments.map((c) => c.body)).toEqual(["**Medium:** Digits are dropped."]);
    expect(ofType(r.events(), "review_posted")).toHaveLength(2);
    expect(r.engine.snapshot()!.status).toBe("done");
  });
});
