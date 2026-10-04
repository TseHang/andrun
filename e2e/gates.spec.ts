import { expect, test } from "@playwright/test";
import { createSession, ui } from "./support";

// HI-j: Code mode asks for no command. What still asks before finish is a patch that deletes a file.
test("a patch that deletes a file can be refused or applied", async ({ page, request }) => {
  const s = ui(page);

  // Refused: the run goes on without the patch.
  const refused = await createSession(request, "[ask] clean up");
  await page.goto(`/s/${refused}`);
  await expect(s.approval).toContainText("Approval required · apply_patch", { timeout: 60_000 });
  await expect(s.approval).toContainText("patch deletes files: scratch.txt");
  await s.approval.getByRole("button", { name: "Don't apply" }).click();
  await expect(s.approval).toContainText("Approval required · finish", { timeout: 90_000 });
  await expect(s.rows("apply_patch").first()).toContainText("scratch.txt");
  await expect(s.rows("apply_patch").first()).toContainText("declined");
  // No command asked: both test runs have an exit code.
  await expect(s.rows("run_command")).toHaveCount(2);
  await expect(s.rows("run_command").first()).toContainText(/exit \d/);

  // Applied: the patch runs and the run goes on.
  const allowed = await createSession(request, "[ask] clean up");
  await page.goto(`/s/${allowed}`);
  await expect(s.approval).toContainText("Approval required · apply_patch", { timeout: 60_000 });
  await s.approval.getByRole("button", { name: "Apply" }).click();
  await expect(s.approval).toContainText("Approval required · finish", { timeout: 90_000 });
  await expect(s.rows("apply_patch").first()).not.toContainText("declined");
  await expect(s.timeline.getByText("patch failed to apply")).toHaveCount(0);
});
