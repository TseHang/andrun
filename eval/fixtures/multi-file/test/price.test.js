import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/price.js";

test("formats whole amounts", () => {
  assert.equal(formatPrice(3), "$3.00");
});

test("rounds half up to cents", () => {
  assert.equal(formatPrice(2.675 + 0.0001), "$2.68");
  assert.equal(formatPrice(1.005 + 0.0001), "$1.01");
});
