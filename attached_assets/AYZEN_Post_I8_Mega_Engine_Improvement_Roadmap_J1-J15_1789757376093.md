# AYZEN --- Post-I8 Mega Engine Improvement Roadmap

## Production Hardening Season

### Baseline

This roadmap starts from the **I8 snapshot**.

The purpose is to complete the remaining gaps around the Event Bus,
Workflow Engine, Scheduler, observability, security, reliability, and
domain integration without redesigning the existing AYZEN architecture.

Already-existing I8 capabilities should NOT be rebuilt unnecessarily.
Preserve working Phase 8/I8 components and improve them incrementally.

------------------------------------------------------------------------

# Season Structure

``` text
J1 → J2 → J3 → J4 → J5
                    ↓
                    J6
                    ↓
             J7 → J8 → J9
                    ↓
             J10 → J11
                    ↓
             J12 → J13
                    ↓
             J14 → J15
```

------------------------------------------------------------------------

# J1 --- Workflow Timeout & Cancellation Hardening

## Objective

Close remaining workflow lifecycle gaps.

## Work

-   Complete step-level `timeoutMs`.
-   Define workflow-level timeout behavior.
-   Implement deterministic timeout state transitions.
-   Add `workflow.timed_out` event.
-   Harden cancellation of waiting workflows.
-   Define behavior for cancellation during an executing action.
-   Prevent cancelled workflows from being resumed accidentally.
-   Persist cancellation reason and actor.
-   Add timeout/cancellation metrics.

## Acceptance

-   Timeout produces deterministic state.
-   Timeout emits the correct event.
-   Cancelled workflows cannot resume accidentally.
-   Waiting and running workflows have clearly defined cancellation
    semantics.
-   Tests cover race conditions around timeout/cancel.

------------------------------------------------------------------------

# J2 --- Scheduler Trigger Deduplication

## Objective

Prevent duplicate scheduled execution.

## Work

-   Add deterministic schedule/job idempotency keys.
-   Deduplicate recurring jobs.
-   Deduplicate workflow wakeups.
-   Handle scheduler restart safely.
-   Protect against duplicate trigger creation.
-   Verify lease/claim behavior under concurrent workers.
-   Add duplicate-trigger metrics.

## Acceptance

``` text
same trigger
   ↓
same idempotency key
   ↓
one effective job
```

No duplicate critical business effect.

------------------------------------------------------------------------

# J3 --- Trace & Correlation Propagation

## Objective

Make one request traceable across API → service → event → workflow →
scheduler → worker.

## Work

Standardize:

``` text
traceId
correlationId
causationId
eventId
workflowRunId
jobId
```

Propagate them through:

-   API requests
-   Telegram actions
-   extension actions
-   domain services
-   Event Bus
-   Workflow Engine
-   Scheduler
-   workers
-   notification delivery

## Acceptance

A single operation can be reconstructed end-to-end using correlation
identifiers.

------------------------------------------------------------------------

# J4 --- Audit Integration

## Objective

Connect lifecycle events to the existing audit system.

## Audit events

At minimum:

``` text
organization.member.changed
vault.share.changed
oidc.session.changed
policy.decision.denied
workflow.started
workflow.completed
workflow.failed
workflow.cancelled
workflow.timed_out
job.created
job.cancelled
job.failed
dead_letter.replayed
```

## Rules

-   Never store secrets.
-   Preserve actor identity where available.
-   Preserve organization/resource context.
-   Link audit records to event/correlation IDs.

## Acceptance

Security-sensitive engine actions are auditable without duplicating the
existing audit architecture.

------------------------------------------------------------------------

# J5 --- Full Event ↔ Workflow ↔ Scheduler Integration

## Objective

Make the three engines operate as one coherent orchestration layer.

## Required flows

``` text
Event → Workflow
Event → Scheduler
Scheduler → Workflow
Workflow → Scheduler
Workflow → Event
```

## Example

``` text
organization.member.invited
        ↓
workflow.start
        ↓
WAITING
        ↓
scheduler.resume
        ↓
workflow.continue
        ↓
notification
        ↓
event
```

## Acceptance

-   No blocking `sleep()` for long waits.
-   Workflow waiting is durable.
-   Scheduler wakeups are idempotent.
-   Events carry correlation/causation information.

------------------------------------------------------------------------

# J6 --- AYZEN Domain Integration

## Objective

Connect the Mega Engine to existing AYZEN domains without moving
business logic into the engine.

## Integrations

### Organizations

``` text
invite
join
role change
remove
ownership transfer
```

### Credits

``` text
credit consumption
credit failure
credit-related workflow
```

### Notifications

``` text
event
→ preference check
→ channel delivery
→ retry
```

### OIDC

``` text
login
session creation
session revocation
logout
```

### Vault

Metadata-only events for:

``` text
share created
share revoked
```

### Telegram

Scheduled/retryable notification delivery.

### Astra

Safe session/policy synchronization events.

### Projects/Tasks

Scheduled cleanup, reminders and lifecycle workflows.

------------------------------------------------------------------------

# J7 --- Failure Recovery & Compensation

## Objective

Make multi-step workflows resilient to partial failure.

## Work

-   Define retryable vs permanent errors.
-   Add explicit compensation handlers.
-   Persist compensation state.
-   Resume compensation after worker crash.
-   Prevent compensation loops.
-   Add maximum compensation attempts.
-   Add operator-visible failure reason.

## Example

``` text
A ✓
B ✓
C ✗
↓
compensate B
↓
compensate A
```

Only actions explicitly marked reversible may be compensated.

------------------------------------------------------------------------

# J8 --- Concurrency & Race Hardening

## Objective

Eliminate duplicate or conflicting execution.

## Work

Protect:

-   workflow step execution
-   scheduler jobs
-   recurring jobs
-   event consumers
-   credit operations
-   notification delivery
-   organization membership transitions
-   vault share changes

Use:

``` text
atomic DB operations
unique constraints
leases
idempotency keys
optimistic versioning
transaction boundaries
```

## Acceptance

Concurrent workers cannot produce duplicate critical effects.

------------------------------------------------------------------------

# J9 --- Deep PEP / Security Hardening

## Objective

Ensure the Mega Engine never becomes an authorization bypass.

## Rules

``` text
Workflow
   ↓
Domain Service
   ↓
PEP
   ↓
Policy Engine
   ↓
ALLOW / DENY
```

## Work

-   Re-check sensitive authorization at execution time.
-   Handle role changes while workflows are waiting.
-   Handle organization membership removal.
-   Prevent cross-organization workflow access.
-   Protect admin engine endpoints.
-   Secure event replay.
-   Secure dead-letter replay.
-   Prevent forged internal events.
-   Validate actor/resource context.
-   Prevent privilege inheritance from stale workflow state.

## Acceptance

A delayed workflow cannot retain obsolete authorization.

------------------------------------------------------------------------

# J10 --- Advanced Observability & Admin Operations

## Objective

Turn the current I8 observability surface into a complete operations
console.

## Add

### Cross-links

``` text
Event
 ↕
Workflow Run
 ↕
Scheduled Job
 ↕
Audit Record
```

### Live information

-   worker state
-   queue depth
-   scheduler lag
-   workflow latency
-   event processing latency
-   retry counts
-   DLQ count
-   failure rate

### Operations

``` text
inspect
retry
replay
cancel
pause
resume
discard
```

All privileged actions must be authorized and audited.

------------------------------------------------------------------------

# J11 --- Integration & E2E Test Layer

## Objective

Test the complete engine instead of isolated modules only.

## Test scenarios

### Event

-   publish
-   consume
-   duplicate delivery
-   retry
-   DLQ
-   replay

### Scheduler

-   delayed job
-   recurring job
-   cron
-   timezone
-   misfire
-   lease expiry
-   restart recovery

### Workflow

-   branching
-   waiting
-   resume
-   timeout
-   cancellation
-   retry
-   compensation
-   restart recovery

### Security

-   PEP denial
-   stale role
-   organization isolation
-   replay authorization
-   cross-user access

### Full chain

``` text
API
→ Service
→ DB
→ Event
→ Workflow
→ Scheduler
→ Worker
→ Service
→ Event
```

------------------------------------------------------------------------

# J12 --- Performance, Backpressure & Capacity

## Objective

Prevent overload from propagating through the engine.

## Work

-   Queue depth limits.
-   Worker concurrency limits.
-   Per-handler concurrency.
-   Backpressure.
-   Retry storm protection.
-   Rate-limit aware retries.
-   Batch processing where safe.
-   Event prioritization where necessary.
-   Scheduler polling optimization.
-   Database query/index review.

## Metrics

``` text
queue_depth
scheduler_lag
worker_utilization
event_latency
workflow_latency
job_latency
retry_rate
```

Do not optimize based on assumptions; benchmark first.

------------------------------------------------------------------------

# J13 --- Startup, Shutdown & Worker Lifecycle

## Objective

Make deployments and restarts safe.

## Work

Startup:

``` text
validate configuration
→ validate DB
→ recover leases
→ recover workflows
→ load schedules
→ start dispatcher
→ start workers
```

Shutdown:

``` text
stop accepting new work
→ stop claiming jobs
→ drain safe in-flight work
→ persist state
→ release/expire leases
→ stop workers
```

Also handle:

-   SIGTERM
-   SIGINT
-   deployment restart
-   worker crash
-   stale leases

------------------------------------------------------------------------

# J14 --- Retention & Cleanup Hardening

## Objective

Prevent engine tables from growing indefinitely.

## Work

Define retention for:

``` text
event_outbox
event_processing
event_dead_letter
workflow_run
workflow_step_run
workflow_checkpoint
scheduled_job
job_attempt
job_dead_letter
```

Add:

-   safe cleanup jobs
-   batching
-   indexes
-   archival where appropriate
-   cleanup metrics
-   failure/retry for cleanup

Never delete governed audit data through generic engine cleanup.

------------------------------------------------------------------------

# J15 --- Final Production Readiness Audit

## Objective

Validate the entire Mega Engine before treating it as production-ready.

## Audit categories

### Architecture

-   no duplicate subsystem
-   existing architecture preserved
-   clear ownership boundaries

### Security

-   PEP remains authoritative
-   organization isolation
-   replay protection
-   secret exclusion
-   admin protection

### Reliability

-   restart recovery
-   retry
-   DLQ
-   idempotency
-   leases
-   compensation

### Workflow

-   durable state
-   checkpoint
-   timeout
-   cancellation
-   waiting
-   resume

### Scheduler

-   delayed
-   recurring
-   cron
-   timezone
-   misfire
-   concurrency

### Event Bus

-   envelope
-   registry
-   outbox
-   consumers
-   retry
-   DLQ

### Operations

-   health
-   metrics
-   tracing
-   audit
-   admin console

### Testing

-   unit
-   integration
-   E2E
-   failure injection
-   concurrency tests
-   load tests

------------------------------------------------------------------------

# Final Architecture After J15

``` text
                         AYZEN
                           |
       +-------------------+-------------------+
       |                   |                   |
      API               Telegram             Astra
       |                   |                   |
       +-------------------+-------------------+
                           |
                    Domain Services
                           |
                    +------+------+
                    |             |
                   PEP          Database
                    |             |
                    +------+------+
                           |
                  Transactional Outbox
                           |
                           v
                    +-------------+
                    |  EVENT BUS  |
                    +------+------+
                           |
             +-------------+-------------+
             |             |             |
         Workflow      Notification     Audit
             |
             v
       +-------------+
       |  SCHEDULER  |
       +------+------+
              |
          Job Queue
              |
       +------+------+
       |             |
    Worker 1      Worker N
       |             |
       +------+------+
              |
        Domain Services
              |
             PEP
```

## Final responsibility boundary

``` text
Event Bus       = communication
Workflow        = orchestration
Scheduler       = time
Workers         = execution
Domain Services = business logic
PEP             = authorization
Database        = durable state
Audit           = governance
Observability   = operations
```

## Final target

The objective of J1--J15 is not to create a giant monolithic "mega
service".

It is to create a **modular Mega Engine** where:

-   Event Bus handles communication.
-   Workflow Engine handles durable orchestration.
-   Scheduler handles time.
-   Workers execute bounded jobs.
-   Domain services remain authoritative for business behavior.
-   PEP remains authoritative for authorization.
-   Database remains the durable source of state.
-   Audit and observability make the system operable.

Existing AYZEN functionality should continue working throughout the
migration.
