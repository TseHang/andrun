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
      body: "",
    });
    expect(pull.files).toEqual([
      { path: "src/slugify.js", status: "added", additions: 2, deletions: 0, patch: PATCH },
      { path: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
    ]);
    fake.pulls.find((p) => p.number === 13)!.body = "## Why\n\nWe need **flags**.";
    expect(await github.getPull(13)).toMatchObject({ body: "## Why\n\nWe need **flags**." });
    (fake.pulls.find((p) => p.number === 12) as { body: string | null }).body = null; // GitHub sends null for an empty description
    expect(await github.getPull(12)).toMatchObject({ body: "" });
    expect(await github.getPull(16)).toMatchObject({ fork: true });
    expect(await github.getPull(11)).toMatchObject({ state: "closed" });
    await expect(github.getPull(99)).rejects.toMatchObject({ status: 404 });
  });

  it("reads a file at the pull request's head commit", async () => {
    const odd = "docs/a b #1 é.html";
    const { fake, github } = setup({
      files: { "README.md": "# demo\n", "index.html": "<h1>hi é</h1>\n", [odd]: "<p>ok</p>\n", "empty.html": "", "big.html": "x".repeat(1_000_001) },
    });
    fake.addPull({ number: 30, title: "Page", headRef: "feat/page" });
    fake.addPull({ number: 31, title: "From a fork", headRef: "patch-1", user: "stranger", headRepo: "stranger/andrun-demo" });
    const sha = fake.refs.get("main")!;

    expect(await github.getPullFile(30, "index.html")).toBe("<h1>hi é</h1>\n");
    expect(fake.requests.at(-1)!.path).toBe(`/repos/TseHang/andrun-demo/contents/index.html?ref=${sha}`);
    // A path with spaces, # and non-ASCII characters is escaped segment by segment.
    expect(await github.getPullFile(30, odd)).toBe("<p>ok</p>\n");
    expect(fake.requests.at(-1)!.path).toBe(`/repos/TseHang/andrun-demo/contents/docs/a%20b%20%231%20%C3%A9.html?ref=${sha}`);

    expect(await github.getPullFile(30, "empty.html")).toBe(""); // an empty file is a file
    expect(await github.getPullFile(30, "missing.html")).toBeNull();
    expect(await github.getPullFile(30, "docs")).toBeNull(); // a directory
    expect(await github.getPullFile(30, "big.html")).toBeNull(); // GitHub sends no content over 1 MB

    // A path that would leave /contents/ is refused without a contents request.
    const count = fake.requests.length;
    for (const bad of ["../../pulls/30", "docs/../../../git/refs", "./index.html", "/index.html", "docs//a.html", "docs/"]) {
      expect(await github.getPullFile(30, bad), bad).toBeNull();
    }
    expect(fake.requests.slice(count).some((r) => !/\/pulls\/30$/.test(r.path))).toBe(false);

    // A fork's pull request: nothing is read (Henry, 2026-10-04).
    const before = fake.requests.length;
    expect(await github.getPullFile(31, "index.html")).toBeNull();
    expect(fake.requests.slice(before).some((r) => r.path.includes("/contents/"))).toBe(false);

    await expect(github.getPullFile(99, "index.html")).rejects.toMatchObject({ status: 404 });
    fake.fail({ path: /\/contents\//, status: 502 });
    await expect(github.getPullFile(30, "index.html")).rejects.toMatchObject({ status: 502 });
  });

  it("resolves the default branch and its head", async () => {
    const { fake, github } = setup({ defaultBranch: "trunk" });
    expect(await github.defaultBranchHead()).toEqual({ branch: "trunk", sha: fake.refs.get("trunk") });
  });

  it("tells an open, a closed and a merged pull request apart with one request", async () => {
    const { fake, github } = seeded();
    fake.addPull({ number: 20, title: "Merged", headRef: "feat/merged", state: "closed", merged: true });
    const before = fake.requests.length;
    expect(await github.pullState(14)).toBe("open");
    expect(await github.pullState(11)).toBe("closed");
    expect(await github.pullState(20)).toBe("merged");
    expect(fake.requests.slice(before).map((r) => r.path).filter((path) => path.startsWith("/repos/"))).toEqual(["/repos/TseHang/andrun-demo/pulls/14", "/repos/TseHang/andrun-demo/pulls/11", "/repos/TseHang/andrun-demo/pulls/20"]);
    await expect(github.pullState(99)).rejects.toMatchObject({ status: 404 });
  });
});
