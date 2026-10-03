import { expect, test } from "@playwright/test";
import { BASE, deleteAllSessions, gh, seedReviewPull, ui } from "./support";

// Spec test E (S16): the agent drafts findings, the human dismisses one, edits one, picks a verdict and posts.

test.beforeEach(async ({ request }) => {
  await gh.reset();
  await deleteAllSessions(request);
});

test("review a pull request: dismiss, edit, request changes, post", async ({ page, request }) => {
  const s = ui(page);
  const seeded = await seedReviewPull();
  const sessions = async () => ((await (await request.get(`${BASE}/sessions`)).json()) as unknown[]).length;
  const before = await sessions();

  await page.goto("/prs");
  await expect(s.prRow(14)).toContainText("Needs review");
  await s.prRow(14).getByRole("link", { name: "Start review" }).click();

  // The start page: the diff from GitHub and an editable brief. Nothing runs yet (A6).
  await expect(page).toHaveURL(/\/prs\/14$/);
  await expect(page.getByRole("heading", { name: /Add slugify helper/ })).toContainText("#14");
  await expect(page.getByText("wants to merge agent/1a2b3c4d-1 into main")).toBeVisible();
  const diff = page.getByRole("region", { name: "Files changed" });
  await expect(diff).toContainText('.replace(/ /g, "-")');
  await expect(diff.locator('[data-diff="add"]')).toHaveCount(6);
  await expect(diff).toContainText("logo.png");
  await expect(diff).toContainText("Diff not available"); // a file without a patch
  await expect(page.getByText("Nothing runs until you press Start review.")).toBeVisible();
  const brief = page.getByLabel("Review brief");
  await expect(brief).toHaveValue(/^Review this pull request\./);
  const original = await brief.inputValue();
  await brief.fill("Only check slugify.");
  await page.getByRole("button", { name: "Reset to default" }).click();
  await expect(brief).toHaveValue(original);
  await brief.fill(`${original}\nFocus on slugify.`);
  expect(await sessions()).toBe(before);

  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Read-only review")).toBeVisible();
  await expect(s.timeline.getByText("Focus on slugify.")).toBeVisible();
  await expect(s.status).toHaveText("Ready to post", { timeout: 120_000 });

  // Findings: four drafted, one of them not on a changed line.
  const finding = (text: string) => s.findings.locator("[data-finding]").filter({ hasText: text });
  await expect(s.findings.locator("[data-finding]")).toHaveCount(4);
  await expect(s.findings).toContainText("4 kept");
  await expect(finding("Two spaces in a row")).toContainText("High");
  await expect(finding("README still shows")).toContainText("In summary");
  await expect(s.rows("report_finding")).toHaveCount(4);

  // Clicking a finding jumps to its line in the diff.
  await finding("Two spaces in a row").getByRole("link", { name: "src/slugify.js:4" }).click();
  await expect(page.getByRole("tab", { name: "Files changed" })).toHaveAttribute("aria-selected", "true");
  const line = page.locator('[data-line="src/slugify.js:4"]');
  await expect(line).toBeInViewport();
  await expect(line).toContainText("Two spaces in a row become two hyphens.");

  // Dismiss one, edit another.
  await finding("Consider a default export").getByRole("button", { name: "Dismiss" }).click();
  await expect(finding("Consider a default export").getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(s.findings).toContainText("3 kept, 1 dismissed");
  await finding("Two spaces in a row").getByRole("button", { name: "Edit" }).click();
  await s.findings.getByLabel("Finding text").fill("Collapse runs of whitespace into one hyphen.");
  await s.findings.getByRole("button", { name: "Save" }).click();
  await expect(finding("Collapse runs of whitespace")).toContainText("Edited");

  // The bar says exactly what will be posted, and as whom.
  await expect(s.postBar).toContainText("2 inline comments, 1 note in the summary");
  await expect(s.postBar).toContainText("Posts to GitHub as TseHang");
  expect((await gh.state()).reviews).toEqual([]);
  await s.postBar.getByRole("radio", { name: "Request changes" }).check();
  await s.postBar.getByRole("button", { name: "Post review" }).click();

  await expect(s.status).toHaveText("Done");
  await expect(s.reviewCard).toContainText("Review posted · Request changes");
  await expect(s.reviewCard.getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", /pull\/14#pullrequestreview-\d+$/);
  await expect(s.postBar).toHaveCount(0);

  // GitHub holds exactly the kept comments, on the right lines, posted by the human.
  const state = await gh.state();
  expect(state.reviews).toHaveLength(1);
  const review = state.reviews[0]!;
  expect(review).toMatchObject({ pull: 14, user: "TseHang", event: "REQUEST_CHANGES", commit_id: seeded.headSha });
  expect(review.comments.map((c) => [c.path, c.line, c.side])).toEqual([
    ["src/slugify.js", 4, "RIGHT"],
    ["src/slugify.js", 5, "RIGHT"],
  ]);
  expect(review.comments[0]!.body).toContain("Collapse runs of whitespace into one hyphen.");
  expect(review.comments[1]!.body).toContain("Leading and trailing hyphens are kept.");
  expect(review.body).toContain("README still shows the old name makeSlug.");
  expect(review.body).not.toContain("Consider a default export");
  expect(Object.keys(state.refs)).toEqual(["main"]); // the review changed nothing in the repo
  expect(state.writes.filter((w) => !w.includes("/reviews"))).toEqual([]);

  // A posted review is closed: the composer is off and a new review starts from the pull request.
  await expect(page.getByLabel("Message to the agent")).toBeDisabled();
  await expect(page.getByRole("link", { name: "Review again" })).toHaveAttribute("href", "/prs/14");
  await page.reload();
  await expect(s.reviewCard).toContainText("Review posted · Request changes");
  await expect(s.findings).toContainText("3 kept, 1 dismissed");

  await page.goto("/prs");
  await expect(s.prRow(14)).toContainText("Reviewed");
  await expect(s.prRow(14).getByRole("link", { name: "View review" })).toHaveAttribute("href", /\/s\/[0-9a-f-]{36}$/);
  // At most two actions in a row: "Review again" lives in the posted review, not in the list.
  await expect(s.prRow(14).getByRole("link")).toHaveCount(1);
  await expect(s.prRow(14).getByRole("link", { name: "Review again" })).toHaveCount(0);
});

test("findings cannot be edited while the agent runs, and a refused review stays at the gate", async ({ page }) => {
  const s = ui(page);
  await gh.addPull({ number: 15, title: "Written by the reviewer", headRef: "feat/own", user: "TseHang", files: [{ filename: "src/slugify.js", status: "added", additions: 6, deletions: 0, patch: "@@ -0,0 +1,6 @@\n+a\n+b\n+c\n+d\n+e\n+f" }] });
  await page.goto("/prs/15");
  await page.getByRole("button", { name: "Start review" }).click();

  // While running: the findings arrive, Edit and Dismiss are off (P4-d), and there is nothing to post yet.
  await expect(s.findings.locator("[data-finding]").first()).toBeVisible({ timeout: 120_000 });
  if ((await s.status.textContent()) === "Running") {
    await expect(s.findings.getByRole("button", { name: "Dismiss" }).first()).toBeDisabled();
    await expect(s.findings).toContainText("You can edit findings when the agent has finished.");
  }
  await expect(s.status).toHaveText("Ready to post", { timeout: 120_000 });
  await expect(s.findings.getByRole("button", { name: "Dismiss" }).first()).toBeEnabled();

  // GitHub refuses Request changes on one's own pull request: the message is shown and the gate stays.
  await s.postBar.getByRole("radio", { name: "Request changes" }).check();
  await s.postBar.getByRole("button", { name: "Post review" }).click();
  await expect(s.timeline.getByText("GitHub error")).toBeVisible();
  await expect(s.timeline).toContainText("your own pull request");
  await expect(s.status).toHaveText("Ready to post");
  expect((await gh.state()).reviews).toEqual([]);

  await s.postBar.getByRole("radio", { name: "Comment" }).check();
  await s.postBar.getByRole("button", { name: "Post review" }).click();
  await expect(s.reviewCard).toContainText("Review posted · Comment");
});
