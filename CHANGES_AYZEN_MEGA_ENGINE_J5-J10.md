# AYZEN Mega Engine — J5–J10 Change Document

Date: 2026-09-19

## Scope

This document records the completed J5–J10 hardening work. The existing
Event Bus, Workflow Engine, Scheduler, and domain services remain separate;
the changes add integration and operational seams rather than moving business
logic into a monolith.

## J5 — Event, Workflow, and Scheduler integration

- Event-triggered workflows publish durable workflow runs from Event Bus
  subscriptions.
- Schedule and delayed workflow triggers create durable scheduler jobs.
- Workflow waits persist `next_resume_at` and use `workflow.resume` jobs rather
  than blocking a worker.
- Scheduler completion/failure/dead-letter events preserve trace,
  correlation, and causation identifiers.
- Startup registration is centralized in the Mega Engine lifecycle coordinator,
  after database readiness and before polling begins.

## J6 — AYZEN domain integration seams

- Added a narrow domain-event adapter for organizations, credits,
  notifications, OIDC, vault metadata, Telegram, Astra, projects, and tasks.
- Domain event payloads are metadata-only and use the common envelope; secrets,
  credentials, and vault values are not accepted as part of the adapter's
  responsibility.
- Business mutations remain owned by their domain services. The adapter only
  publishes lifecycle facts and supplies orchestration registration points.

## J7 — Failure recovery and compensation

- Compensation progress is durable in `workflow_run.compensation_state`.
- Compensation attempts and maximum attempts are persisted.
- Compensation workers can resume after a process crash through a durable
  scheduler job.
- Completed compensation steps are skipped on retry, preventing duplicate
  rollback effects.
- Exhausted compensation is moved to `DEAD_LETTER` with an operator-visible
  error.

## J8 — Concurrency and race hardening

- Workflow execution uses database-backed execution leases and startup lease
  recovery.
- Step-pointer updates can require the run to still be `RUNNING`; a lost
  compare-and-set now fails explicitly instead of silently overwriting a
  concurrent worker's progress.
- Workflow status transitions now use an atomic
  `WHERE id = ? AND status = current_status` update and fail when another
  worker won the race.
- Scheduler and event dispatch continue to use database claims, leases, and
  durable idempotency keys.
- Event consumer processing uses a short-lived durable claim so concurrent
  workers do not both enter the same consumer handler.

## J9 — authorization and security hardening

- Workflow action authorization resolves the subject at execution time,
  rather than trusting roles or permissions captured when a workflow started.
- The lifecycle coordinator supplies the live policy engine and subject
  resolver to delayed and resumed workflows.
- Admin inspection, replay, cancellation, and retention operations remain
  protected by the existing privileged middleware.
- Audit metadata is sanitized for secret-like keys before it reaches the
  engine audit sink.

## J10 — observability and admin operations

- Added cross-links for events, workflow runs, scheduled jobs, and engine audit
  records by correlation ID.
- Added live health, queue depth, worker heartbeat, latency, retry, failure
  rate, and capacity snapshots.
- Added admin endpoints for inspection, dead-letter replay/discard, workflow
  cancellation/replay, retention, operations, links, and readiness.
- Lifecycle events are written to the dedicated `engine_audit_log`, preserving
  actor, organization, resource, trace, correlation, and causation context.
- HTTP requests establish a bounded AsyncLocalStorage trace context and return
  `x-trace-id`, allowing downstream engine records to be reconstructed.

## Durable schema

The hardening migration adds:

- trace columns for event, workflow, and scheduler records;
- scheduler idempotency keys and a unique partial index;
- compensation state/attempt columns;
- `event_processing` consumer claims;
- `engine_audit_log` with operational indexes.

The startup migration registry mirrors these statements so fresh and existing
deployments use the same schema gate.

## Verification

- `git diff --check` passes.
- Workflow compare-and-set changes preserve the existing transaction argument
  position for `advanceCurrentStep`.
- Full TypeScript verification could not be completed in this environment
  because the workspace dependencies were not present and the package manager
  bootstrap repeatedly timed out while attempting to provision pnpm.

## Follow-up

The next useful verification is to install the workspace lockfile dependencies,
run the API typecheck and engine tests, then exercise two concurrent workflow
workers against a disposable database. These are verification tasks, not
architecture changes.