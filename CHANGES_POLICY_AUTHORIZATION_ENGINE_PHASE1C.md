# AYZEN Policy & Authorization Mega Engine — Phase 01, Sub-phase 1C: Decision-Observability Hook

## যা আগে থেকেই ছিল (Phase 1A/1B-এর পর)
- `PolicyEngine.evaluate()` একটা `AuthorizationDecision` রিটার্ন করে, কিন্তু সেই decision নিয়ে caller ছাড়া আর কেউ জানে না — কোনো log line, কোনো hook, কিছু নেই। Roadmap-এর Rule 10 ("sensitive authorization decisions must be auditable") আর Phase 17 ("AUTHORIZATION AUDIT") এখনো অনেক দূরে, কিন্তু সেই ফেজ যখন আসবে তখন engine-এর কোর evaluation লজিক দ্বিতীয়বার না ছুঁয়ে যেন decision-গুলো ধরা যায়, তার জন্য একটা observation seam এখনই থাকা দরকার।

## যেটা যোগ করা হলো (Phase 1C)
`PolicyEngine`-এ একটা **optional** `onDecision` hook — engine যত decision-ই produce করুক (invalid context, unauthenticated, explicit allow/deny, step-up, approval, evaluation error, default-deny), সবগুলোই এই hook-এ যায়, hook থাকলে।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/policy/policy-engine.ts` | পরিবর্তিত — `PolicyEngine`-এর constructor এখন ঐচ্ছিক `PolicyEngineOptions { onDecision? }` নেয়। পুরনো `evaluate()`-এর সব লজিক অপরিবর্তিত `evaluateCore()`-এ সরানো হয়েছে (নাম আর রিটার্ন শেপ ছাড়া এক অক্ষরও বদলায়নি); `evaluate()` এখন একটা পাতলা wrapper — `evaluateCore()` কল করে, তারপর (থাকলে) observer-কে notify করে, তারপর ঠিক আগের মতোই decision রিটার্ন করে |
| `artifacts/api-server/src/lib/policy/decision-observer.ts` | **নতুন** — `createLoggingObserver(logger)`: একটা প্রস্তুত `onDecision` implementation, যেকোনো pino-সদৃশ (`DecisionLoggerLike`) logger দিয়ে decision log করে। App-এর আসল `lib/logger.ts` import করা হয়নি — শুধু structural interface চাওয়া হয়েছে, যাতে `lib/policy/*` এখনো কোনো app singleton-এর ওপর নির্ভর না করে (Phase 1A-এর মতোই নীতি) |
| `artifacts/api-server/src/lib/policy/index.ts` | পরিবর্তিত — নতুন barrel export (`./decision-observer`) |
| `scripts/src/test-policy-decision-observer.ts` | **নতুন** — DB-free standalone test |

### `onDecision`-এর কনট্র্যাক্ট (কেন এভাবে ডিজাইন করা হলো)
- **Decision বদলাতে/আটকাতে পারে না।** Hook-টা call হয় decision চূড়ান্ত হয়ে যাওয়ার *পরে* — `evaluate()`-এর রিটার্ন ভ্যালু hook থাকুক বা না থাকুক হুবহু এক। এটা pure observation, enforcement না।
- **Hook থ্রো করলে (বা reject করা promise রিটার্ন করলে) সেটা `evaluate()`-এর caller পর্যন্ত পৌঁছায় না, এবং decision বদলায় না।** যুক্তি: একটা logging bug কখনোই authorization-কে fail করাতে পারবে না — সেটা হলে fail-closed-এর চেতনাটাই উল্টে যেত (একটা observability bug availability bug হয়ে যেত)।
- **Hook-এর promise `evaluate()`-এর নিজের promise chain-এ await করা হয় না।** একটা ধীর/hang হয়ে যাওয়া observer authorization decision-এর latency-তে যোগ হবে না।
- **`request` প্যারামিটার শুধু একটা branch-এ `undefined` হয়** — যখন input নিজেই এত malformed যে `AuthorizationRequest` বানানোই যায়নি (`INVALID_AUTHORIZATION_CONTEXT`)। বাকি সব ক্ষেত্রে সবসময় present।

### `createLoggingObserver` কেন এভাবে
- `ALLOW` → `logger.info()`, বাকি সব (`DENY`/`STEP_UP`/`APPROVAL_REQUIRED`) → `logger.warn()` — deny মানেই bug না (default-deny ঠিকঠাক কাজ করছে মানে system সঠিকভাবে কাজ করছে), কিন্তু existing log tooling-এ denial spike সহজে filter করার জন্য warn লেভেল বেছে নেওয়া হয়েছে।
- Log field-এ ইচ্ছাকৃতভাবে কম জিনিস আছে (`requestId`, `effect`, `reason`, `policyId`, `action`, `resourceType`, `subjectPresent`) — কোনো raw resource payload, scope, IP, session id নেই। কোনটা প্রকৃতপক্ষে durable audit storage-এ (Phase 17) যাবে সেটা এই ফাইলের সিদ্ধান্ত না; এটা শুধু debug-level log line।
- এটা **Phase 17 না।** এখানে কোনো DB write, কোনো `decisionId`, কোনো retention policy নেই — শুধু log line। Phase 17 এই একই `onDecision` seam-এর ওপর আসল persistence বসাতে পারবে, engine আবার না ছুঁয়ে।

## যা Phase 1C-তে ইচ্ছাকৃতভাবে করা হয়নি
- **কোথাও `new PolicyEngine({ onDecision: ... })` কল করা হয়নি।** কোনো route/app.ts এই hook ব্যবহার করছে না — grep করে নিশ্চিত করা হয়েছে। App-এর রানটাইম বিহেভিয়ার Phase 1A/1B-এর মতোই অপরিবর্তিত।
- **`lib/logger.ts` টাচ করা হয়নি।** `createLoggingObserver` কল সাইটে যেকোনো compatible logger নেয়; app-এর আসল logger wire করা এখনো caller-এর কাজ, যেটা এখনো কেউ করছে না।
- **কোনো persistence/DB table নেই** — সেটা Phase 17।

## যা টেস্ট করা হয়েছে
- এই sandbox-এ network বন্ধ, `node_modules` ইনস্টল করা যায়নি — তাই Phase 1B-এর মতোই, এই পাসেও `tsc`/`tsx` দিয়ে সরাসরি রান/টাইপচেক সম্ভব হয়নি। এটা একটা known limitation।
- Bracket/paren/brace balance স্ক্রিপ্ট দিয়ে সব নতুন/edited ফাইল চেক করা হয়েছে — ঠিক আছে।
- **রিগ্রেশন-চেক (কোড রিভিউ দিয়ে, execute করে না):** `evaluateCore()`-এর ভেতরের লজিক Phase 1A-এর `evaluate()`-এর সাথে লাইন-বাই-লাইন তুলনা করা হয়েছে — শুধু রিটার্ন শেপ (`{ decision, request }` বনাম সরাসরি `decision`) বদলেছে, condition/branch/order কিচ্ছু বদলায়নি। ফলে Phase 1A-এর `test-policy-engine.ts` (public `evaluate()` সিগনেচার অপরিবর্তিত) আগের মতোই পাস করার কথা।
- `test-policy-decision-observer.ts`-এ কভার করা হয়েছে: observer ছাড়া আগের behavior অপরিবর্তিত, প্রতিটা decision branch-এ (allow/deny/deny-overrides/invalid-context/evaluation-error/default-deny) observer সঠিক আর্গুমেন্ট পায়, sync-throwing observer, async-rejecting observer, `createLoggingObserver`-এর info/warn split, আর logger নিজেই throw করলেও propagate না করা। এই assertion-গুলো কোড-রিভিউ দিয়ে যাচাই করা হয়েছে (adapter/engine-এর আসল লজিকের সাথে মিলিয়ে), কিন্তু **আসলে চালিয়ে পাস কনফার্ম করা এই পাসে সম্ভব হয়নি** (একই network/node_modules সীমাবদ্ধতা) — পরের রিভিউ পাসে `npx tsx scripts/src/test-policy-decision-observer.ts` এবং `npx tsx scripts/src/test-policy-engine.ts` (regression) দুটোই চালিয়ে কনফার্ম করা প্রয়োজন।
- Grep করে নিশ্চিত করা হয়েছে `artifacts/api-server/src` জুড়ে কোথাও `onDecision`/`createLoggingObserver`/`new PolicyEngine(` কল হচ্ছে না এই ফেজের ফাইলগুলো ছাড়া।

## Known limitations
- Offline sandbox-এ real `tsc`/test-run verification করা যায়নি (Phase 1B-এর মতোই) — production-ready দাবি করা হচ্ছে না, পরের অডিটের আগে এটা resolve করা দরকার।
- Hook থাকলে প্রতিটা `evaluate()` কলে একটা extra try/catch এবং (async hook হলে) একটা ignored promise তৈরি হয় — নগণ্য কিন্তু শূন্য না; hook না থাকলে (`this.onDecision` undefined) `notifyObserver()` প্রথম লাইনেই রিটার্ন করে, তাই Phase 1A/1B-এর মতো ব্যবহারে (hook ছাড়া) ওভারহেড কার্যত অপরিবর্তিত।

## পরের ধাপ (এই ফেজের অংশ না)
Phase 01-এর roadmap-লিখিত সব আইটেম (types, engine, reason codes, correlation id, deterministic eval, default-deny) এবং তার test list Phase 1A-তেই সম্পূর্ণ হয়েছিল; 1B/1C সেই ভিত্তির ওপর PIP আর observability যোগ করেছে, কোনোটাই route/middleware-এ wire করেনি। পরবর্তী প্রকৃত ধাপ roadmap-এর **Phase 02 — RBAC** (roles/permissions/role_permissions/user_roles ডেটা মডেল, প্রথম প্রকৃত `PolicyRule`-গুলো এই engine-এ register করা)। Rule 15 অনুযায়ী Phase 02 শুরুর আগে এই তিনটা sub-phase (1A+1B+1C) একসাথে review/audit হওয়া উচিত — বিশেষভাবে: `PolicyRule` সিগনেচার, combining algorithm, reason-code vocabulary, আর `Subject`/`ResourceRef` শেপ চূড়ান্ত ধরে নেওয়া ঠিক হবে কিনা, কারণ Phase 02-এর সব rule ঠিক এই একই ইন্টারফেসের ওপর বসবে।
