import { test } from "node:test";
import assert from "node:assert/strict";
import { average } from "../src/stats.js";

test("averages values", () => {
  assert.equal(average([2, 4, 6]), 4);
});

test("empty array averages to 0", () => {
  assert.equal(average([]), 0);
});
