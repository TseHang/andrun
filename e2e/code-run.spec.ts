import { expect, test } from "@playwright/test";
import { TASK, createSession, ui, waitForStatus, watch } from "./support";

test("run, watch, approve", async ({ page }) => {
  const s = ui(page);
  await page.goto("/");
  await page.getByLabel("Task").fill(TASK);
  await page.getByRole("button", { name: "Run" }).click();

  // S9: the run is visible as it happens.
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
  await expect(s.rows("sandbox_setup")).toBeVisible({ timeout: 2000 });
  await expect(s.timeline.getByText("Running the tests first.")).toBeVisible({ timeout: 60_000 });
  await expect(s.status).toHaveText("Awaiting approval", { timeout: 60_000 });
  await expect(s.rows("run_command")).toHaveCount(2);
  await expect(s.rows("run_command").first()).toContainText("npm test");
  await expect(s.rows("read_file")).toContainText("src/sum.js");
  await expect(s.rows("apply_patch")).toContainText("src/sum.js");

  // At the gate: the diff, the bar, and nothing about pull requests.
  await expect(s.changes.getByText("src/sum.js")).toBeVisible();
  await expect(s.changes.locator('[data-diff="del"]')).toHaveCount(1);
  await expect(s.changes.locator('[data-diff="add"]')).toHaveCount(1);
  await expect(s.approval).toContainText("Approval required · finish");
  await expect(s.approval).toContainText("Fixed the loop bound in sum()");
  await expect(s.approval.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/pull request|branch/i);
  await expect(s.sandbox).toHaveText("Running"); // S19

  await s.approval.getByRole("button", { name: "Approve" }).click();
  await expect(s.status).toHaveText("Done");
  await expect(s.approval).toHaveCount(0);
  await expect(page.getByText("Approved. Nothing was pushed: pull requests are not connected yet.")).toBeVisible();
  const id = page.url().split("/s/")[1]!;
  await expect(s.sidebar.locator(`a[href="/s/${id}"]`)).toContainText("Done");
  await expect(s.sandbox).toHaveText("Stopped · starts again with your next message", { timeout: 20_000 }); // S19

  // QA: once the page is left, the row comes from the session index, which must also say Done.
  await page.goto("/");
  await expect(s.sidebar.locator(`a[href="/s/${id}"]`)).toContainText("Done");
});

test("reject with a comment loops back to the gate", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, TASK);
  await waitForStatus(request, id, "awaiting_approval");
  await page.goto(`/s/${id}`);
  await expect(s.status).toHaveText("Awaiting approval");

  const seen = await watch(page, ["Sending"]);
  await s.approval.getByLabel("Comment for the agent").fill("also add a test for the empty array case");
  await s.approval.getByRole("button", { name: "Send" }).click();

  await expect(s.timeline.getByText("also add a test for the empty array case", { exact: true })).toBeVisible();
  await expect(s.status).toHaveText("Awaiting approval", { timeout: 60_000 });
  await expect(s.changes.getByText("test/empty.test.js").first()).toBeVisible();
  await expect(s.changes).toContainText("new file");
  await expect(s.changes).toContainText("This change edits a test");
  const got = await seen();
  expect(got).toContain("Sending");
  expect(got).toContain("status:Running");
});

test("a redirect is queued and then injected", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[slow] ${TASK}`);
  await page.goto(`/s/${id}`);
  await expect(s.rows("sandbox_setup")).toBeVisible();

  await s.composer.getByLabel("Message to the agent").fill("also rename the helper");
  await s.composer.getByRole("button", { name: "Send" }).click();
  const bubble = s.timeline.getByText("also rename the helper", { exact: true });
  await expect(bubble).toBeVisible({ timeout: 1000 });
  await expect(s.timeline.getByText("Queued for the next step")).toBeVisible({ timeout: 1000 });

  await expect(s.timeline.getByText("Queued for the next step")).toHaveCount(0, { timeout: 60_000 });
  await expect(bubble).toHaveCount(1);
});

test("scroll position is kept when the user scrolled up", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  const s = ui(page);
  const id = await createSession(request, `[slow] ${TASK}`);
  await page.goto(`/s/${id}`);
  // The first command's output (expanded, it failed) is long enough to scroll.
  await expect(s.rows("run_command")).toContainText("exit 1", { timeout: 60_000 });
  const scroll = (to: "top" | "bottom") =>
    s.timeline.evaluate((el, where) => el.scrollTo({ top: where === "top" ? 0 : el.scrollHeight }), to);
  const position = () => s.timeline.evaluate((el) => ({ top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight - el.scrollTop }));

  await scroll("top");
  await expect(s.rows("read_file")).toHaveCount(1, { timeout: 60_000 });
  expect((await position()).top).toBe(0); // reading older rows: not pulled down

  await scroll("bottom");
  await expect(s.rows("apply_patch")).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(async () => (await position()).bottom, { timeout: 5000 }).toBeLessThan(4); // at the bottom: follows
});
