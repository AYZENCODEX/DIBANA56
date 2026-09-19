import test from "node:test";
import assert from "node:assert/strict";
import { IllegalTransitionError, assertRunTransition } from "./state-machine";

test("workflow timeout is a deterministic terminal transition", () => {
  assert.equal(assertRunTransition("RUNNING", "TIMED_OUT"), "TIMED_OUT");
  assert.equal(assertRunTransition("WAITING", "TIMED_OUT"), "TIMED_OUT");
  assert.throws(
    () => assertRunTransition("TIMED_OUT", "RUNNING"),
    (error) => error instanceof IllegalTransitionError,
  );
});

test("cancelled workflows cannot be resumed", () => {
  assert.equal(assertRunTransition("PENDING", "CANCELLED"), "CANCELLED");
  assert.equal(assertRunTransition("RUNNING", "CANCELLED"), "CANCELLED");
  assert.equal(assertRunTransition("WAITING", "CANCELLED"), "CANCELLED");
  assert.throws(() => assertRunTransition("CANCELLED", "RUNNING"), IllegalTransitionError);
});

test("compensation has an explicit terminal boundary", () => {
  assert.equal(assertRunTransition("RUNNING", "COMPENSATING"), "COMPENSATING");
  assert.equal(assertRunTransition("COMPENSATING", "COMPENSATED"), "COMPENSATED");
  assert.equal(assertRunTransition("COMPENSATING", "DEAD_LETTER"), "DEAD_LETTER");
  assert.throws(() => assertRunTransition("COMPENSATED", "RUNNING"), IllegalTransitionError);
});