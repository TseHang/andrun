import { describe, expect, it } from "vitest";
import { REVIEW_FOOTER, buildReview, type ReviewFinding } from "../../src/github";
import { FAKE_PAT, HUMAN } from "../support/fake-github";
import { setup } from "./helpers";

const SLUGIFY_PATCH = ["@@ -0,0 +1,6 @@", "+export function slugify(text) {", "+  return text", "+    .toLowerCase()", '+    .replace(/ /g, "-")', '+    .replace(/[^a-z0-9-]/g, "");', "+}"].join("\n");

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  path: "src/slugify.js",
  line: 4,
  severity: "high",
  text: "Two spaces in a row become two hyphens.",
  inline: true,
  dismissed: false,
  ...over,
});

const FINDINGS = [
  finding({}),
  finding({ line: 5, severity: "medium", text: "Leading and trailing hyphens are kept." }),
  finding({ path: "README.md", line: 3, severity: "medium", text: "README still shows the old name makeSlug.", inline: false }),
  finding({ line: 1, severity: "low", text: "Consider a default export", dismissed: true }),
];

describe("review (D9, P4-m)", () => {
  it("findings off the diff go into the body", () => {
    const { body, comments } = buildReview(FINDINGS);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ path: "src/slugify.js", line: 4 });
    expect(comments[0]!.body).toContain("Two spaces in a row become two hyphens.");
    expect(comments[0]!.body).toMatch(/high/i);
    expect(comments[1]).toMatchObject({ path: "src/slugify.js", line: 5 });
    expect(body).toContain("README.md:3");
    expect(body).toContain("README still shows the old name makeSlug.");
    expect(body).not.toContain("Consider a default export");
    expect(body).not.toContain("Two spaces in a row");
    expect(body.trim().endsWith(REVIEW_FOOTER)).toBe(true);
    expect(REVIEW_FOOTER).toBe("Drafted with &run, checked and posted by a human.");
  });

  it("a review without comments", () => {
    const { body, comments } = buildReview(FINDINGS.map((f) => ({ ...f, dismissed: true })));
    expect(comments).toEqual([]);
    expect(body.trim()).toBe(REVIEW_FOOTER);
  });

  it("posts the review with the PAT on the given commit", async () => {
    const { fake, github } = setup();
    const pull = fake.addPull({ number: 14, title: "Add slugify helper", headRef: "agent/1a2b3c4d-1", files: [{ filename: "src/slugify.js", status: "added", additions: 6, deletions: 0, patch: SLUGIFY_PATCH }] });
    const { body, comments } = buildReview(FINDINGS);
    const result = await github.postReview({ pr: 14, commitId: pull.headSha, verdict: "REQUEST_CHANGES", body, comments });

    expect(result.url).toMatch(/\/pull\/14#pullrequestreview-\d+$/);
    expect(fake.reviews).toHaveLength(1);
    expect(fake.reviews[0]).toMatchObject({ pull: 14, user: HUMAN, commit_id: pull.headSha, event: "REQUEST_CHANGES", body });
    expect(fake.reviews[0]!.comments).toEqual(comments.map((c) => ({ ...c, side: "RIGHT" })));
    const post = fake.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls/14/reviews"))!;
    expect(post.auth).toBe(FAKE_PAT);
    expect(fake.requests.some((r) => r.path.endsWith("/access_tokens"))).toBe(false); // the App is not involved
  });

  it("a PAT that cannot be a token is refused before any request", async () => {
    // Found in S21: a secret pasted with a stray character made the request fail in transit (HTTP 520),
    // which says nothing about the cause. Surrounding whitespace is dropped; anything else is an error.
    for (const pat of ["github_pat_abc\u200bdef", "github_pat_abc def", '"github_pat_abc"', ""]) {
      const { fake, github } = setup({}, { pat });
      await expect(github.postReview({ pr: 14, commitId: "x", verdict: "COMMENT", body: REVIEW_FOOTER, comments: [] })).rejects.toThrow(
        "GITHUB_PAT is not a valid token: set the secret again",
      );
      expect(fake.requests).toEqual([]);
    }
    const { fake, github } = setup({}, { pat: "  github_pat_fake\n" });
    fake.addPull({ number: 14, title: "T", headRef: "agent/1a2b3c4d-1" });
    await github.postReview({ pr: 14, commitId: fake.refs.get("main")!, verdict: "COMMENT", body: REVIEW_FOOTER, comments: [] });
    expect(fake.requests.at(-1)!.auth).toBe("github_pat_fake");
  });

  it("GitHub's refusal reaches the caller with its message", async () => {
    const { fake, github } = setup();
    fake.addPull({ number: 15, title: "By the reviewer", headRef: "main", user: HUMAN });
    await expect(github.postReview({ pr: 15, commitId: fake.refs.get("main")!, verdict: "APPROVE", body: REVIEW_FOOTER, comments: [] })).rejects.toThrow(
      /Can not approve your own pull request/,
    );
  });
});
