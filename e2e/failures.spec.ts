import { expect, test } from "@playwright/test";
import { BASE, TASK, createSession, ui } from "./support";

test("a killed sandbox and a failing model end in a visible failure", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[slow] ${TASK}`);
  await page.goto(`/s/${id}`);
  await expect(s.rows("run_command")).toHaveCount(1, { timeout: 60_000 });

  // S11 / spec test D: the sandbox disappears mid-run.
  expect((await request.post(`${BASE}/sessions/${id}/debug/kill-sandbox`)).status()).toBe(200);
  await expect(s.timeline.getByText("The sandbox was lost")).toBeVisible({ timeout: 60_000 });
  await expect(s.status).toHaveText("Failed");
  await expect(s.sidebar.locator(`a[href="/s/${id}"]`)).toContainText("Failed");
  await expect(page.locator("[data-spinner]")).toHaveCount(0);

  await s.composer.getByLabel("Message to the agent").fill("continue");
  await s.composer.getByRole("button", { name: "Send" }).click();
  await expect(s.rows("sandbox_setup")).toHaveCount(2, { timeout: 60_000 });
  await expect(s.status).toHaveText(/Running|Awaiting approval/);
  await expect(s.status).toHaveText("Awaiting approval", { timeout: 150_000 });

  // A model that always fails.
  const failing = await createSession(request, "[fail] x");
  await page.goto(`/s/${failing}`);
  await expect(s.timeline.getByText("ai& did not answer")).toBeVisible({ timeout: 90_000 });
  await expect(s.status).toHaveText("Failed");
});
