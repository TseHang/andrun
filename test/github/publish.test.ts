import { describe, expect, it } from "vitest";
import { GitHubError, type PublishInput } from "../../src/github";
import { BOT } from "../support/fake-github";
import { setup } from "./helpers";

const SEED = {
  files: { "README.md": "# demo\n", "src/sum.js": "old\n", "bin/run.sh": "#!/bin/sh\necho old\n", "docs/old.md": "gone soon\n" },
  modes: { "bin/run.sh": "100755" },
};
const BRANCH = "agent/1a2b3c4d-1";

function input(fake: ReturnType<typeof setup>["fake"], over: Partial<PublishInput> = {}): PublishInput {
  return {
    branchPrefix: "agent/1a2b3c4d",
    round: 1,
    baseSha: fake.refs.get("main")!,
    baseBranch: "main",
    title: "Fix the loop bound in sum()",
    body: "The loop stopped one element early.",
    files: [
      { path: "bin/run.sh", content: "#!/bin/sh\necho new\n" },
      { path: "src/new.js", content: "export const n = 1;\n" },
      { path: "docs/old.md", deleted: true },
    ],
    ...over,
  };
}

describe("publish (D9, P4-f)", () => {
  it("opens one pull request; a retry reuses the ref and the pull request", async () => {
    const { fake, github } = setup(SEED);
    const base = fake.refs.get("main")!;
    const first = await github.publish(input(fake));

    expect(first).toMatchObject({ number: 12, branch: BRANCH, round: 1, updated: false });
    expect(first.url).toBe("https://github.com/TseHang/andrun-demo/pull/12");
    const head = fake.refs.get(BRANCH)!;
    expect(fake.commits.get(head)).toMatchObject({ parents: [base], author: BOT, message: "Fix the loop bound in sum()" });
    expect(fake.filesAt(head)).toEqual({
      "README.md": "# demo\n",
      "src/sum.js": "old\n",
      "bin/run.sh": "#!/bin/sh\necho new\n",
      "src/new.js": "export const n = 1;\n",
    });
    expect(fake.treeAt(head)["bin/run.sh"]!.mode).toBe("100755"); // a modified file keeps its mode
    expect(fake.treeAt(head)["src/new.js"]!.mode).toBe("100644");
    expect(fake.pulls).toHaveLength(1);
    expect(fake.pulls[0]).toMatchObject({ user: BOT, headRef: BRANCH, baseRef: "main", title: "Fix the loop bound in sum()", state: "open" });
    expect(fake.pulls[0]!.body).toContain("The loop stopped one element early.");
    expect(fake.refs.get("main")).toBe(base);

    const writes = fake.writes().length;
    const again = await github.publish(input(fake));
    expect(again).toMatchObject({ number: 12, url: first.url, branch: BRANCH });
    expect(fake.writes().filter((w) => !w.includes("/git/blobs") && !w.includes("/git/trees")).length).toBe(
      fake.writes().slice(0, writes).filter((w) => !w.includes("/git/blobs") && !w.includes("/git/trees")).length,
    ); // no new commit, ref or pull request
    expect(fake.refs.get(BRANCH)).toBe(head);
    expect(fake.pulls).toHaveLength(1);
  });

  it("a failure after the ref was created is finished by the retry", async () => {
    const { fake, github } = setup(SEED);
    fake.fail({ method: "POST", path: /\/pulls$/, status: 502 });
    await expect(github.publish(input(fake))).rejects.toBeInstanceOf(GitHubError);
    const head = fake.refs.get(BRANCH)!;
    expect(head).toBeDefined();
    expect(fake.pulls).toHaveLength(0);

    const result = await github.publish(input(fake));
    expect(result).toMatchObject({ number: 12, branch: BRANCH, updated: false });
    expect(fake.refs.get(BRANCH)).toBe(head); // the commit from the first attempt is reused
    expect(fake.pulls).toHaveLength(1);
  });

  it("round 2 updates the open pull request, or opens a new one when it is closed", async () => {
    const { fake, github } = setup(SEED);
    const base = fake.refs.get("main")!;
    const first = await github.publish(input(fake));
    const head1 = fake.refs.get(BRANCH)!;

    const more = [...input(fake).files, { path: "test/new.test.js", content: "// test\n" }];
    const second = await github.publish(input(fake, { files: more, title: "Add a test" }));
    expect(second).toMatchObject({ number: first.number, branch: BRANCH, round: 1, updated: true });
    const head2 = fake.refs.get(BRANCH)!;
    expect(fake.commits.get(head2)).toMatchObject({ parents: [head1], author: BOT });
    expect(fake.filesAt(head2)["test/new.test.js"]).toBe("// test\n");
    expect(fake.filesAt(head2)["docs/old.md"]).toBeUndefined();
    expect(fake.pulls).toHaveLength(1);
    // The open pull request takes the new round's title and description.
    expect(fake.pulls[0]).toMatchObject({ title: "Add a test", body: "The loop stopped one element early." });

    fake.pulls[0]!.state = "closed";
    const third = await github.publish(input(fake, { files: more, title: "Add a test" }));
    expect(third).toMatchObject({ number: 13, branch: "agent/1a2b3c4d-2", round: 2, updated: false });
    expect(fake.commits.get(fake.refs.get("agent/1a2b3c4d-2")!)).toMatchObject({ parents: [base] });
    expect(fake.refs.get(BRANCH)).toBe(head2);
    expect(fake.pulls.map((p) => p.state)).toEqual(["closed", "open"]);
  });

  it("a pull request someone else opened on the branch is not pushed to", async () => {
    // Security review: an existing pull request counts as ours only when this App's bot opened it.
    const { fake, github } = setup(SEED);
    const base = fake.refs.get("main")!;
    const theirs = fake.putCommit({ tree: fake.commits.get(base)!.tree, parents: [base], message: "theirs", author: "octocat" });
    fake.refs.set(BRANCH, theirs);
    fake.addPull({ number: 30, title: "Not ours", headRef: BRANCH, user: "octocat" });

    await expect(github.publish(input(fake))).rejects.toThrow(/agent\/1a2b3c4d-1 has a pull request that &run did not open/);
    expect(fake.refs.get(BRANCH)).toBe(theirs);
    expect(fake.pulls).toHaveLength(1);
    expect(fake.writes().filter((w) => /\/git\/(refs|commits)|\/pulls/.test(w))).toEqual([]);
  });

  it("a foreign branch is not overwritten", async () => {
    const { fake, github } = setup(SEED);
    const foreign = fake.putCommit({ tree: fake.putTree({}), parents: [], message: "someone else", author: "someone" });
    fake.refs.set(BRANCH, foreign);
    await expect(github.publish(input(fake))).rejects.toThrow(/agent\/1a2b3c4d-1 already exists/);
    expect(fake.refs.get(BRANCH)).toBe(foreign);
    expect(fake.pulls).toHaveLength(0);
    expect(fake.requests.some((r) => r.method === "PATCH" && (r.body as { force?: boolean } | null)?.force === true)).toBe(false);
  });
});
