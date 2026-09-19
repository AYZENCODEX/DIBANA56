import test from "node:test";
import assert from "node:assert/strict";
import { RetryStormGate, runWithConcurrency } from "./capacity";

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

test("capacity helper never exceeds the configured in-flight limit", async () => {
  let active = 0;
  let peak = 0;
  const completed: number[] = [];

  await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed.push(item);
    active--;
  });

  assert.equal(peak, 2);
  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(active, 0);
});
