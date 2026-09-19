import test from "node:test";
import assert from "node:assert/strict";
import { ratio } from "./capacity";

test("operations failure-rate contract is bounded and stable", () => {
  assert.equal(ratio(0, 0), 0);
  assert.equal(ratio(1, 4), 0.25);
  assert.equal(ratio(2, 3), 0.6667);
});

test("operations failure-rate contract never divides by zero", () => {
  assert.equal(Number.isFinite(ratio(10, 0)), true);
});