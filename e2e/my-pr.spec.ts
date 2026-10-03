import { expect, test, type APIRequestContext } from "@playwright/test";
import { TASK, createSession, deleteAllSessions, gh, sendFrame, ui, waitForStatus } from "./support";

// A7 (S17–S19): on a pull request &run opened, read the review comments, reply as TseHang,
// and ask the agent to fix one. Runs against the fake GitHub.

test.beforeEach(async ({ request }) => {
  await gh.reset();
  await deleteAllSessions(request);
});

/** A Code session whose finish was approved: pull request #12 is open. */
async function openPullRequest(request: APIRequestContext): Promise<string> {
  const id = await createSession(request, TASK);
  const snap = await waitForStatus(request, id, "awaiting_approval");
  await sendFrame(id, { type: "approve", approvalId: snap.pending!.approvalId });
  await waitForStatus(request, id, "done");
  return id;
}

test("review comments: listed, replied to as TseHang, and fixed by the agent", async ({ page, request }) => {
  const s = ui(page);
  const id = await openPullRequest(request);
  const first = await gh.addComment({ pull: 12, user: "octocat", path: "src/sum.js", line: 3, body: "Should sum([]) return 0 or throw?" });
  const second = await gh.addComment({ pull: 12, user: "octocat", path: "test/sum.test.js", line: 9, body: "Please add a case for the empty array." });
  await gh.addComment({ pull: 12, user: "TseHang", path: "test/sum.test.js", line: 9, body: "Will do.", in_reply_to_id: second.id });

  // S17: the list says a comment is waiting, and the session shows the threads.
  await page.goto("/prs");
  await expect(s.prRow(12)).toContainText("1 comment to answer");
  await s.prRow(12).getByRole("link", { name: "View session" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${id}$`));

  const panel = page.getByRole("region", { name: "Review comments" });
  await expect(panel).toContainText("1 open");
  const thread = (n: number) => panel.locator(`[data-comment="${n}"]`);
  await expect(panel.locator("[data-comment]")).toHaveCount(2);
  await expect(thread(first.id)).toContainText("octocat");
  await expect(thread(first.id)).toContainText("src/sum.js:3");
  await expect(thread(first.id)).toContainText("Should sum([]) return 0 or throw?");
  await expect(thread(second.id)).toContainText("Will do.");
  await expect(thread(second.id)).toContainText("Answered");
  await expect(panel).toContainText("The &run bot opened this pull request. Replies are posted as TseHang.");

  // S18: reply as TseHang.
  await thread(first.id).getByLabel("Reply").fill("Good catch. It should return 0.");
  await thread(first.id).getByRole("button", { name: "Reply", exact: true }).click();
  await expect(thread(first.id)).toContainText("Good catch. It should return 0.");
  await expect(thread(first.id)).toContainText("Answered");
  await expect(panel).toContainText("0 open");
  const replies = (await gh.state()).comments.filter((c) => c.in_reply_to_id === first.id);
  expect(replies).toMatchObject([{ user: "TseHang", body: "Good catch. It should return 0." }]);

  // S19: ask the agent to fix; the fix lands on the same pull request.
  await thread(second.id).getByRole("button", { name: "Ask the agent to fix" }).click();
  await expect(s.timeline.locator('[data-item="user"]').last()).toContainText("Please add a case for the empty array.");
  await expect(s.timeline.locator('[data-item="user"]').last()).toContainText("test/sum.test.js:9");
  await expect(s.status).toHaveText("Awaiting approval", { timeout: 90_000 });
  await s.approval.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(s.status).toHaveText("Done");
  await expect(s.prCard.last()).toContainText("Pull request #12 updated");
  const state = await gh.state();
  expect(state.pulls).toHaveLength(1);
  expect(state.writes.filter((w) => w.endsWith("/pulls"))).toHaveLength(1);
});

test("a reply that GitHub refuses is shown and nothing is lost", async ({ page, request }) => {
  const id = await openPullRequest(request);
  const c = await gh.addComment({ pull: 12, user: "octocat", path: "src/sum.js", line: 3, body: "Why this change?" });
  await page.goto(`/s/${id}`);
  const panel = page.getByRole("region", { name: "Review comments" });
  const thread = panel.locator(`[data-comment="${c.id}"]`);
  await gh.fail({ method: "POST", path: "/replies$", status: 502, body: { message: "Bad Gateway" } });
  await thread.getByLabel("Reply").fill("Because the loop skipped the last element.");
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(thread.getByRole("alert")).toContainText("502");
  await expect(thread.getByLabel("Reply")).toHaveValue("Because the loop skipped the last element.");
  await expect(panel).toContainText("1 open");
});
