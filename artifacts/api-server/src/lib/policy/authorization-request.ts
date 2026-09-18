/**
 * lib/policy/authorization-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 1A.
 *
 * `buildAuthorizationRequest()` is the only supported way to construct an
 * `AuthorizationRequest` for `PolicyEngine.evaluate()`. It exists so
 * "invalid context deny" (one of Phase 01's required tests) is enforced in
 * exactly one place, instead of every future PEP call site having to
 * remember its own shape checks.
 *
 * Validation here is deliberately shallow — it checks the request is
 * well-formed enough to reason about (Rule 9: never trust client-supplied
 * context blindly), not whether the subject is *permitted*. Permission is
 * the PDP's job (policy-engine.ts + later phases' rules), not this file's.
 */

import { InvalidAuthorizationContextError } from "./policy-errors";
import { createPolicyContext, type CreatePolicyContextInput } from "./policy-context";
import type { AuthorizationRequest, ResourceRef, Subject } from "./types";

export interface BuildAuthorizationRequestInput {
  subject: Subject | null;
  action: string;
  resource: ResourceRef;
  /** Pass a pre-built PolicyContext to propagate an existing correlation ID
   *  (e.g. one already generated per-HTTP-request upstream). Pass the
   *  createPolicyContext() input shape instead to have one built for you.
   *  Omit entirely to get a fresh context with a new correlation ID. */
  context?: import("./types").PolicyContext | CreatePolicyContextInput;
}

function isPolicyContext(value: unknown): value is import("./types").PolicyContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    "timestamp" in value
  );
}

function assertValidSubject(subject: Subject | null): void {
  if (subject === null) return; // unauthenticated is a valid, distinct case
  if (typeof subject.userId !== "number" || !Number.isFinite(subject.userId) || subject.userId <= 0) {
    throw new InvalidAuthorizationContextError("subject.userId must be a positive finite number");
  }
  if (typeof subject.role !== "string" || subject.role.trim().length === 0) {
    throw new InvalidAuthorizationContextError("subject.role must be a non-empty string");
  }
  if (!["session", "apikey", "legacy"].includes(subject.authType)) {
    throw new InvalidAuthorizationContextError(`subject.authType is invalid: ${String(subject.authType)}`);
  }
}

function assertValidResource(resource: ResourceRef): void {
  if (resource === null || typeof resource !== "object") {
    throw new InvalidAuthorizationContextError("resource must be an object");
  }
  if (typeof resource.type !== "string" || resource.type.trim().length === 0) {
    throw new InvalidAuthorizationContextError("resource.type must be a non-empty string");
  }
}

function assertValidAction(action: string): void {
  if (typeof action !== "string" || action.trim().length === 0) {
    throw new InvalidAuthorizationContextError("action must be a non-empty string");
  }
}

/**
 * Validates and assembles an AuthorizationRequest. Throws
 * InvalidAuthorizationContextError on any shape/invariant violation —
 * callers (in practice, PolicyEngine.evaluate()) are expected to catch this
 * and turn it into a DENY decision rather than let it propagate.
 */
export function buildAuthorizationRequest(input: BuildAuthorizationRequestInput): AuthorizationRequest {
  assertValidAction(input.action);
  assertValidResource(input.resource);
  assertValidSubject(input.subject);

  const context = isPolicyContext(input.context)
    ? input.context
    : createPolicyContext(input.context ?? {});

  return {
    subject: input.subject,
    action: input.action,
    resource: input.resource,
    context,
  };
}
