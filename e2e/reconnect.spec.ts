import { expect, test, type WebSocketRoute } from "@playwright/test";
import { TASK, createSession, replay, ui, waitForStatus, watch } from "./support";

const names = (page: import("@playwright/test").Page) =>
  page.locator("[data-step-name]").evaluateAll((els) => els.map((e) => e.getAttribute("data-step-name")));

test("reload and reconnect replay from lastSeq", async ({ page, request }) => {
  const s = ui(page);
  // Every socket goes through the test, so the test can drop it.
  let current: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/sessions\/.+\/ws/, (ws) => {
    current = ws;
    ws.connectToServer();
  });

  const id = await createSession(request, `[slow] ${TASK}`);
  await page.goto(`/s/${id}`);
  await expect(s.rows("run_command")).toHaveCount(1, { timeout: 60_000 });
  const before = await names(page);

  // A reload shows the same rows and keeps growing.
  await page.reload();
  await expect.poll(() => names(page)).toEqual(expect.arrayContaining(before));
  expect((await names(page)).slice(0, before.length)).toEqual(before);
  await expect(s.rows("read_file")).toHaveCount(1, { timeout: 60_000 });

  // A dropped socket: "Reconnecting", then the rest of the run, with nothing lost or doubled.
  const seen = await watch(page, ["Reconnecting"]);
  await current!.close({ code: 4000, reason: "dropped by the test" });
  await waitForStatus(request, id, "awaiting_approval", 150_000);
  await expect(s.status).toHaveText("Awaiting approval", { timeout: 30_000 });
  expect(await seen()).toContain("Reconnecting");

  const persisted = (await replay(id)).flatMap((e) => (e.type === "tool_call" && e.name !== "finish" ? [e.name] : []));
  expect(await names(page)).toEqual(persisted);
});
