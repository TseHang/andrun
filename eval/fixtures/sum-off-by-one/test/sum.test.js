import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "../src/sum.js";

test("sums all values", () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test("single value", () => {
  assert.equal(sum([5]), 5);
});
