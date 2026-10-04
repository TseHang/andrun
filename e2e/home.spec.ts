import { expect, test } from "@playwright/test";
import { ui } from "./support";

test("the picked model is sent and shown", async ({ page }) => {
  await page.goto("/");
  const model = page.getByRole("button", { name: "Model" });
  await expect(model).toHaveText(/deepseek-v4-flash/);
  await model.click();
  const menu = page.getByRole("listbox", { name: "Model" });
  const options = menu.getByRole("option");
  await expect(options).toHaveCount(5);
  await expect(options).toHaveText([/^deepseek-v4-flash$/, /^deepseek-v4-pro$/, /^kimi-k2\.7-code$/, /^glm-5\.3$/, /Auto.*Not available yet/]);
  await expect(menu.getByRole("option", { name: "deepseek-v4-flash" })).toHaveAttribute("aria-selected", "true");
  await expect(menu.getByRole("option", { name: /Auto/ })).toBeDisabled();
  await menu.getByRole("option", { name: "deepseek-v4-pro" }).click();
  await expect(menu).toHaveCount(0);
  await expect(model).toHaveText(/deepseek-v4-pro/);

  const mode = page.getByRole("group", { name: "Mode" });
  // Phase 4 enables Review: a review starts from a pull request, so the switch leads to the list (G6).
  await expect(mode.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/prs");
  await expect(mode.getByRole("button", { name: "Task" })).toBeDisabled();

  await page.getByLabel("Task").fill("make the failing test pass");
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/sessions"),
    page.getByRole("button", { name: "Run" }).click(),
  ]);
  expect(req.postDataJSON()).toEqual({ mode: "code", task: "make the failing test pass", model: "deepseek-ai/deepseek-v4-pro" });

  await expect(ui(page).timeline.getByText(/^[\d.]+k? in · [\d.]+k? out · \d+\.\ds$/).first()).toBeVisible({ timeout: 60_000 });
});

test("429, 503 and 400 are shown without losing the task", async ({ page }) => {
  const answers: { status: number; headers: Record<string, string>; body: { error: string } }[] = [
    { status: 429, headers: { "retry-after": "60" }, body: { error: "too many requests" } },
    { status: 503, headers: {}, body: { error: "new sessions are disabled" } },
    { status: 400, headers: {}, body: { error: "task must be a non-empty string of at most 4000 characters" } },
  ];
  await page.route("**/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const a = answers.shift()!;
    await route.fulfill({ status: a.status, headers: { "content-type": "application/json", ...a.headers }, body: JSON.stringify(a.body) });
  });
  await page.goto("/");
  const task = page.getByLabel("Task");
  const run = page.getByRole("button", { name: "Run" });

  await expect(task).toHaveAttribute("placeholder", "Start your work, ship new feature!");
  await expect(task).toHaveValue("");
  await expect(run).toBeDisabled();
  await task.fill("x".repeat(4001));
  expect((await task.inputValue()).length).toBe(4000);

  await task.fill("keep me");
  await run.click();
  await expect(page.getByText("Too many new sessions. Try again in 60 seconds.")).toBeVisible();
  await run.click();
  await expect(page.getByText("New sessions are turned off. Existing sessions still work.")).toBeVisible();
  await run.click();
  await expect(page.getByText("task must be a non-empty string of at most 4000 characters")).toBeVisible();
  await expect(task).toHaveValue("keep me");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("keyboard", async ({ page }) => {
  let posted = 0;
  await page.route("**/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posted++;
    await route.fulfill({ status: 429, headers: { "content-type": "application/json", "retry-after": "60" }, body: '{"error":"too many requests"}' });
  });
  await page.goto("/");
  const task = page.getByLabel("Task");
  await task.fill("make the failing test pass");
  await task.press("ControlOrMeta+Enter");
  await expect(page.getByText("Too many new sessions. Try again in 60 seconds.")).toBeVisible();
  expect(posted).toBe(1);

  // The model menu closes on Escape and gives focus back.
  const model = page.getByRole("button", { name: "Model" });
  await model.click();
  await expect(page.getByRole("listbox", { name: "Model" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Model" })).toHaveCount(0);
  await expect(model).toBeFocused();

  // Focus is visible on keyboard focus.
  await task.focus();
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { tag: el.tagName, outline: s.outlineStyle !== "none" && s.outlineWidth !== "0px", shadow: s.boxShadow !== "none" };
  });
  expect(ring.tag).toBe("BUTTON");
  expect(ring.outline || ring.shadow).toBe(true);
});
