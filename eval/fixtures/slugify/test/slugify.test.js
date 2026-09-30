import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("lowercases and dashes words", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses punctuation and repeated separators", () => {
  assert.equal(slugify("  Ship it -- now!! "), "ship-it-now");
});
