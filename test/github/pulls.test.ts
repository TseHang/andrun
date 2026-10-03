import { describe, expect, it } from "vitest";
import { BOT } from "../support/fake-github";
import { setup } from "./helpers";

const PATCH = "@@ -0,0 +1,2 @@\n+a\n+b";

function seeded() {
  const s = setup();
  s.fake.addPull({ number: 12, title: "Handle the empty array in mean()", headRef: "agent/7f3a9c1e-1" });
  s.fake.addPull({ number: 13, title: "Add a --json flag to the CLI", headRef: "feat/json-flag", user: "octocat" });
  s.fake.addPull({
    number: 14,
    title: "Add slugify helper",
    headRef: "agent/1a2b3c4d-1",
    files: [
      { filename: "src/slugify.js", status: "added", additions: 2, deletions: 0, patch: PATCH },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    ],
  });
  s.fake.addPull({ number: 11, title: "Old", headRef: "feat/old", state: "closed" });
  s.fake.addPull({ number: 16, title: "From a fork", headRef: "patch-1", user: "stranger", headRepo: "stranger/andrun-demo" });
  return s;
}

describe("pull requests (spec D2: list, read)", () => {
  it("lists open pull requests, newest first, and marks the ones &run opened", async () => {
    const { github } = seeded();
    const pulls = await github.listPulls();
    expect(pulls.map((p) => p.number)).toEqual([16, 14, 13, 12]);
    expect(pulls.find((p) => p.number === 14)).toEqual({
      number: 14,
      title: "Add slugify helper",
      author: BOT,
      headRef: "agent/1a2b3c4d-1",
      updatedAt: expect.stringMatching(/^2026-10-03T/) as string,
      url: "https://github.com/TseHang/andrun-demo/pull/14",
      mine: true,
    });
    expect(Object.fromEntries(pulls.map((p) => [p.number, p.mine]))).toEqual({ 12: true, 13: false, 14: true, 16: false });
  });

  it("a bot pull request from another branch is not a My PR", async () => {
    const { fake, github } = setup();
    fake.addPull({ number: 20, title: "Seeded", headRef: "feat/slugify" });
    expect((await github.listPulls())[0]).toMatchObject({ author: BOT, mine: false });
  });

  it("another bot's pull request on an agent/ branch is not a My PR", async () => {
    // Security review: "mine" must mean this App's own bot, not any account ending in [bot].
    const { fake, github } = setup();
    fake.addPull({ number: 21, title: "Bump deps", headRef: "agent/deadbeef-1", user: "dependabot[bot]" });
    fake.addPull({ number: 22, title: "Ours", headRef: "agent/1a2b3c4d-1" });
    const pulls = await github.listPulls();
    expect(Object.fromEntries(pulls.map((p) => [p.number, p.mine]))).toEqual({ 21: false, 22: true });
    expect(fake.requests.filter((r) => r.path === "/app")).toHaveLength(1);
    await github.listPulls();
    expect(fake.requests.filter((r) => r.path === "/app")).toHaveLength(1); // the bot's login is looked up once
  });

  it("reads one pull request with its files", async () => {
    const { fake, github } = seeded();
    const pull = await github.getPull(14);
    expect(pull).toMatchObject({
      number: 14,
      title: "Add slugify helper",
      author: BOT,
      headRef: "agent/1a2b3c4d-1",
      baseRef: "main",
      headSha: fake.pulls.find((p) => p.number === 14)!.headSha,
      state: "open",
      fork: false,
      additions: 2,
      deletions: 0,
      changedFiles: 2,
    });
    expect(pull.files).toEqual([
      { path: "src/slugify.js", status: "added", additions: 2, deletions: 0, patch: PATCH },
      { path: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
    ]);
    expect(await github.getPull(16)).toMatchObject({ fork: true });
    expect(await github.getPull(11)).toMatchObject({ state: "closed" });
    await expect(github.getPull(99)).rejects.toMatchObject({ status: 404 });
  });

  it("resolves the default branch and its head", async () => {
    const { fake, github } = setup({ defaultBranch: "trunk" });
    expect(await github.defaultBranchHead()).toEqual({ branch: "trunk", sha: fake.refs.get("trunk") });
  });

  // ---------- A7: review comments on a pull request &run opened ----------

  function withComments() {
    const s = setup();
    s.fake.addPull({ number: 12, title: "Handle the empty array in mean()", headRef: "agent/7f3a9c1e-1" });
    const a = s.fake.addComment({ pull: 12, user: "octocat", path: "src/stats.js", line: 3, body: "Should mean([]) return 0 or throw?" });
    const b = s.fake.addComment({ pull: 12, user: "octocat", path: "test/stats.test.js", line: 9, body: "Please add a case for a single element." });
    s.fake.addComment({ pull: 12, user: "TseHang", path: b.path, line: b.line, body: "Will do.", in_reply_to_id: b.id });
    return { ...s, a, b };
  }

  it("lists review comments as threads", async () => {
    const { github, a, b } = withComments();
    const threads = await github.listReviewComments(12);
    expect(threads).toEqual([
      {
        id: a.id,
        author: "octocat",
        path: "src/stats.js",
        line: 3,
        body: "Should mean([]) return 0 or throw?",
        createdAt: expect.any(String) as string,
        url: expect.stringContaining(`#discussion_r${a.id}`) as string,
        replies: [],
        answered: false,
      },
      {
        id: b.id,
        author: "octocat",
        path: "test/stats.test.js",
        line: 9,
        body: "Please add a case for a single element.",
        createdAt: expect.any(String) as string,
        url: expect.any(String) as string,
        replies: [{ id: expect.any(Number) as number, author: "TseHang", body: "Will do.", createdAt: expect.any(String) as string }],
        answered: true,
      },
    ]);
    await expect(github.listReviewComments(99)).rejects.toMatchObject({ status: 404 });
  });

  it("replies to a review comment as the bot, the pull request's author", async () => {
    const { fake, github, a } = withComments();
    const reply = await github.replyToComment(12, a.id, "Good catch. It should throw.");
    expect(reply).toEqual({ id: expect.any(Number) as number, url: expect.stringContaining("#discussion_r") as string });
    expect(fake.comments.at(-1)).toMatchObject({ pull: 12, user: BOT, body: "Good catch. It should throw.", in_reply_to_id: a.id });
    expect(fake.requests.at(-1)!.auth).toMatch(/^ghs_/); // the App's token, not the user's PAT
    expect((await github.listReviewComments(12))[0]).toMatchObject({ answered: true });
    await expect(github.replyToComment(12, 424242, "x")).rejects.toMatchObject({ status: 404 });
  });
});
