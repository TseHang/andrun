import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { PullReviews } from "../../web/src/components/PullReviews";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});

afterEach(() => vi.mocked(useState).mockClear());

it("renders review bodies and inline comments as compact Markdown in a bounded list", () => {
  vi.mocked(useState).mockReturnValueOnce([{ kind: "ready", reviews: [{
    id: 1, author: "TseHang", state: "CHANGES_REQUESTED", url: "https://github.com/x/y/pull/4#review-1",
    body: "Please add a **test**.\n\n- Cover `timeout`.",
    comments: [{ path: "src/timer.js", line: 337, body: "**Medium:** Use `performance.now()`.\n\n```js\nconst deadline = performance.now() + 1000;\n```" }],
  }] }, vi.fn()]);
  vi.mocked(useState).mockReturnValueOnce([new Set([1]), vi.fn()]);
  const html = renderToStaticMarkup(<PullReviews pr={4} status="awaiting_input" send={() => true} />);
  expect(html).toMatch(/<strong[^>]*>Medium:<\/strong>/);
  expect(html).toMatch(/<code[^>]*>performance.now\(\)<\/code>/);
  expect(html).toMatch(/<pre[^>]*><code/);
  expect(html).toContain("src/timer.js:337");
  expect(html).not.toContain("**");
  expect(html).not.toContain("text-[15px]");
  expect(html).toMatch(/<ul[^>]*class="[^"]*max-h-[^"]*overflow-y-auto/);
  // The GitHub link must not be inside the label that toggles review selection.
  expect(html).not.toMatch(/<label[^>]*>[^]*?<a[^]*?<\/label>/);
  expect(html).toContain("Ask &amp;run to address this");
  expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>Ask/);
});
