import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceLine, invoiceTotal } from "../src/report.js";

const items = [
  { name: "Desk", price: 1234.5, quantity: 1 },
  { name: "Lamp", price: 19.99, quantity: 3 },
];

test("invoiceLine", () => {
  assert.equal(invoiceLine(items[0]), "Desk x1: $1,234.50");
  assert.equal(invoiceLine(items[1]), "Lamp x3: $59.97");
});

test("invoiceTotal", () => {
  assert.equal(invoiceTotal(items), "Total: $1,294.47");
  assert.equal(invoiceTotal([]), "Total: $0.00");
});
