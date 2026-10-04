import { expect, test, type Locator } from "@playwright/test";
import { BASE, deleteAllSessions, gh, seedReviewPull, ui } from "./support";

// Spec test E (S16): the agent drafts findings, the human dismisses one, edits one, picks a verdict and posts.
// Review UX: the pull request page and the review session share one layout: the pull request, &run's review
// and the findings in the main column, the files in a panel on the right.

test.beforeEach(async ({ request }) => {
  await gh.reset();
  await deleteAllSessions(request);
});

const box = async (l: Locator) => (await l.boundingBox())!;
/** Whether `a` comes before `b` in the document. */
const precedes = async (a: Locator, b: Locator) => a.evaluate((x, y) => Boolean(x.compareDocumentPosition(y as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await b.elementHandle());

const PAGE = ["<!doctype html>", "<title>Demo</title>", '<h1 id="title">Loading</h1>', '<script>document.getElementById("title").textContent = "Hello from the page";</script>', ""].join("\n");

test("the pull request page shows the description, the review card and the files panel", async ({ page }) => {
  const s = ui(page);
  await seedReviewPull();
  await page.goto("/prs/14");

  await expect(page.getByRole("heading", { name: /Add slugify helper/ })).toContainText("#14");
  await expect(s.overview).toContainText("wants to merge agent/1a2b3c4d-1 into main");
  await expect(s.overview.getByRole("button", { name: "Description" })).toHaveAttribute("aria-expanded", "true");
  await expect(s.overview.getByRole("heading", { name: "Why" })).toBeVisible();
  await expect(s.overview.locator("strong")).toHaveText("slugs");

  // &run's review: the brief, the model, Start. Nothing runs yet.
  await expect(s.startCard.getByRole("img", { name: "&run" })).toBeVisible();
  await expect(s.startCard.getByLabel("Review brief")).toHaveValue(/^Review this pull request\./);
  await expect(s.startCard.getByRole("button", { name: "Model" })).toBeVisible();
  await expect(s.startCard.getByRole("button", { name: "Start review" })).toBeEnabled();

  // The diff is in the panel on the right, and nowhere else.
  await expect(s.files).toContainText('.replace(/ /g, "-")');
  await expect(s.files.locator("[data-file]")).toHaveCount(2);
  await expect(page.locator("[data-diff]")).toHaveCount(await s.files.locator("[data-diff]").count());
  expect(await precedes(s.overview, s.startCard)).toBe(true);
  const [card, files] = [await box(s.startCard), await box(s.files)];
  expect(card.x + card.width).toBeLessThanOrEqual(files.x + 1);
  const width = page.viewportSize()!.width - (await box(s.sidebar)).width;
  expect(files.width / width).toBeGreaterThan(0.5);
  expect(files.width / width).toBeLessThan(0.65);
});

test("the pull request page shows a loading state", async ({ page }) => {
  const s = ui(page);
  await seedReviewPull();
  await page.route("**/pulls/14", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/prs/14");
  await expect(page.getByRole("main").getByRole("status")).toContainText("Loading pull request");
  await expect(s.startCard).toBeVisible();
  await expect(page.getByRole("main").getByRole("status")).toHaveCount(0);
});

test("the files panel hides and the choice survives a reload", async ({ page, request }) => {
  const s = ui(page);
  await seedReviewPull();
  await page.goto("/prs/14");
  const card = s.files.locator('[data-file="src/slugify.js"]');
  const fold = card.getByRole("button", { name: /src\/slugify\.js/ });

  // A card folds: the header stays, the diff goes.
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(card.locator("[data-diff]")).toHaveCount(0);
  await expect(card).toContainText("+6");
  await expect(s.files.locator('[data-file="logo.png"]')).toContainText("Diff not available");
  await fold.click();
  await expect(card.locator('[data-diff="add"]')).toHaveCount(6);

  const before = (await box(s.startCard)).width;
  await s.files.getByRole("button", { name: "Hide files" }).click();
  await expect(s.files).toHaveCount(0);
  expect((await box(s.startCard)).width).toBeGreaterThan(before);
  await page.reload();
  await expect(s.startCard).toBeVisible();
  await expect(s.files).toHaveCount(0);
  await page.getByRole("button", { name: "Show files · 2" }).click();
  await expect(s.files.locator("[data-file]")).toHaveCount(2);

  // A Code session's Changes panel has its own setting.
  await s.files.getByRole("button", { name: "Hide files" }).click();
  const res = await request.post(`${BASE}/sessions`, { data: { mode: "code", task: "[chat] make the failing test pass" }, headers: { "cf-connecting-ip": "198.51.100.77" } });
  await page.goto(`/s/${((await res.json()) as { id: string }).id}`);
  await expect(s.changes).toBeVisible();
});

test("an HTML file in a pull request can be previewed", async ({ page }) => {
  const s = ui(page);
  await gh.addPull({
    number: 21,
    title: "Add a page",
    headRef: "feat/page",
    user: "octocat",
    files: [
      { filename: "index.html", status: "added", additions: 4, deletions: 0, patch: `@@ -0,0 +1,4 @@\n${PAGE.trimEnd().split("\n").map((l) => `+${l}`).join("\n")}` },
      { filename: "app.js", status: "added", additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+console.log("app");' },
      { filename: "gone.html", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-<p>a</p>\n+<p>b</p>" },
    ],
    contents: { "index.html": PAGE },
  });
  await page.goto("/prs/21");
  const card = (path: string) => s.files.locator(`[data-file="${path}"]`);

  await expect(card("app.js").getByRole("button", { name: "Preview" })).toHaveCount(0);
  await card("index.html").getByRole("button", { name: "Preview" }).click();
  const frame = card("index.html").locator("iframe");
  await expect(frame).toHaveAttribute("title", "Preview of index.html");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(card("index.html").frameLocator("iframe").getByRole("heading")).toHaveText("Hello from the page");
  await expect(card("index.html").locator("[data-diff]")).toHaveCount(0);
  await card("index.html").getByRole("button", { name: "Diff" }).click();
  await expect(card("index.html").locator('[data-diff="add"]')).toHaveCount(4);

  // The file cannot be read at the head commit: the card says so, and the diff comes back.
  await card("gone.html").getByRole("button", { name: "Preview" }).click();
  await expect(card("gone.html")).toContainText("Preview not available for this file");
  await card("gone.html").getByRole("button", { name: "Diff" }).click();
  await expect(card("gone.html").locator('[data-diff="add"]')).toHaveCount(1);

  // A fork's pull request: no review and no preview.
  await gh.addPull({ number: 22, title: "From a fork", headRef: "patch-1", user: "stranger", headRepo: "stranger/andrun-demo", files: [{ filename: "index.html", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+<h1>x</h1>" }], contents: { "index.html": PAGE } });
  await page.goto("/prs/22");
  await expect(s.startCard).toContainText("Pull requests from forks are not supported.");
  await expect(s.startCard.getByRole("button", { name: "Start review" })).toBeDisabled();
  await expect(card("index.html")).toContainText("<h1>x</h1>");
  await expect(s.files.getByRole("button", { name: "Preview" })).toHaveCount(0);
});

test("review a pull request: dismiss, edit, request changes, post", async ({ page, request }) => {
  const s = ui(page);
  const seeded = await seedReviewPull();
  const sessions = async () => ((await (await request.get(`${BASE}/sessions`)).json()) as unknown[]).length;
  const before = await sessions();

  await page.goto("/prs");
  await expect(s.prRow(14)).toContainText("Needs review");
  await s.prRow(14).getByRole("link", { name: "Review with &run" }).click();

  // The start page: the pull request, an editable brief, the diff from GitHub. Nothing runs yet (A6).
  await expect(page).toHaveURL(/\/prs\/14$/);
  await expect(page.getByRole("heading", { name: /Add slugify helper/ })).toContainText("#14");
  await expect(s.overview).toContainText("wants to merge agent/1a2b3c4d-1 into main");
  await expect(s.files).toContainText('.replace(/ /g, "-")');
  await expect(s.files.locator('[data-diff="add"]')).toHaveCount(6);
  await expect(s.files).toContainText("logo.png");
  await expect(s.files).toContainText("Diff not available"); // a file without a patch
  await expect(s.startCard).toContainText("Nothing is posted to GitHub until you choose to post.");
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

  // The same layout as the start page: no tabs; the pull request, the activity and the findings in the
  // main column; the files on the right.
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(s.overview).toContainText("wants to merge agent/1a2b3c4d-1 into main");
  const description = s.overview.getByRole("button", { name: "Description" });
  await expect(description).toHaveAttribute("aria-expanded", "false"); // read before the start (RV-g)
  await description.click();
  await expect(s.overview.getByRole("heading", { name: "Why" })).toBeVisible();
  await description.click();
  expect(await precedes(s.overview, s.rows().first())).toBe(true);
  expect(await precedes(s.rows().last(), s.findings)).toBe(true);
  await expect(s.files.locator('[data-diff="add"]')).toHaveCount(6);
  const [posts, files, bar] = [await box(s.findings), await box(s.files), await box(s.postBar)];
  expect(posts.x + posts.width).toBeLessThanOrEqual(files.x + 1);
  expect(bar.x + bar.width).toBeLessThanOrEqual(files.x + 1); // the bar does not cover the files

  // Findings: four drafted, one of them not on a changed line. Each is a post from &run.
  const finding = (text: string) => s.findings.locator("[data-finding]").filter({ hasText: text });
  await expect(s.findings.locator("[data-finding]")).toHaveCount(4);
  await expect(s.findings).toContainText("4 kept");
  await expect(finding("Two spaces in a row")).toContainText("High · Fix before merging");
  await expect(finding("Two spaces in a row").getByRole("img", { name: "&run" })).toBeVisible();
  await expect(finding("README still shows")).toContainText("In summary");
  await expect(s.rows("report_finding")).toHaveCount(4);
  const line = s.files.locator('[data-line="src/slugify.js:4"]');
  await expect(line).toContainText("Two spaces in a row become two hyphens.");
  await expect(line.getByRole("img", { name: "&run" })).toBeVisible();

  // A finding's location opens its file, even when the panel is hidden and the card folded.
  await s.files.locator('[data-file="src/slugify.js"]').getByRole("button", { name: /src\/slugify\.js/ }).click();
  await s.files.getByRole("button", { name: "Hide files" }).click();
  await expect(s.files).toHaveCount(0);
  await finding("Two spaces in a row").getByRole("link", { name: "src/slugify.js:4" }).click();
  await expect(line).toBeInViewport();
  await expect(line).toContainText("Two spaces in a row become two hyphens.");

  // Dismiss one, edit another.
  await finding("Consider a default export").getByRole("button", { name: "Dismiss" }).click();
  await expect(finding("Consider a default export").getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(s.findings).toContainText("3 kept, 1 dismissed");
  await expect(s.files).not.toContainText("Consider a default export");
  await finding("Consider a default export").getByRole("button", { name: "Restore" }).click();
  await expect(s.findings).toContainText("4 kept");
  await expect(s.files.locator('[data-line="src/slugify.js:1"]')).toContainText("Consider a default export");
  await finding("Consider a default export").getByRole("button", { name: "Dismiss" }).click();
  await expect(s.findings).toContainText("3 kept, 1 dismissed");
  await finding("Two spaces in a row").getByRole("button", { name: "Edit" }).click();
  await s.findings.getByLabel("Finding text").fill("Collapse runs of whitespace into one hyphen.");
  await s.findings.getByRole("button", { name: "Save" }).click();
  await expect(finding("Collapse runs of whitespace")).toContainText("Edited");

  // The bar says exactly what will be posted, and as whom.
  await expect(s.postBar).toContainText("2 inline comments, 1 note in the summary");
  await expect(s.postBar).toContainText("Posts to GitHub as TseHang");
  expect((await gh.state()).reviews).toEqual([]);

  // The verdict is a three-part switch; the main button says what it will do.
  const verdict = s.postBar.getByRole("radiogroup", { name: "Verdict" });
  const option = (name: string) => verdict.getByRole("radio", { name, exact: true });
  await expect(verdict.getByRole("radio")).toHaveCount(3);
  for (const name of ["Comment", "Approve", "Request changes"]) await expect(option(name).locator("svg")).toHaveCount(1);
  await expect(option("Comment")).toHaveAttribute("aria-checked", "true");
  await expect(verdict).toHaveAttribute("data-verdict", "COMMENT");
  await expect(s.postBar.getByRole("button", { name: "Post comments" })).toBeVisible();
  const duration = () => option("Comment").evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(await duration()).not.toBe("0s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await option("Comment").evaluate((el) => getComputedStyle(el).transitionProperty === "none" || getComputedStyle(el).transitionDuration === "0s")).toBe(true);
  await page.emulateMedia({ reducedMotion: null });

  await option("Approve").click();
  await expect(verdict).toHaveAttribute("data-verdict", "APPROVE");
  await expect(option("Approve")).toHaveAttribute("aria-checked", "true");
  await expect(option("Comment")).toHaveAttribute("aria-checked", "false");
  await expect(s.postBar.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  const approveColour = await option("Approve").evaluate((el) => getComputedStyle(el).color);
  await page.keyboard.press("ArrowRight"); // the arrow keys move the choice
  await expect(option("Request changes")).toHaveAttribute("aria-checked", "true");
  await expect(option("Request changes")).toBeFocused();
  await expect(verdict).toHaveAttribute("data-verdict", "REQUEST_CHANGES");
  expect(await option("Request changes").evaluate((el) => getComputedStyle(el).color)).not.toBe(approveColour);
  await expect(s.postBar.getByLabel("Comment for the agent")).toHaveCount(0); // behind "Ask &run for another look"
  await s.postBar.getByRole("button", { name: "Request changes", exact: true }).click();

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
  await expect(s.overview).toContainText("No description.");
  await page.getByRole("button", { name: "Start review" }).click();

  // While running: the findings arrive, Edit and Dismiss are off (P4-d), and there is nothing to post yet.
  await expect(s.findings.locator("[data-finding]").first()).toBeVisible({ timeout: 120_000 });
  if ((await s.status.textContent()) === "Running") {
    await expect(s.findings.getByRole("button", { name: "Dismiss" }).first()).toBeDisabled();
    await expect(s.findings).toContainText("You can edit findings when the agent has finished.");
  }
  await expect(s.status).toHaveText("Ready to post", { timeout: 120_000 });
  await expect(s.findings.getByRole("button", { name: "Dismiss" }).first()).toBeEnabled();
  const verdict = s.postBar.getByRole("radiogroup", { name: "Verdict" });

  // GitHub refuses Request changes on one's own pull request: the message is shown and the gate stays.
  await verdict.getByRole("radio", { name: "Request changes" }).click();
  await s.postBar.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(s.timeline.getByText("GitHub error")).toBeVisible();
  await expect(s.timeline).toContainText("your own pull request");
  await expect(s.status).toHaveText("Ready to post");
  expect((await gh.state()).reviews).toEqual([]);

  // Asking for another look is behind a link: the input appears focused, and a comment sends the agent back.
  const comment = s.postBar.getByLabel("Comment for the agent");
  await expect(comment).toHaveCount(0);
  await s.postBar.getByRole("button", { name: "Ask &run for another look" }).click();
  await expect(comment).toBeFocused();
  await expect(s.postBar.getByRole("button", { name: "Send" })).toBeDisabled();
  await comment.fill("Check the tests again.");
  await s.postBar.getByRole("button", { name: "Send" }).click();
  await expect(s.timeline).toContainText("Check the tests again.");
  await expect(s.status).toHaveText("Ready to post", { timeout: 120_000 });
  expect((await gh.state()).reviews).toEqual([]);

  await verdict.getByRole("radio", { name: "Comment" }).click();
  await s.postBar.getByRole("button", { name: "Post comments" }).click();
  await expect(s.reviewCard).toContainText("Review posted · Comment");
});
