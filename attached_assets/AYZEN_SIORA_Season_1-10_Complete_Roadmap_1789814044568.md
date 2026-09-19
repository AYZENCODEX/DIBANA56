# AYZEN SIORA — Season 1–10 Complete Roadmap

## Mission

Build SIORA (Security Intelligence, Integrity, Operations & Response Architecture) as a modular security-intelligence layer around the existing AYZEN architecture.

SIORA is **not** a replacement for the existing Policy Engine. The existing Policy Engine remains the authorization/policy decision layer. SIORA produces security signals, trust/risk assessments, protection decisions, telemetry, and response actions that can feed existing policy context and security infrastructure.

### Core rule

**1 Season = 1 complete, independently deployable milestone.**

Every season must be completed end-to-end before moving to the next season.

Each season has only:
- A = Foundation
- B = Core implementation
- C = Integration + hardening + completion

No season is considered complete because files were created. It is complete only when implementation, integration, typechecking, tests, migration safety, production configuration, and documentation are finished.

---

# Global Claude Execution Protocol

For every season:

1. Inspect the existing repository before changing anything.
2. Identify reusable authentication, OIDC, session, Vault/secrets, audit, database, rate-limit, API-key, middleware, and Policy Engine components.
3. Preserve the existing folder structure and architecture.
4. Do not redesign or replace existing systems.
5. Do not duplicate existing security primitives.
6. Implement ONLY the current season.
7. Do not implement future-season functionality early.
8. Keep modules small, composable, typed, and testable.
9. Never log passwords, tokens, API keys, secrets, cookies, raw sensitive payloads, or secret material.
10. Production defaults must be secure.
11. Demo/test behavior must never silently activate in production.
12. Every security event should support request/correlation IDs.
13. Database changes must be migration-safe and restart-safe.
14. No fake adapters, placeholder implementations, TODO-based completion, or silently swallowed critical errors.
15. Do not claim tests passed unless they actually ran.
16. At the end of each season:
   - run typecheck
   - run relevant unit tests
   - run integration tests where available
   - run security regression tests
   - verify migrations
   - verify production configuration
   - update documentation
17. Report:
   - files changed
   - files added
   - existing modules reused
   - database changes
   - APIs/routes changed
   - tests executed and results
   - remaining risks
   - exact next-season prerequisites

---

# Global SIORA Architecture

Preferred logical structure:

artifacts/api-server/src/lib/siora/
  core/
  contracts/
  context/
  engines/
  scoring/
  signals/
  integrations/
  response/
  telemetry/
  config/
  testing/

Actual repository paths must be adapted after inspection. Do not blindly create this exact tree if an equivalent existing structure already exists.

Conceptual flow:

Request/Event
    ↓
SIORA Context Builder
    ↓
Security Signals
    ↓
Relevant SIORA Engine
    ↓
Risk / Trust / Threat Assessment
    ↓
Security Decision / Recommendation
    ↓
Existing Policy Engine context
    ↓
Existing application authorization/business logic
    ↓
Audit / Telemetry / Response

SIORA must remain separable from business logic.

---

# SEASON 1 — SIORA Core & Security Signal Bus

## Goal

Create the production-ready SIORA foundation that every later security engine can reuse.

### 1A — Contracts & Context

Build:
- SIORA event contract
- security signal contract
- normalized actor/request context
- correlation/request ID propagation
- engine interface
- engine result interface
- severity levels
- confidence levels
- risk/trust score primitives
- source metadata
- timestamp handling
- configuration contract

Requirements:
- strongly typed
- serializable
- no secret leakage
- backward-compatible with existing architecture

### 1B — Event Bus & Engine Lifecycle

Build:
- internal SIORA event dispatcher
- engine registry
- engine enable/disable configuration
- lifecycle hooks
- timeout/error boundary
- deterministic execution order
- non-blocking telemetry where appropriate
- safe failure behavior

Do not allow one optional security signal failure to crash unrelated application requests unless the specific control is intentionally fail-closed.

### 1C — Integration & Hardening

Integrate with:
- existing request middleware
- existing auth/OIDC context
- existing audit infrastructure
- existing database abstractions
- existing logging/correlation system

Add:
- unit tests
- contract tests
- failure-path tests
- configuration tests
- production-default tests
- security regression tests

### Definition of Done

- SIORA can receive a normalized security event.
- Engines can register and execute through one stable interface.
- Failures are bounded and observable.
- Correlation IDs survive the pipeline.
- No secrets appear in SIORA logs/events.
- Existing application behavior remains intact.
- All Season 1 tests pass.

### Out of Scope

- threat feeds
- identity scoring
- session anomaly detection
- fraud scoring
- data classification
- secret rotation
- API adaptive defense
- incident response dashboard

---

# SEASON 2 — Threat Intelligence Engine

## Goal

Detect known malicious indicators and threat intelligence signals.

### 2A — Threat Data Foundation

Build:
- indicator model
- indicator types
- source/provider model
- confidence and freshness
- expiration
- allow/deny handling
- normalized threat metadata
- local threat cache

Potential indicators:
- IP
- domain
- URL
- user-agent fingerprint
- device/network reputation signal
- known compromised identifier

Never store or expose unnecessary personal data.

### 2B — Threat Detection & Scoring

Build:
- indicator matching
- freshness checks
- confidence scoring
- threat severity
- weighted threat score
- explainable match reasons
- cache-aware lookup

### 2C — Integration & Testing

Integrate with SIORA context and selected security-sensitive flows.

Add:
- unit tests
- matching tests
- expired-indicator tests
- false-positive tests
- performance tests
- integration tests
- production configuration checks

### Definition of Done

Known malicious indicators can be normalized, matched, scored, explained, expired, and audited safely.

### Out of Scope

- full external threat-feed marketplace
- autonomous blocking of every request
- future anomaly/fraud engines

---

# SEASON 3 — Identity Trust Engine

## Goal

Create an identity trust layer that evaluates authentication-related security signals without replacing existing authentication.

### 3A — Identity Signals

Collect normalized signals from existing systems:
- authentication strength
- OIDC client context
- verification state
- account age
- recent security events
- credential/security-event history
- device consistency signals where already available

Do not duplicate authentication.

### 3B — Trust Scoring

Build:
- identity trust score
- confidence
- factor weighting
- explainable reasons
- trust decay
- suspicious identity-state detection

### 3C — Integration & Testing

Integrate with:
- existing auth middleware
- OIDC flows
- sensitive actions
- existing step-up/approval mechanisms where available

Tests:
- trusted identity
- suspicious identity
- missing signals
- stale signals
- fail-safe behavior
- regression

### Definition of Done

Security-sensitive flows can obtain a deterministic, explainable identity trust assessment without changing the existing authentication authority.

### Out of Scope

- replacing login
- replacing OIDC
- storing raw passwords
- biometric systems

---

# SEASON 4 — Session Security Engine

## Goal

Detect suspicious session behavior and strengthen session security.

### 4A — Session Telemetry

Normalize:
- session lifecycle events
- login/logout
- refresh events
- device/network changes
- unusual session transitions
- token/session age signals

Reuse the existing session implementation.

### 4B — Session Anomaly Detection

Build:
- session risk score
- impossible-transition detection
- rapid session switching detection
- suspicious reuse detection
- stale session detection
- configurable thresholds

### 4C — Safe Response Integration

Integrate recommendations with existing:
- session revocation
- step-up authentication
- security events
- audit logging

Tests:
- normal session
- suspicious transition
- expired session
- concurrent session behavior
- false-positive protection
- recovery

### Definition of Done

Suspicious session behavior is detected, explainable, audited, and connected to safe existing response mechanisms.

### Out of Scope

- replacing session storage
- inventing a second session system
- autonomous destructive actions without existing safeguards

---

# SEASON 5 — Abuse Detection Engine

## Goal

Detect abusive, automated, spam-like, and manipulation-heavy behavior.

### 5A — Behavior Feature Pipeline

Normalize behavioral signals from existing systems:
- request frequency
- action frequency
- repeated failures
- task/submission patterns
- reward/referral behavior
- account interaction patterns
- suspicious automation indicators

Do not collect unnecessary telemetry.

### 5B — Abuse Scoring

Build:
- abuse score
- velocity rules
- burst detection
- repeated-action detection
- suspicious sequence detection
- explainable rule results
- configurable thresholds

### 5C — Product Integration

Integrate carefully with relevant AYZEN flows such as:
- rewards
- referrals
- tasks
- submissions
- high-frequency endpoints

Use existing rate limiting and policy mechanisms where possible.

Tests:
- normal user
- burst activity
- repeated abuse
- false positives
- threshold boundaries
- concurrency
- load behavior

### Definition of Done

The platform can identify and explain abusive behavior without breaking legitimate normal usage.

### Out of Scope

- invasive user profiling
- autonomous account punishment without existing controls
- replacing rate limiting

---

# SEASON 6 — Risk & Anomaly Engine

## Goal

Create the central cross-signal risk aggregation layer.

### 6A — Normalized Risk Model

Define:
- risk dimensions
- severity
- confidence
- signal weighting
- temporal decay
- risk categories
- score normalization

Inputs may include:
- threat intelligence
- identity trust
- session security
- abuse signals

### 6B — Aggregation & Explainability

Build:
- weighted aggregation
- risk bands
- reason codes
- signal provenance
- confidence propagation
- deterministic scoring
- configurable policies for thresholds

Avoid opaque scoring.

### 6C — Policy Integration

Create a clean integration seam with the EXISTING Policy Engine.

SIORA should provide security context such as:
- threat score
- identity trust
- session risk
- abuse score
- aggregate risk
- reason codes
- confidence

The Policy Engine remains the authorization decision authority.

Tests:
- aggregation correctness
- score boundaries
- conflicting signals
- missing signals
- deterministic output
- policy-context compatibility
- regression

### Definition of Done

Existing authorization/policy decisions can consume normalized SIORA security context without replacing the Policy Engine.

### Out of Scope

- replacing Policy Engine
- rewriting all existing routes
- migrating every legacy auth middleware in one season

---

# SEASON 7 — Data Security Engine

## Goal

Protect sensitive application data through classification, redaction, access-aware controls, and retention intelligence.

### 7A — Data Classification

Build:
- sensitivity levels
- field/resource classification
- classification registry
- data handling metadata
- retention metadata

Example classes:
- public
- internal
- sensitive
- highly sensitive
- secret

### 7B — Redaction & Data Protection

Build:
- structured redaction
- log sanitization
- response sanitization helpers
- sensitive-field detection
- export filtering
- safe telemetry serialization

Never log:
- passwords
- access tokens
- refresh tokens
- API keys
- private keys
- secret values

### 7C — Access, Retention & Audit Integration

Integrate with:
- existing audit
- data export
- sensitive endpoints
- retention mechanisms
- security telemetry

Tests:
- redaction correctness
- nested objects
- arrays
- error paths
- serialization
- export filtering
- regression

### Definition of Done

Sensitive data is consistently classified and protected across the SIORA-controlled telemetry/security paths.

### Out of Scope

- rewriting the entire database
- full DLP product
- replacing application serialization everywhere

---

# SEASON 8 — Secrets Security Engine

## Goal

Strengthen lifecycle security for secrets while reusing the existing Vault/secret infrastructure.

### 8A — Secret Registry & Metadata

Build metadata for:
- secret type
- owner/service
- purpose
- created time
- expiry
- rotation state
- last-use metadata where safely available
- revocation state

Never store plaintext secret material in the registry.

### 8B — Rotation, Expiry & Revocation Intelligence

Build:
- expiry detection
- rotation eligibility
- stale-secret detection
- revocation state
- rotation workflow hooks
- emergency invalidation hooks

### 8C — Existing Secret-System Integration

Integrate with existing:
- Vault
- JWT key management
- API key infrastructure
- webhook secrets
- OIDC signing key management
- other existing credential stores

Tests:
- metadata correctness
- expiry
- rotation state
- revocation
- secret non-disclosure
- permission boundaries
- failure recovery

### Definition of Done

Secret lifecycle risk is observable and manageable without creating a second secret store.

### Out of Scope

- plaintext secret database
- replacing Vault
- automatic rotation of every secret without verifying existing provider capabilities

---

# SEASON 9 — API Defense Engine

## Goal

Add adaptive security intelligence around APIs while preserving existing rate limits and API-key controls.

### 9A — Endpoint Sensitivity Catalog

Build:
- endpoint classification
- sensitivity levels
- authentication requirements metadata
- write/read classification
- abuse cost
- security-critical endpoint registry

### 9B — Adaptive Protection

Build:
- risk-aware request assessment
- adaptive throttling recommendations
- suspicious request detection
- API-key misuse signals
- endpoint-specific protection
- burst/rate anomaly correlation

Reuse existing:
- rate limiter
- API-key scope gate
- authentication middleware
- security headers
- request limits

### 9C — Integration & Testing

Integrate with selected high-risk routes first.

Tests:
- normal traffic
- bursts
- unauthorized access
- API-key misuse
- high-risk endpoint behavior
- concurrency
- rate-limit interaction
- regression

### Definition of Done

API protection becomes risk-aware without duplicating or replacing the existing rate-limiting/authentication primitives.

### Out of Scope

- replacing rate limiter
- replacing API-key system
- global automatic blocking without tested controls

---

# SEASON 10 — Security Operations: Audit, Forensics & Response

## Goal

Finish the SIORA security lifecycle by turning signals into operationally useful audit, investigation, alerting, and controlled response.

### 10A — Security Audit & Forensics

Build:
- normalized security event schema
- event categories
- actor/request correlation
- event integrity metadata
- investigation-friendly search fields
- timeline reconstruction support
- security event retention rules

Integrate with existing audit infrastructure instead of creating duplicate audit systems.

### 10B — Security Response Engine

Build:
- response action registry
- severity-based response recommendations
- containment hooks
- escalation hooks
- notification hooks
- recovery state
- response audit trail
- idempotent response execution

Potential actions must be safe and existing-system-aware:
- require step-up
- revoke session
- temporarily restrict an action
- increase monitoring
- create incident
- notify authorized operators

Avoid irreversible autonomous actions by default.

### 10C — Operations, Dashboard & Full Regression

Add operational visibility for authorized administrators/operators:
- security event overview
- active incidents
- risk trends
- engine health
- response history
- investigation timeline
- configuration status

Run the complete SIORA regression suite across Seasons 1–10.

Verify:
- migrations
- production configuration
- rate limits
- access controls
- audit integrity
- secret redaction
- engine failure behavior
- performance
- concurrency
- startup/restart behavior

### Definition of Done

SIORA can:

1. receive security events
2. normalize context
3. generate signals
4. evaluate threat/identity/session/abuse risk
5. aggregate risk
6. provide security context to Policy Engine
7. protect sensitive data
8. monitor secret lifecycle
9. defend APIs adaptively
10. audit security activity
11. create and manage incidents
12. execute safe, controlled response hooks
13. expose authorized operational visibility

---

# Cross-Season Security Requirements

Every season must preserve:

## Authentication
Reuse the existing authentication authority.

## Authorization
The existing Policy Engine remains the policy/authorization authority.

## OIDC
Reuse existing OIDC implementation and security context.

## Sessions
Reuse existing session infrastructure.

## Vault / Secrets
Reuse existing secret-management infrastructure.

## Database
Use the existing DB abstraction and canonical migration mechanism.

## Audit
Prefer extending the existing audit system over creating a parallel audit log.

## Rate Limiting
Extend existing rate limiting rather than creating another limiter.

## API Keys
Extend existing API-key controls rather than replacing them.

## Logging
All SIORA logging must be sanitized.

## Correlation
Security events must support correlation/request IDs.

## Failure Handling
Security-engine failures must have explicit fail-open/fail-closed behavior appropriate to the control.

## Production Safety
No demo credentials, mock security decisions, development bypasses, or test-only privileged accounts may become active in production.

---

# Recommended Season Completion Gate

A season is COMPLETE only when all are true:

[ ] A complete
[ ] B complete
[ ] C complete
[ ] No known TODO/placeholder in season scope
[ ] Existing architecture preserved
[ ] Existing security systems reused
[ ] Typecheck passes
[ ] Relevant unit tests pass
[ ] Integration tests pass where available
[ ] Security regression tests pass
[ ] Migration/startup safety verified
[ ] Production defaults verified
[ ] Secrets/logging audit completed
[ ] Documentation updated
[ ] Changed files reviewed
[ ] No future-season implementation added
[ ] Remaining risks documented
[ ] Season marked COMPLETE

---

# Final Architecture After Season 10

AYZEN becomes conceptually:

                    ┌─────────────────────┐
                    │   Application/API   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   SIORA Context     │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   Threat Intel        Identity Trust       Session Security
          │                    │                    │
          └──────────────┬─────┴─────┬──────────────┘
                         ▼
                  Abuse Detection
                         │
                         ▼
                  Risk & Anomaly
                         │
                         ▼
                ┌────────────────┐
                │ Security       │
                │ Context        │
                └───────┬────────┘
                        │
                        ▼
               Existing Policy Engine
                        │
                        ▼
               Application Decision
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
    Data Security  Secrets Security  API Defense
          │             │             │
          └─────────────┼─────────────┘
                        ▼
               Audit / Forensics
                        │
                        ▼
                 Response Engine
                        │
                        ▼
                 Security Operations

The result is a layered architecture rather than a replacement architecture.

SIORA = security intelligence + detection + risk + operational response.
Policy Engine = authorization/policy decision authority.
Existing AYZEN services = business/application authority.

This separation must remain intact.
