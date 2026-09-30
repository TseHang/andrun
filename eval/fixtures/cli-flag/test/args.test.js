import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.js";

test("parses --name", () => {
  assert.equal(parseArgs(["--name", "ai"]).name, "ai");
});

test("verbose defaults to false", () => {
  assert.equal(parseArgs([]).verbose, false);
});

test("parses --verbose", () => {
  assert.equal(parseArgs(["--verbose"]).verbose, true);
});
