# AYZEN Mega Engine — Phase C পূর্ণ (Workflow Execution Loop) + Phase D1 শুরু (Event Bus ↔ Workflow)

## Phase C (Workflow) — যেটা মিসিং ছিল

Uploaded zip টা ছিল "Phase 8 through C1" — মানে schema (migration 113),
`types.ts`, `definition-store.ts`, `run-store.ts`, `state-machine.ts`,
`context.ts` — এই ৬টা ফাইল দিয়ে C1 (durable core) শেষ, কিন্তু C2
(execution logic) এর কোনো ফাইলই আসলে codebase-এ merge করা ছিল না।
আলাদাভাবে uploaded ছিল C2-এর draft গুলো (`conditions.ts`, `actions.ts`,
`authorization.ts`, `compensation.ts`, `engine-types.ts`,
`scheduler-integration.ts`, `scheduler-handler.ts`, updated
`types.ts`/`definition-store.ts`/`run-store.ts`/`index.ts`) — এবং সবচেয়ে
গুরুত্বপূর্ণ, `engine.ts` — যেটা এই সব কটা module-কে একসাথে চালায়, `index.ts`
থেকে `runStep`/`executeRun`/`resumeRun` export করার কথা বলা থাকলেও ফাইলটাই
কোথাও ছিল না।

### যা করা হলো
- `engine.ts` merge করা হলো (আপনার uploaded draft-টাই ব্যবহার করা হয়েছে —
  সেটা নিজে থেকেই খুব সুচিন্তিতভাবে লেখা: step retry backoff-ও §24-এর
  WAITING/scheduler-wakeup mechanism-ই reuse করে (worker আটকে রেখে
  `sleep()` করে না), step output স্বয়ংক্রিয়ভাবে `workflow_variable`-এ
  save হয় (`setVariable(run.id, step.id, output)`), আর compensation তখনই
  ট্রিগার হয় যখন আসলেই কোনো completed step-এর নিজের `compensation` step
  declare করা আছে — নাহলে সরাসরি `FAILED`, মিছেমিছি `COMPENSATING` অবস্থায়
  না গিয়ে (§25: "do not pretend every action is reversible")।
- বাকি সব C2 draft ফাইল (`types.ts`, `definition-store.ts`, `run-store.ts`,
  `conditions.ts`, `actions.ts`, `authorization.ts`, `compensation.ts`,
  `engine-types.ts`, `scheduler-integration.ts`, `scheduler-handler.ts`,
  `index.ts`) আসল codebase-এর `artifacts/api-server/src/lib/workflow/`-এ
  copy করে সব import/export হাতে verify করা হলো (কোনো `tsc` build চালানো
  যায়নি — repo-তে `node_modules` install করা নেই, আর pnpm workspace পুরোটা
  install করতে যাওয়াটা এই সেশনের scope-এর বাইরে) — সব file-এর প্রতিটা
  import তার target file-এর actual export-এর সাথে মিলিয়ে দেখা হয়েছে
  (schema table names, `@workspace/db` barrel, `../policy/types`,
  `../scheduler`-এর `nextAttemptDelayMs` সহ)।
- কোনো নতুন migration লাগেনি — migration 113-এর ৫টা টেবিলই C2-এর জন্য যথেষ্ট।

### Definition of Done (§63) চেকলিস্টের Workflow অংশ
- [x] durable definitions/runs/step state (C1)
- [x] checkpoint/resume (`recordCheckpoint`, `resumeRun`)
- [x] conditions (§20)
- [x] retries (per-step `RetryPolicy`, backoff via scheduler-wakeup reuse)
- [x] timeout — **নোট**: step-level `timeoutMs` এখনো enforce হয় না (definition
      এ field আছে কিন্তু `engine.ts` কোথাও `Promise.race` করছে না); run-level
      `maxRuntimeMs`-ও একই অবস্থায় — এটা এখনো ফাঁকা, পরের ছোট ফলো-আপ ফেজে ঠিক
      করা দরকার
- [x] waiting (§24)
- [ ] cancellation — `cancelRun()` (run-store.ts) status flip করে ঠিকই, কিন্তু
      `engine.ts`-এর loop চলাকালীন mid-step cancellation actually respect করে
      না (loop প্রতি iteration-এ run status re-check করে RUNNING কিনা, তাই
      পরের step-boundary-তে থেমে যাবে — কিন্তু ongoing action dispatch-এর
      মাঝখানে না)
- [x] compensation where needed (§25)

## Phase D1 শুরু — Event Bus ↔ Workflow (§23 "event" trigger)

নতুন ফাইল: `lib/workflow/triggers.ts`।

- `registerWorkflowEventTriggers(env)` — boot-এ একবার call করার জন্য
  (`registerWorkflowResumeHandler()`-এর মতোই posture)। সব ACTIVE,
  event-triggered workflow definition load করে, প্রতিটা distinct
  `eventType`-এর জন্য একটামাত্র event-bus consumer subscribe করে
  (`workflow-trigger:<eventType>`), আর সেই handler সব matching workflow_id
  fan-out করে `startRun()` + `executeRun()` কল করে।
- `definition-store.ts`-এ নতুন query: `listActiveEventTriggeredDefinitions()`।
- Redelivery-guard: একই event id-র জন্য একই workflow দুইবার run শুরু না করার
  জন্য একটা ছোট in-memory `(eventId:workflowId)` set — এখন **process-local**,
  restart হলে হারিয়ে যাবে। V1-এর জন্য ঠিক আছে (event-bus-এর নিজের redelivery
  window ছোট), কিন্তু durable করতে চাইলে `workflow_run`-এ
  `(definition_id, causation_id)`-এর উপর একটা unique constraint বসানোই
  সবচেয়ে পরিষ্কার পথ — এই ফেজে করা হয়নি।
- একটা workflow শুরু করতে ব্যর্থ হলে সেটা লগ হয়ে যায়, কিন্তু event-bus
  dispatcher-এর দিকে rethrow করা হয় না — একটা workflow-এর সমস্যার জন্য পুরো
  EVENT retry/dead-letter হয়ে যাওয়াটা ভুল (§14-এর "event ≠ authorization/
  guarantee" spirit-এরই সম্প্রসারণ)।

### এখনো বাকি (Part D-এর বাকি অংশ, D1-এর স্কোপের বাইরে)
- Workflow → Event Bus (উল্টো দিক): run lifecycle (`workflow.started` /
  `.completed` / `.failed`) নিজে থেকে event হিসেবে publish হওয়া — §39-এ metric
  হিসেবে আছে, event হিসেবে registry-তে এখনো registered না।
- "schedule"/"delayed" trigger kind-এর actual scheduler wiring (একটা cron/
  delayed job যেটা নিজে `startRun()` কল করবে) — এখনো নেই।
- "api"/"manual" trigger kind-এর route wiring — Part D-এর domain-integration
  অংশ (Organizations/Credits/Notifications/OIDC/Vault/Telegram/Astra) কারো
  সাথেই এখনো কানেক্ট করা হয়নি।
- Step-level `timeoutMs` enforcement (উপরে নোট করা)।
