import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "../src/chunk.js";

test("splits into equal parts", () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("the last part may be shorter", () => {
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test("an empty list gives no parts", () => {
  assert.deepEqual(chunk([], 3), []);
});

test("a size below 1 is an error", () => {
  assert.throws(() => chunk([1], 0), RangeError);
  assert.throws(() => chunk([1], 1.5), RangeError);
});
