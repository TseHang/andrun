import { expect, test, type Page } from "@playwright/test";
import { TASK, createSession, ui } from "./support";

// The fake model (test/support/fake-sse-server.ts):
//   [chat]   replies with text only, then plays the normal script after the user's reply
//   [choose] asks a question with two options (ask_user), then plays the normal script
//   [stop]   fixes the bug, then replies with text instead of calling finish; finish comes after the next message

const QUESTION = "Which fix do you want?";
const card = (page: Page) => page.getByRole("form", { name: "Question from the agent" });
const bubbles = (page: Page) => page.locator('[data-item="user"]');

test("a question is answered by picking an option", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[choose] ${TASK}`);
  await page.goto(`/s/${id}`);

  const q = card(page);
  await expect(q).toBeVisible({ timeout: 60_000 });
  await expect(s.status).toHaveText("Waiting for you");
  await expect(s.sidebar.locator(`a[href="/s/${id}"]`)).toContainText("Waiting for you");
  await expect(q).toContainText(QUESTION);
  const options = q.locator("[data-option]");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Fix the loop bound");
  await expect(options.nth(0)).toContainText("Change the loop condition in sum()");
  await expect(options.nth(1)).toContainText("Rewrite with reduce");
  await expect(q.getByRole("textbox", { name: "Your answer" })).toBeVisible();
  // The question is part of the conversation, not a tool row; nothing asks for approval.
  await expect(s.timeline).toContainText(QUESTION);
  await expect(s.rows("ask_user")).toHaveCount(0);
  await expect(s.approval).toHaveCount(0);
  await expect(s.composer).toHaveCount(0);

  await options.nth(0).click();
  await expect(bubbles(page)).toHaveText(["Fix the loop bound"]);
  await expect(q).toHaveCount(0);
  await expect(s.approval).toContainText("Approval required · finish", { timeout: 90_000 });
  await expect(s.rows("apply_patch")).toHaveCount(1);
});

test("a question is answered with typed text", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[choose] ${TASK}`);
  await page.goto(`/s/${id}`);

  const q = card(page);
  await expect(q).toBeVisible({ timeout: 60_000 });
  const send = q.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await q.getByRole("textbox", { name: "Your answer" }).fill("Neither, make it tic-tac-toe");
  await send.click();
  await expect(bubbles(page)).toHaveText(["Neither, make it tic-tac-toe"]);
  await expect(q).toHaveCount(0);
  await expect(s.approval).toContainText("Approval required · finish", { timeout: 90_000 });
});

test("an open question survives a reload", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[choose] ${TASK}`);
  await page.goto(`/s/${id}`);
  await expect(card(page)).toBeVisible({ timeout: 60_000 });

  await page.reload();
  await expect(s.status).toHaveText("Waiting for you");
  await expect(card(page)).toContainText(QUESTION);
  await expect(card(page).locator("[data-option]")).toHaveCount(2);
  await card(page).locator("[data-option]").nth(1).click();
  await expect(bubbles(page)).toHaveText(["Rewrite with reduce"]);
});

test("a text reply waits for the user, then the run goes on to a pull request", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[chat] ${TASK}`);
  await page.goto(`/s/${id}`);

  await expect(s.status).toHaveText("Waiting for you", { timeout: 60_000 });
  await expect(s.timeline).toContainText("I can fix the loop bound or rewrite sum() with reduce. Which do you prefer?");
  await expect(s.approval).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  const input = s.composer.getByRole("textbox", { name: "Message to the agent" });
  await expect(input).toHaveAttribute("placeholder", "Reply to the agent");
  // Nothing changed yet, so there is no pull request to ask for.
  await expect(s.composer.getByRole("button", { name: "Open pull request" })).toHaveCount(0);
  await expect(s.rows()).toHaveCount(1); // sandbox setup only: the agent did not start on its own

  await input.fill("Go with the first one");
  await s.composer.getByRole("button", { name: "Send" }).click();
  await expect(bubbles(page)).toHaveText(["Go with the first one"]);
  await expect(s.approval).toContainText("Approval required · finish", { timeout: 90_000 });
  await s.approval.getByRole("button", { name: "Approve and open PR" }).click();
  await expect(s.status).toHaveText("Done");
  await expect(s.prCard).toContainText(/Pull request #\d+ opened/);
});

test("Open pull request asks the agent to finish", async ({ page, request }) => {
  const s = ui(page);
  const id = await createSession(request, `[stop] ${TASK}`);
  await page.goto(`/s/${id}`);

  await expect(s.status).toHaveText("Waiting for you", { timeout: 90_000 });
  await expect(s.timeline).toContainText("Fixed the loop bound. Do you want anything else?");
  await expect(s.changes).toContainText("src/sum.js");
  await s.composer.getByRole("button", { name: "Open pull request" }).click();
  await expect(bubbles(page)).toHaveText(["Open a pull request for these changes."]);
  await expect(s.approval).toContainText("Approval required · finish", { timeout: 90_000 });
});
