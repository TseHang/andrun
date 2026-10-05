import { expect, test } from "@playwright/test";
import { ui } from "./support";

test("the picked model is sent and shown", async ({ page }) => {
  await page.goto("/");
  const model = page.getByRole("button", { name: "Model" });
  await expect(model).toHaveText(/deepseek-v4-flash/);
  await model.click();
  const menu = page.getByRole("listbox", { name: "Model" });
  const options = menu.getByRole("option");
  await expect(options).toHaveCount(4);
  await expect(options).toHaveText([/^deepseek-v4-flash$/, /^deepseek-v4\.1-flash$/, /^glm-5\.3-flash$/, /^Auto/]);
  await expect(menu.getByRole("option", { name: "deepseek-v4-flash", exact: true })).toHaveAttribute("aria-selected", "true");
  const efforts = menu.getByRole("group", { name: "Reasoning" }).getByRole("button");
  await expect(efforts).toHaveText(["none", "high", "max"]);
  await expect(efforts.nth(0)).toHaveAttribute("aria-pressed", "true");

  // An effort the next model does not have falls back to that model's first one; the menu stays open for the effort.
  await menu.getByRole("option", { name: "glm-5.3-flash" }).click();
  await expect(efforts).toHaveText(["low", "high", "max"]);
  await expect(efforts.nth(0)).toHaveAttribute("aria-pressed", "true");
  await efforts.nth(1).click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(model).toHaveText(/glm-5\.3-flash\s*high/);

  const mode = page.getByRole("group", { name: "Mode" });
  // A review starts from a pull request (Review PRs in the sidebar), so the switch has no Review.
  await expect(mode.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByText("Review")).toHaveCount(0);
  await expect(mode.getByRole("button", { name: "Task" })).toBeEnabled();

  await page.getByLabel("Task").fill("make the failing test pass");
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/sessions"),
    page.getByRole("button", { name: "Run" }).click(),
  ]);
  expect(req.postDataJSON()).toEqual({ mode: "code", task: "make the failing test pass", model: "zai-org/glm-5.3-flash", reasoning: "high" });

  // The model's reasoning is in the timeline, folded once the step is done.
  await expect(ui(page).timeline.locator('[data-item="reasoning"]').first()).toContainText("Reasoning");

  await expect(ui(page).timeline.getByText(/^\S+( · \w+)? · [\d.]+k? in · [\d.]+k? out · \d+\.\ds$/).first()).toBeVisible({ timeout: 60_000 });
});

test("auto picks the model for each message and says which", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Model" }).click();
  const menu = page.getByRole("listbox", { name: "Model" });
  await menu.getByRole("option", { name: /Auto/ }).click();
  await expect(menu.getByRole("group", { name: "Reasoning" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Model" })).toHaveText(/^Auto$/);

  await page.getByLabel("Task").fill("[chat] what does sum do?");
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/sessions"),
    page.getByRole("button", { name: "Run" }).click(),
  ]);
  expect(req.postDataJSON()).toEqual({ mode: "code", task: "[chat] what does sum do?", model: "auto" });

  const routed = ui(page).timeline.locator('[data-item="routed"]');
  await expect(routed.first()).toHaveText(/Auto · daily coding → deepseek-v4-flash · high/, { timeout: 60_000 });
  const input = ui(page).composer.getByRole("textbox", { name: "Message to the agent" });
  await expect(input).toHaveAttribute("placeholder", "Reply to the agent", { timeout: 60_000 });

  // The next message is sorted again: this one goes to the model for complex work.
  await input.fill("[complex] now fix it properly");
  await ui(page).composer.getByRole("button", { name: "Send" }).click();
  await expect(routed).toHaveCount(2, { timeout: 60_000 });
  await expect(routed.nth(1)).toHaveText(/Auto · complex task → deepseek-v4\.1-flash · high/);
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

test("navigation: New session and Review PRs, review sessions are tagged", async ({ page }) => {
  const s = ui(page);
  const CODE = "11111111-1111-4111-8111-111111111111";
  const REVIEW = "22222222-2222-4222-8222-222222222222";
  await page.route("**/sessions", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: [
        { id: CODE, mode: "code", title: "Fix the loop bound", status: "done", created_at: 2, updated_at: 2 },
        { id: REVIEW, mode: "review", title: "Review PR #14: Add slugify helper", status: "awaiting_approval", created_at: 1, updated_at: 1, pr: 14 },
      ],
    });
  });
  await page.goto("/");

  await expect(s.sidebar.getByRole("link", { name: "New session" }).first()).toHaveAttribute("aria-current", "page");
  await expect(s.sidebar.getByRole("link", { name: /^Review PRs/ })).toHaveAttribute("href", "/prs");
  await expect(s.sidebar.getByRole("link", { name: "Sessions" })).toHaveCount(0);
  await expect(s.sidebar.getByRole("link", { name: /Pull requests/ })).toHaveCount(0);

  // Recent sessions are in the sidebar only; Home keeps to the composer.
  await expect(page.getByRole("region", { name: "Recent sessions" })).toHaveCount(0);
  await expect(s.sidebar.locator(`a[href="/s/${REVIEW}"] [data-tag="review"]`)).toHaveText("Review");
  await expect(s.sidebar.locator(`a[href="/s/${CODE}"] [data-tag]`)).toHaveCount(0);

  await s.sidebar.getByRole("link", { name: /^Review PRs/ }).click();
  await expect(page).toHaveURL(/\/prs$/);
  await expect(s.sidebar.getByRole("link", { name: /^Review PRs/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Review PRs" })).toBeVisible();
});
