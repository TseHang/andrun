import { expect, test } from "@playwright/test";
import { TASK, createSession, deleteSession, deleteAllSessions, gh, sendFrame, ui, waitForStatus } from "./support";

// Spec test B (S15): Approve opens a real pull request as the bot. Runs against the fake GitHub.

test.beforeEach(async ({ request }) => {
  await gh.reset();
  await deleteAllSessions(request);
});

test("approve opens a pull request and it appears under My PRs", async ({ page }) => {
  const s = ui(page);
  await page.goto("/");
  await page.getByLabel("Task").fill(TASK);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(s.status).toHaveText("Awaiting approval", { timeout: 90_000 });
  const id = page.url().split("/s/")[1]!;
  const branch = `agent/${id.slice(0, 8)}-1`;

  // The gate says where the change will go, before anything is pushed.
  await expect(s.approval).toContainText(`${branch} → main`);
  expect((await gh.state()).writes).toEqual([]);

  // The description is the agent's summary; Edit opens the fields, and the edit goes with the approval.
  await expect(s.approval).toContainText("Fix the loop bound in sum()");
  await s.approval.getByRole("button", { name: "Edit" }).click();
  await s.approval.getByLabel("Pull request description").fill("Fixed the loop bound in sum(), edited before approving.");
  await page.screenshot({ path: "test-results/pr-description-edit.png" });
  await s.approval.getByRole("button", { name: "Done" }).click();
  await expect(s.approval).toContainText("Description · edited");

  await s.approval.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(s.status).toHaveText("Done");
  await expect(s.timeline.getByText("Approved")).toBeVisible();
  await expect(s.prCard).toContainText("Pull request #12 opened");
  await expect(s.prCard).toContainText(`${branch} → main`);
  await expect(s.prCard).toContainText("Opened by the &run bot.");
  await expect(s.prCard.getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", "https://github.com/TseHang/andrun-demo/pull/12");

  const state = await gh.state();
  expect(state.pulls).toHaveLength(1);
  expect(state.pulls[0]).toMatchObject({ number: 12, user: "andrun[bot]", headRef: branch, baseRef: "main", title: "Fix the loop bound in sum()" });
  expect(state.pulls[0]!.body).toContain("Fixed the loop bound in sum(), edited before approving.");
  expect(state.authors[state.refs[branch]!]).toBe("andrun[bot]");

  // The pull request is on the Review PRs page (spec test B), under every tab it belongs to.
  const nav = s.sidebar.getByRole("link", { name: /Review PRs/ });
  await expect(nav).toContainText("1");
  await nav.click();
  await expect(page).toHaveURL(/\/prs$/);
  await expect(page.getByRole("heading", { name: "Review PRs" })).toBeVisible();
  const row = s.prRow(12);
  await expect(row).toContainText("Fix the loop bound in sum()");
  await expect(row).toContainText("#12");
  await expect(row).toContainText(branch);
  await expect(row).toContainText("Opened by &run");
  await expect(row.getByRole("link", { name: "Review with &run" })).toHaveAttribute("href", "/prs/12");
  for (const tab of ["My PRs", "Needs review", "All"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    await expect(row).toBeVisible();
  }

  // Round 2 goes to the same pull request (P4-f).
  await row.getByRole("link", { name: "View session" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
  await expect(s.composer).toContainText("Adds a commit to pull request #12");
  await s.composer.getByLabel("Message to the agent").fill("also add a test for the empty array case");
  await s.composer.getByRole("button", { name: "Send" }).click();
  await expect(s.status).toHaveText("Awaiting approval", { timeout: 90_000 });
  await s.approval.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(s.status).toHaveText("Done");
  await expect(s.prCard.last()).toContainText("Pull request #12 updated");
  expect((await gh.state()).pulls).toHaveLength(1);

  // A reload replays the same cards.
  await page.reload();
  await expect(s.prCard).toHaveCount(2);
});

test("a GitHub failure keeps the gate open and approve can be retried", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, TASK);
  await waitForStatus(request, id, "awaiting_approval");
  await page.goto(`/s/${id}`);
  await gh.fail({ method: "POST", path: "/pulls$", status: 502, body: { message: "Bad Gateway" } });

  await s.approval.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(s.timeline.getByText("GitHub error")).toBeVisible();
  await expect(s.timeline).toContainText("502");
  await expect(s.timeline).toContainText("Approve again to retry.");
  await expect(s.status).toHaveText("Awaiting approval");
  await expect(s.prCard).toHaveCount(0);

  await expect(s.approval.getByRole("button", { name: "Approve and open PR" })).toBeEnabled();
  await s.approval.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(s.status).toHaveText("Done");
  await expect(s.prCard).toContainText("Pull request #12 opened");
  expect((await gh.state()).pulls).toHaveLength(1);
});

test("delete keeps the pull request", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, TASK);
  const snap = await waitForStatus(request, id, "awaiting_approval");
  await sendFrame(id, { type: "approve", approvalId: snap.pending!.approvalId });
  await waitForStatus(request, id, "done");
  await deleteSession(request, id);

  await page.goto("/prs");
  const row = s.prRow(12);
  await expect(row).toContainText("Opened by &run");
  await expect(row.getByRole("link", { name: "View session" })).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Review with &run" })).toBeVisible();
  expect((await gh.state()).pulls).toMatchObject([{ number: 12, state: "open" }]);
});
