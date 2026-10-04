import { expect, test, type Page } from "@playwright/test";
import { BASE, TASK, createSession, ui } from "./support";

// Session UI (slices B + C). The fake model (test/support/fake-sse-server.ts):
//   [md]    replies with markdown text only
//   [slow]  every answer takes 8 s: time to press Stop
//   [stop]  fixes the bug, then replies with text: the session waits with src/sum.js changed
//   [html]  writes index.html and app.js, then replies with text

const card = (page: Page, path: string) => ui(page).changes.locator(`[data-file="${path}"]`);

test("an agent reply is rendered as markdown, with the & marker", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[md] ${TASK}`);
  await page.goto(`/s/${id}`);

  await expect(s.status).toHaveText("Waiting for you", { timeout: 60_000 });
  await expect(s.timeline.getByRole("heading", { name: "Two options", level: 2 })).toBeVisible();
  await expect(s.timeline.locator("li")).toHaveText(["Fix the loop bound in sum()", "Rewrite it with reduce"]);
  await expect(s.timeline.locator("pre code")).toHaveText(/values\.reduce/);
  await expect(s.timeline.getByRole("table")).toBeVisible();
  const link = s.timeline.getByRole("link", { name: "docs" });
  await expect(link).toHaveAttribute("href", "https://example.com/reduce");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(s.timeline).not.toContainText("##");
  await expect(s.timeline).not.toContainText("**");
  await expect(s.timeline.getByLabel("&run")).toHaveCount(1);
  await expect(s.timeline.getByText(/^[\d.]+k? in · [\d.]+k? out · \d+\.\ds$/)).toHaveCount(1);
  // Nothing is running: no activity indicator.
  await expect(s.timeline.getByRole("status")).toHaveCount(0);
});

test("Stop ends the run and the session waits", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[slow] ${TASK}`);
  await page.goto(`/s/${id}`);

  const stop = s.composer.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible({ timeout: 60_000 });
  await expect(s.timeline.getByRole("status")).toContainText(/Thinking|Starting sandbox/);
  await expect(s.composer).toContainText("The agent reads your message after its current step");
  // The sandbox is up and the model call is in flight.
  await expect(s.timeline.getByRole("status")).toHaveText("Thinking", { timeout: 60_000 });

  await stop.click();
  const stopped = async () => {
    await expect(s.status).toHaveText("Waiting for you", { timeout: 20_000 });
    await expect(s.timeline.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(s.timeline).toContainText("Changes so far are kept. Send a message to continue.");
    await expect(s.timeline.getByRole("status")).toHaveCount(0);
    await expect(s.composer.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(s.timeline.getByText("The agent stopped without a reply.")).toHaveCount(0);
  };
  await stopped();
  await page.reload();
  await stopped();

  // The session continues with the next message.
  await s.composer.getByRole("textbox").fill("carry on");
  await s.composer.getByRole("button", { name: "Send" }).click();
  await expect(s.status).toHaveText("Running");
  await expect(s.composer.getByRole("button", { name: "Stop" })).toBeVisible();
});

test("a file card collapses and expands", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[stop] ${TASK}`);
  await page.goto(`/s/${id}`);
  await expect(s.status).toHaveText("Waiting for you", { timeout: 90_000 });

  const file = card(page, "src/sum.js");
  const header = file.getByRole("button", { name: /src\/sum\.js/ });
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(file.locator("[data-diff]").first()).toBeVisible();

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(file.locator("[data-diff]")).toHaveCount(0);
  await expect(file).toContainText("src/sum.js");
  await expect(file).toContainText("+1 −1");

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(file.locator('[data-diff="add"]')).toHaveCount(1);
  // A source file has no preview.
  await expect(file.getByRole("button", { name: "Preview" })).toHaveCount(0);
});

test("the Changes panel hides and the choice survives a reload", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[stop] ${TASK}`);
  await page.goto(`/s/${id}`);
  await expect(s.status).toHaveText("Waiting for you", { timeout: 90_000 });
  await expect(card(page, "src/sum.js")).toBeVisible();
  const widthBefore = (await s.timeline.boundingBox())!.width;

  await s.changes.getByRole("button", { name: "Hide changes" }).click();
  await expect(s.changes).toHaveCount(0);
  const show = page.getByRole("button", { name: /Show changes/ });
  await expect(show).toBeVisible();
  await expect(show).toContainText("1");
  expect((await s.timeline.boundingBox())!.width).toBeGreaterThan(widthBefore);
  // The composer is still there to use.
  await expect(s.composer).toBeVisible();

  await page.reload();
  await expect(s.status).toHaveText("Waiting for you");
  await expect(s.changes).toHaveCount(0);

  await page.getByRole("button", { name: /Show changes/ }).click();
  await expect(card(page, "src/sum.js").locator("[data-diff]").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Show changes/ })).toHaveCount(0);
  await page.reload();
  await expect(s.changes).toBeVisible();
});

test("an HTML file can be previewed in a sandboxed frame", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[html] make a page`);
  await page.goto(`/s/${id}`);
  await expect(s.status).toHaveText("Waiting for you", { timeout: 90_000 });

  // The API gives the saved content as JSON.
  const res = await request.get(`${BASE}/sessions/${id}/files?path=index.html`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^application\/json/);
  expect(((await res.json()) as { content: string }).content).toContain('<h1 id="title">Loading</h1>');
  expect((await request.get(`${BASE}/sessions/${id}/files?path=README.md`)).status()).toBe(404);

  const file = card(page, "index.html");
  await expect(card(page, "app.js").getByRole("button", { name: "Preview" })).toHaveCount(0);
  await file.getByRole("button", { name: "Preview" }).click();

  const frame = file.locator("iframe");
  await expect(frame).toHaveAttribute("title", "Preview of index.html");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  // The page's own script ran, inside the frame.
  await expect(file.frameLocator("iframe").getByRole("heading")).toHaveText("Hello from the page");
  await expect(file.locator("[data-diff]")).toHaveCount(0);
  // The frame cannot reach the app.
  const reach = await file.frameLocator("iframe").locator("body").evaluate(() => {
    try {
      return String(window.parent.document.title);
    } catch {
      return "blocked";
    }
  });
  expect(reach).toBe("blocked");

  await file.getByRole("button", { name: "Diff" }).click();
  await expect(file.locator("iframe")).toHaveCount(0);
  await expect(file.locator("[data-diff]").first()).toBeVisible();
});
