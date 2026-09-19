# AYZEN Mega Engine — J1–J5 এবং J10–J15 পরিবর্তন নথি

তারিখ: ১৯ সেপ্টেম্বর ২০২৬

## কাজের পরিধি

এই নথিতে J1–J5 এবং J10–J15 roadmap scope-এর বর্তমান implementation,
hardening, test coverage এবং production-readiness ফলাফল রাখা হলো। AYZEN-এর
domain service, Event Bus, Workflow Engine এবং Scheduler আলাদা ownership boundary
হিসেবে রাখা হয়েছে; Mega Engine শুধু orchestration, durability এবং operations
layer সমন্বয় করে।

## J1 — Workflow timeout এবং cancellation hardening

- প্রতিটি step-এর `timeoutMs` অনুযায়ী `AbortController` signal পাঠানো হয়।
  Timeout হলে action abort করা হয়, step failure durable ভাবে লেখা হয় এবং
  retry policy অনুযায়ী পরবর্তী সিদ্ধান্ত নেওয়া হয়।
- Workflow-level `maxRuntimeMs` `PENDING → RUNNING`, প্রতিটি loop iteration এবং
  delayed resume-এর আগে পরীক্ষা করা হয়।
- Timeout হলে run deterministic ভাবে `TIMED_OUT` হয় এবং `workflow.timed_out`
  event outbox-এ যায়।
- `PENDING`, `RUNNING` এবং `WAITING` run operator cancel করতে পারে; cancel-এর
  reason এবং actor user ID durable ভাবে রাখা হয়।
- Waiting run cancel হলে তার `workflow.resume` scheduler job-ও cancel হয়।
  Duplicate বা late wakeup এলে terminal run আর resume হয় না।
- Action চলাকালীন cancellation হলে action settle করার পর live run state আবার
  পড়া হয়; cancelled run-এর step pointer বা status আর overwrite হয় না।
- Timeout এবং cancellation metrics ও audit path যুক্ত আছে।

## J2 — Scheduler trigger deduplication

- Trigger থেকে deterministic idempotency key তৈরি হয়।
- Scheduled job idempotency key-এর partial unique index duplicate job আটকায়।
- Workflow resume এবং compensation job correlation দিয়ে খুঁজে cancel করা যায়।
- Recurring schedule startup-এ active correlation check করে re-register duplicate
  না করার চেষ্টা করে।
- Scheduler worker database lease, `FOR UPDATE SKIP LOCKED` claim এবং expired
  lease recovery ব্যবহার করে।

## J3 — Trace এবং correlation propagation

নিচের identifier chain Event Bus, Workflow এবং Scheduler-এর মধ্যে রাখা হয়:

`traceId → correlationId → causationId → eventId → workflowRunId → jobId`

- API request AsyncLocalStorage trace context শুরু করে।
- Incoming trace/correlation headers bounded validation-এর পর গ্রহণ করা হয়;
  না থাকলে নতুন trace তৈরি হয়।
- Response-এ `x-trace-id` এবং থাকলে `x-correlation-id` ফেরত যায়।
- Outbox event, workflow run, scheduled job এবং audit record-এ trace metadata
  persist হয়।

## J4 — Audit integration

- Workflow lifecycle, scheduler lifecycle, job lifecycle, policy denial,
  domain lifecycle এবং dead-letter replay audit sink-এ লেখা হয়।
- Actor, organization, aggregate/resource, event, workflow, job, trace,
  correlation এবং causation link রাখা হয়।
- `engine_audit_log` আলাদা durable sink হিসেবে ব্যবহৃত হয়েছে; generic activity
  log-এ engine identifier জোর করে ঢোকানো হয়নি।
- Secret-like metadata key redaction boundary-এর মধ্যে থাকে—token, password,
  credential, cookie, authorization, private key এবং seed phrase সরাসরি audit-এ
  লেখা হয় না।

## J5 — Event ↔ Workflow ↔ Scheduler পূর্ণ integration

বাস্তব flow:

```text
Event → Workflow
Event → Scheduler
Scheduler → Workflow
Workflow → Scheduler
Workflow → Event
```

- Event trigger durable workflow run শুরু করে।
- Schedule/delayed trigger durable scheduler job তৈরি করে।
- Workflow wait করলে database-এ state এবং `next_resume_at` রাখা হয়; blocking
  `sleep()` ব্যবহার করা হয় না।
- Resume/compensation scheduler job-এর idempotency ও correlation guard আছে।
- Workflow started/completed/failed/cancelled/timed-out lifecycle event outbox
  দিয়ে reverse-publish হয়।

## J10 — Advanced observability এবং admin operations

- Event, workflow run, scheduled job এবং audit record cross-link করা যায়।
- Operations snapshot-এ worker state, queue depth, dead-letter count, scheduler
  lag, workflow latency, event latency, retry count, failure rate এবং capacity
  দেখা যায়।
- Admin surface-এ inspect, replay, retry/resume, cancel, pause, discard,
  retention এবং readiness operations আছে।
- Privileged operations existing admin/policy gate-এর পেছনে থাকে এবং audit হয়।

## J11 — Integration ও E2E test layer

- Mega Engine contract test এখন workflow timeout/cancel/compensation state
  boundary যাচাই করে।
- Capacity test configured in-flight ceiling অতিক্রম না করার concurrent
  execution যাচাই করে।
- Existing event, scheduler, workflow এবং audit contract tests-এর পাশে এই
  tests রাখা হয়েছে, যাতে state transition ও overload behavior আলাদা করে ধরা যায়।
- Database-backed full E2E scenarios—duplicate delivery, lease expiry,
  restart recovery, stale-role denial, DLQ replay এবং full API → service →
  event → workflow → scheduler chain—পরবর্তী disposable-database verification
  pass হিসেবে চিহ্নিত আছে; dependency bootstrap না হওয়ায় এই environment-এ
  runtime pass চালানো যায়নি।

## J12 — Performance, backpressure এবং capacity

- Event ও Scheduler batch size environment configuration থেকে আসে।
- `ENGINE_EVENT_MAX_IN_FLIGHT` এবং `ENGINE_SCHEDULER_MAX_IN_FLIGHT` এখন
  বাস্তবে dispatch concurrency সীমাবদ্ধ করে; batch claim থাকলেও process
  overload হয় না।
- Retry storm gate configured window ও limit-এ hot retry loop throttle করে।
- Throttled retry durable retry state নষ্ট না করে পরের retry delay বাড়ায়।
- Existing latency, queue depth, scheduler lag, workflow latency, retry এবং
  failure metrics operations snapshot-এ যুক্ত।

## J13 — Startup, shutdown এবং worker lifecycle

Startup order:

```text
configuration validate
→ database probe
→ handler/trigger registration
→ expired lease recovery
→ workflow recovery
→ event dispatcher start
→ scheduler worker start
```

Shutdown order:

```text
stop claiming new work
→ drain in-flight event/scheduler sweeps
→ allow durable leases to recover interrupted work
→ stop Mega Engine
```

`SIGTERM` এবং `SIGINT` graceful shutdown path ব্যবহার করে। Process crash হলে
durable event/job/workflow leases পরবর্তী boot-এ reclaim হয়।

## J14 — Retention এবং cleanup hardening

- Event outbox, processing claim, processed dedupe row, resolved DLQ,
  scheduled-job attempt, terminal scheduled job এবং terminal workflow-এর
  আলাদা retention window আছে।
- Cleanup batch-based এবং repeated batch sweep দিয়ে backlog drain করে।
- Workflow child rows—step run, checkpoint, variable—parent run-এর আগে একই
  transaction-এ delete হয়।
- Pending/active work এবং pending DLQ generic cleanup-এর মাধ্যমে delete হয় না।
- Audit log generic engine retention sweep-এর বাইরে রাখা হয়েছে।
- Retention sweep নিজেই scheduler job হিসেবে registered এবং restart-safe
  correlation guard ব্যবহার করে।

## J15 — Final production readiness audit

Readiness endpoint এখন অন্তত নিচের বিষয় যাচাই করে:

- configuration validity;
- database connectivity;
- required durable table presence;
- event registry এবং scheduler handler registration;
- admin authorization boundary;
- secret exclusion/redaction boundary।

Architecture, security, reliability, workflow, scheduler, Event Bus, operations
এবং testing category এই implementation review-এ documented হয়েছে। Readiness
endpoint `FAIL` check থাকলে `ready: false` দেয়; `WARN` informational থাকে।

## Verification status

- `git diff --check` চালানো হয়েছে।
- নতুন concurrency ও workflow state-machine tests যোগ করা হয়েছে।
- Full TypeScript/runtime/database E2E verification এখনও সম্পূর্ণ হয়নি, কারণ
  workspace dependency install-এর সময় package-manager bootstrap timeout হয়েছে
  এবং `node_modules` উপস্থিত ছিল না।
- তাই এই নথি implementation completion এবং verification boundary—দুইটিই
  স্পষ্টভাবে আলাদা করে দেখায়; unverified runtime result-কে passing বলা হয়নি।

## অপারেশনাল সিদ্ধান্ত

J1–J5 এবং J10–J15-এর code path এখন durable state, conditional update, lease,
idempotency, trace, audit, capacity এবং readiness boundary-র ওপর দাঁড়ানো। Domain
business logic Mega Engine-এ সরানো হয়নি। Production sign-off-এর আগে lockfile
install করে typecheck, disposable database migration এবং concurrent worker E2E
চালানো আবশ্যক।