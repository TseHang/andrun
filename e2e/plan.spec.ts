import { expect, test } from "@playwright/test";
import { TASK, createSession, ui } from "./support";

// S6 (HI-c): the fake model's [plan] script plans three steps, completes two, then finishes.
test("the plan is shown, kept across a reload, and unfinished steps are named at the gate", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[plan] ${TASK}`);
  await page.goto(`/s/${id}`);

  const plan = s.changes.getByRole("region", { name: "Plan" });
  const steps = plan.getByRole("listitem");
  await expect(plan).toBeVisible({ timeout: 60_000 });
  await expect(steps).toHaveCount(3);

  const atGate = async () => {
    await expect(s.status).toHaveText("Awaiting approval", { timeout: 90_000 });
    await expect(steps).toContainText(["Read the code", "Fix the loop bound", "Run the tests"]);
    await expect(plan.locator('[data-plan-status="completed"]')).toHaveCount(2);
    await expect(plan.locator('[data-plan-status="in_progress"]')).toHaveText(/Run the tests/);
    // QA: nothing is being worked on while the session waits, so the step shows no spinner.
    await expect(plan.locator('[data-plan-status="in_progress"]')).toHaveAttribute("data-active", "false");
    await expect(plan.locator('[data-plan-status="pending"]')).toHaveCount(0);
    await expect(s.approval).toContainText("1 of 3 plan steps not completed");
    // The plan is a card, not timeline rows.
    await expect(s.rows("update_plan")).toHaveCount(0);
    await expect(s.rows("apply_patch")).toHaveCount(1);
    // The card sits above the Changes heading.
    const planBox = (await plan.boundingBox())!;
    const headingBox = (await s.changes.getByRole("heading", { name: "Changes" }).boundingBox())!;
    expect(planBox.y).toBeLessThan(headingBox.y);
  };
  await atGate();

  await page.reload();
  await atGate();

  // The unfinished step does not block the finish.
  await s.approval.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(s.status).toHaveText("Done");
  await expect(s.prCard).toContainText(/Pull request #\d+ opened/);
  await expect(plan).toBeVisible();
});
