import { expect, test } from "@playwright/test";
import { TASK, createSession, ui } from "./support";

// S6 (HI-c): the fake model's [plan] script plans three steps, completes two, then finishes.
test("the plan is shown, kept across a reload, and unfinished steps are named at the gate", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[plan] ${TASK}`);
  await page.goto(`/s/${id}`);

  // The plan sits at the top of the side panel, above the pull request approval.
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
    // The plan is above the approval, and nothing of it floats over the conversation.
    const planBox = (await plan.boundingBox())!;
    const approvalBox = (await s.approval.boundingBox())!;
    expect(planBox.y + planBox.height).toBeLessThanOrEqual(approvalBox.y);
    await expect(page.locator('[data-slot="floating-bar"]').getByRole("region", { name: "Plan" })).toHaveCount(0);
    // Its header folds it to one line and opens it again.
    const toggle = plan.getByRole("button", { name: /Plan/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(steps).toHaveCount(0);
    await expect(plan).toContainText("Plan · 2 of 3 done");
    await toggle.click();
    await expect(steps).toHaveCount(3);
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
