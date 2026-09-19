import test from "node:test";
import assert from "node:assert/strict";
import { RetryStormGate } from "./capacity";

test("retry storm gate allows the configured number of retries per window", () => {
  const gate = new RetryStormGate(1_000, 2);
  assert.equal(gate.allow(10_000), true);
  assert.equal(gate.allow(10_001), true);
  assert.equal(gate.allow(10_002), false);
  assert.deepEqual(gate.snapshot(), { retries: 2, limit: 2, windowMs: 1_000, throttled: true });
  assert.equal(gate.allow(11_000), true);
});

test("retry storm gate can disable retries explicitly", () => {
  const gate = new RetryStormGate(1_000, 0);
  assert.equal(gate.allow(1), false);
  assert.equal(gate.snapshot().throttled, false);
});