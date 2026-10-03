import { expect, test } from "@playwright/test";
import { gh, seedReviewPull, ui } from "./support";

test.beforeEach(async () => {
  await gh.reset();
});

test("empty tabs", async ({ page }) => {
  await page.goto("/prs");
  await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
  await expect(page.getByText("TseHang/andrun-demo, live from GitHub")).toBeVisible();
  await expect(page.getByText("No open pull requests.")).toBeVisible();
  await page.getByRole("tab", { name: "Needs review" }).click();
  await expect(page.getByText("No pull requests need a review.")).toBeVisible();
  await page.getByRole("tab", { name: "My PRs" }).click();
  await expect(page.getByText("&run has not opened a pull request yet.")).toBeVisible();
});

test("the list shows who wrote each pull request and what can be done", async ({ page }) => {
  const s = ui(page);
  await seedReviewPull();
  await gh.addPull({ number: 13, title: "Add a --json flag to the CLI", headRef: "feat/json-flag", user: "octocat" });
  await page.goto("/prs");

  await expect(s.sidebar.getByRole("link", { name: /Pull requests/ })).toContainText("2");
  await expect(page.locator("[data-pr]")).toHaveCount(2);
  await expect(s.prRow(13)).toContainText("octocat");
  await expect(s.prRow(13)).toContainText("feat/json-flag");
  await expect(s.prRow(13)).toContainText("Needs review");
  await expect(s.prRow(13).getByRole("link", { name: "Start review" })).toHaveAttribute("href", "/prs/13");
  await expect(s.prRow(14)).toContainText("Opened by &run"); // instead of the bot's login
  await expect(s.prRow(14)).toContainText("Needs review");

  await page.getByRole("tab", { name: "My PRs" }).click();
  await expect(page.locator("[data-pr]")).toHaveCount(1);
  await expect(s.prRow(14)).toBeVisible();
  await page.getByRole("tab", { name: "Needs review" }).click();
  await expect(page.locator("[data-pr]")).toHaveCount(2); // a pull request &run opened can be reviewed too (P4-k)
  await expect(page.getByText("My PRs are the pull requests &run opened from this workspace. Reviews are posted as TseHang.")).toBeVisible();
});

test("GitHub error on the list", async ({ page }) => {
  const s = ui(page);
  await seedReviewPull();
  await gh.fail({ method: "GET", path: "/pulls$", status: 502, body: { message: "Bad Gateway" }, times: 20 });
  await page.goto("/prs");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("GitHub answered 502");
  await expect(s.sidebar.getByRole("link", { name: /Pull requests/ })).toHaveText("Pull requests"); // no count
  await expect(page.locator("[data-pr]")).toHaveCount(0);

  await gh.reset();
  await seedReviewPull();
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(s.prRow(14)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
