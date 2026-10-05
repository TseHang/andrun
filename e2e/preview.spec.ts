import { expect, test } from "@playwright/test";

test("preview inlines a PR's local script while keeping the frame isolated", async ({ page }) => {
  const html = '<!doctype html><h1>Loading</h1><button>Toggle theme</button><script src="./src/snake.js"></script><script>document.querySelector("h1").textContent = Snake.label; document.querySelector("button").onclick = () => document.documentElement.dataset.theme = "light";</script>';
  const patch = `@@ -0,0 +1 @@\n+${html}`;
  await page.route("**/config", (route) => route.fulfill({ json: {
    repo: "TseHang/andrun-demo", sha: null, githubWrites: true, reviewBrief: "Review.",
    models: [{ id: "test", efforts: ["none"], contextWindow: 100000 }], defaultModel: "test", autoModel: "auto", maxTurnCost: 50, costNotice: 10, maxTaskChars: 4000,
  } }));
  await page.route("**/sessions", (route) => route.fulfill({ json: [] }));
  await page.route("**/pulls", (route) => route.fulfill({ json: { pulls: [] } }));
  await page.route("**/repo", (route) => route.fulfill({ json: { branch: "main" } }));
  await page.route("**/pulls/6", (route) => route.fulfill({ json: {
    number: 6, title: "Add theme", body: "", author: "octocat", authorAvatar: null, mine: false,
    headRef: "theme", baseRef: "main", headSha: "abc", state: "open", fork: false,
    url: "https://github.com/TseHang/andrun-demo/pull/6", additions: 1, deletions: 0, changedFiles: 1,
    files: [{ path: "index.html", status: "added", additions: 1, deletions: 0, patch }],
  } }));
  await page.route("**/pulls/6/reviews", (route) => route.fulfill({ json: { reviews: [] } }));
  await page.route("**/pulls/6/files?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    return route.fulfill({ json: { path, content: path === "index.html" ? html : 'window.Snake = { label: "Ready?" }; window.endTag = "</script>";' } });
  });
  await page.goto("/prs/6");
  const card = page.locator('[data-file="index.html"]');
  await card.getByRole("button", { name: "Preview", exact: true }).click();
  const frame = card.frameLocator("iframe");
  await expect(frame.getByRole("heading")).toHaveText("Ready?");
  await frame.getByRole("button").click();
  await expect(frame.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(card.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(card).toContainText("Module imports, other local assets and browser storage are not supported.");
  expect(await frame.locator("body").evaluate(() => {
    try { return window.parent.document.title; } catch { return "blocked"; }
  })).toBe("blocked");
});
