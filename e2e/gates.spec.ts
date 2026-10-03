import { expect, test } from "@playwright/test";
import { createSession, ui } from "./support";

test("a command gate can be refused or run once", async ({ page, request }) => {
  const s = ui(page);

  // Refused: the run goes on without the command.
  const refused = await createSession(request, "[ask] clean up");
  await page.goto(`/s/${refused}`);
  await expect(s.approval).toContainText("Approval required · run_command", { timeout: 60_000 });
  await expect(s.approval).toContainText("rm -rf tmp");
  await expect(s.approval).toContainText("command not in allowlist: rm");
  await s.approval.getByRole("button", { name: "Don't run" }).click();
  await expect(s.approval).toContainText("Approval required · finish", { timeout: 90_000 });
  const declined = s.rows("run_command").first();
  await expect(declined).toContainText("rm -rf tmp");
  await expect(declined).not.toContainText(/exit \d/);

  // Run once: the command runs and has an exit code.
  const allowed = await createSession(request, "[ask] clean up");
  await page.goto(`/s/${allowed}`);
  await expect(s.approval).toContainText("Approval required · run_command", { timeout: 60_000 });
  await s.approval.getByRole("button", { name: "Run once" }).click();
  await expect(s.rows("run_command").first()).toContainText(/exit 0/, { timeout: 30_000 });
});
