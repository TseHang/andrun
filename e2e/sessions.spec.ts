import { expect, test } from "@playwright/test";
import { createSession, sendFrame, ui, waitForStatus } from "./support";

test("list, open, delete, and not found", async ({ page, context, request }) => {
  const s = ui(page);
  const gated = await createSession(request, "first: make the failing test pass");
  await waitForStatus(request, gated, "awaiting_approval");
  const finished = await createSession(request, "second: make the failing test pass");
  const gate = await waitForStatus(request, finished, "awaiting_approval");
  await sendFrame(finished, { type: "approve", approvalId: gate.pending!.approvalId });
  await waitForStatus(request, finished, "done");

  await page.goto("/");
  const recent = s.sidebar;
  const gatedRow = recent.locator(`a[href="/s/${gated}"]`);
  const doneRow = recent.locator(`a[href="/s/${finished}"]`);
  await expect(gatedRow).toContainText("first: make the failing test pass");
  await expect(gatedRow).toContainText("Awaiting approval");
  await expect(doneRow).toContainText("Done");
  const hrefs = await recent.locator('a[href^="/s/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs.indexOf(`/s/${finished}`)).toBeLessThan(hrefs.indexOf(`/s/${gated}`)); // newest first

  await s.sidebar.locator(`a[href="/s/${gated}"]`).click();
  await expect(page).toHaveURL(`/s/${gated}`);
  const other = await context.newPage(); // a second tab on the same session
  await other.goto(`/s/${gated}`);
  await expect(ui(other).status).toHaveText("Awaiting approval");

  const more = page.getByRole("button", { name: "More" });
  await more.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this session?" });
  await expect(dialog).toContainText("stops the run");
  await expect(dialog).toContainText("removes the sandbox and history");
  await page.keyboard.press("Escape"); // closes and gives focus back
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();

  await more.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL("/");
  await expect(s.sidebar.locator(`a[href="/s/${gated}"]`)).toHaveCount(0);
  await expect(other.getByText("This session was deleted")).toBeVisible();

  for (const path of [`/s/${gated}`, "/s/not-a-uuid"]) {
    await page.goto(path);
    await expect(page.getByText("Session not found")).toBeVisible();
    await page.getByRole("link", { name: "Back to Home" }).click();
    await expect(page).toHaveURL("/");
  }
});

test("delete rate limit", async ({ page, request }) => {
  const id = await createSession(request, "[fail] keep me");
  await page.route(`**/sessions/${id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await route.fulfill({ status: 429, headers: { "content-type": "application/json", "retry-after": "60" }, body: '{"error":"too many requests"}' });
  });
  await page.goto(`/s/${id}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this session?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Too many requests. Try again in 60 seconds.")).toBeVisible();
  await expect(page).toHaveURL(`/s/${id}`);
  expect((await request.get(`/sessions/${id}`)).status()).toBe(200);
});

test("list failure keeps the last list", async ({ page, request }) => {
  const id = await createSession(request, "[fail] still listed");
  const s = ui(page);
  await page.goto("/");
  const row = s.sidebar.locator(`a[href="/s/${id}"]`);
  await expect(row).toBeVisible();

  await page.route("**/sessions", (route) => (route.request().method() === "GET" ? route.abort() : route.continue()));
  await expect(s.sidebar.getByText("Could not refresh")).toBeVisible({ timeout: 10_000 }); // the 5 s refresh
  await expect(row).toBeVisible();
});
