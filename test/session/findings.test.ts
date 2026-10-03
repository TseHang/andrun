import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModelClient } from "../support/scripted-model";
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

  it("a posted review takes no more messages", async () => {
    const r = await reviewAtGate();
    await send(r.engine, { type: "post_review", approvalId: r.approvalId, verdict: "COMMENT" });
    expect(r.engine.snapshot()!.status).toBe("done");
    const [a] = findings(r.events());
    const before = r.events().length;

    expect(await send(r.engine, { type: "message", text: "look again" })).toEqual([{ type: "rejected", reason: "This review was posted. Start a new review from Pull requests." }]);
    expect(await send(r.engine, { type: "finding", id: a!.id, dismissed: true })).toMatchObject([{ type: "rejected" }]);
    expect(r.events()).toHaveLength(before);
    expect(r.engine.snapshot()!.status).toBe("done");
    expect(r.fake.reviews).toHaveLength(1);
  });
});
