# AYZEN Policy & Authorization Mega Engine — Phase 01, Sub-phase 1B: PIP (Policy Information Point) Adapters

## যা আগে থেকেই ছিল (Phase 1A-এর পর)
- Phase 1A একটা সম্পূর্ণ standalone PDP core দিয়েছে (`PolicyEngine`, `AuthorizationRequest`/`Decision`, reason codes) — কিন্তু `Subject`/`PolicyContext` বানানোর কোনো জায়গা ছিল না। Roadmap-এর টার্গেট আর্কিটেকচারে PDP-এর ঠিক আগেই যে PIP (Policy Information Point) বক্স আছে, সেটা এখনো ফাঁকা ছিল।
- বাস্তবে identity ইতিমধ্যেই `middlewares/auth.ts`-এর `requireAuth`/`requireAdmin`/ইত্যাদি ভেরিফাই করে `req.user: AuthUser = { userId, role, authType?, keyType?, scopes? }`-এ বসায় (দেখুন `auth-utils.ts`-এর `getUserFromToken()`)। এই শেপটা Phase 1A-এর `Subject` টাইপের প্রায় হুবহু সমান — শুধু কেউ সেই ম্যাপিংটা এক জায়গায় লিখে রাখেনি।

## যেটা যোগ করা হলো (Phase 1B)
শুধু PIP adapter — বিদ্যমান, ইতিমধ্যে-ভেরিফাইড ডেটা থেকে PDP-এর ইনপুট শেপ বানানো:

```
Identity → PIP → PDP/Policy Engine → Decision → PEP → Business Action → Audit
           ^^^
           এই ফেজে শুধু এইটুকু
```

### Backend
| ফাইল | কী আছে |
|---|---|
| `artifacts/api-server/src/lib/policy/pip/subject-adapter.ts` | **নতুন** — `subjectFromAuthUser(user)`: `req.user`-এর শেপ (`AuthenticatedUserLike` — structurally `AuthUser`-এর সাথে মেলে, কিন্তু `middlewares/auth.ts` থেকে import করা হয়নি, যাতে policy module Express middleware-এর ওপর নির্ভর না করে) থেকে `Subject | null` বানায় |
| `artifacts/api-server/src/lib/policy/pip/context-adapter.ts` | **নতুন** — `policyContextFromRequest(req, opts?)`: Express `Request` থেকে `PolicyContext` বানায় (correlation id: caller-supplied > `X-Request-Id` header > generated; `req.ip`; caller-supplied `sessionId`) |
| `artifacts/api-server/src/lib/policy/index.ts` | পরিবর্তিত — নতুন দুইটা barrel export যোগ (`./pip/subject-adapter`, `./pip/context-adapter`) |
| `scripts/src/test-policy-pip.ts` | **নতুন** — DB-free standalone test, Express থেকে শুধু `Request` টাইপ import করে (fake request object দিয়ে টেস্ট, আসল সার্ভার/network লাগে না) |

### ডিজাইন সিদ্ধান্ত ও কেন
- **`AuthUser` import না করে নিজের `AuthenticatedUserLike` টাইপ বানানো হলো।** Phase 1A-এর নীতি ছিল `lib/policy/*` কোনো framework (Express) বা এমনকি অন্য কোনো app ফাইলের ওপর নির্ভর না করুক। `context-adapter.ts`-এ Express-এর `Request` টাইপ লাগবেই (এটাই PIP adapter-এর কাজ), কিন্তু `subject-adapter.ts`-এর কোনো Express লাগে না, তাই সেটাকে খামোখা `middlewares/auth.ts`-এর সাথে কাপল করার দরকার নেই — structural typing দিয়ে `req.user` কল সাইটে zero-cost pass করা যায়।
- **`authType` অনুপস্থিত/অচেনা হলে `"session"`-এ normalize করা হয়েছে, deny নয়।** `AuthUser.authType` আজকের কোডে optional (কিছু পুরনো কোড পাথ এটা সেট করে না)। এটাকে invalid ধরে deny করাটা ভুল হতো — এটা "authentication ব্যর্থ" নয়, শুধু "মেটাডেটার একটা ঐচ্ছিক ফিল্ড নেই"। তাই adapter নিজেই normalize করে; `buildAuthorizationRequest()`-এর ভ্যালিডেশন (Phase 1A) তাও অক্ষত থাকে অন্য কোনো সত্যিকারের malformed subject-এর জন্য।
- **`organizationId` এবং `assuranceMethods` ইচ্ছাকৃতভাবে সবসময় `undefined`।** AYZEN-এ এখনো কোনো `organizations` টেবিল নেই (grep করে যাচাই করা হয়েছে), আর কোনো সেশন/লগইন-সিকিউরিটি টেবিল এখনো রেকর্ড করে না কোন MFA method ব্যবহার হয়েছে। এগুলো অনুমান করে বসিয়ে দেওয়াটা Rule 16 ("do not implement future phases prematurely")-এর লঙ্ঘন হতো — Phase 03 আর Phase 09 যখন এই ডেটা মডেলগুলো আনবে, তখন এই একই ফাংশনে বসানো যাবে।
- **`context-adapter.ts` টোকেন ভেরিফাই করে `sid` বের করে না।** সেটা করলে `auth-utils.ts`/`lib/jwt.ts`-এর টোকেন-ভেরিফিকেশন লজিক দ্বিতীয় একটা জায়গায় ডুপ্লিকেট হতো — এবং দুইটা জায়গা কখনো diverge করলে (যেমন একটায় revocation check থাকবে, আরেকটায় না) সেটা একটা সিকিউরিটি বাগ। তাই `sessionId` একটা optional param হিসেবে রাখা হয়েছে — future PEP layer, যেটা ইতিমধ্যেই ভেরিফাইড `sid` জানবে, সেটা supply করবে।

## যা Phase 1B-তে ইচ্ছাকৃতভাবে করা হয়নি
- **কোনো route/middleware-এ wiring নেই।** কোনো route এখনো `subjectFromAuthUser`/`policyContextFromRequest` কল করে না — grep করে নিশ্চিত করা হয়েছে (নিচে দেখুন)। রানটাইম বিহেভিয়ার Phase 1A-এর মতোই অপরিবর্তিত।
- **`ResourceRef` builder নেই।** নির্দিষ্ট রিসোর্স (vault item, payment, ইত্যাদি) থেকে `ResourceRef` বানানো Phase 03 (Resource / Ownership Authorization)-এর কাজ — সেই ফেজেই আসল ownership/organization ডেটা লাগবে, এখানে জোর করে বসানো হয়নি।
- **`middlewares/auth.ts` টাচ করা হয়নি।** `AuthUser` টাইপ, `requireAuth`/`requireAdmin` — কিছুই বদলায়নি।

## যা টেস্ট করা হয়েছে
- এই sandbox-এ network বন্ধ থাকায় `node_modules` ইনস্টল করা যায়নি (Phase 1A-এর কিছু পাসে যেমন সম্ভব হয়েছিল, এবার হয়নি) — তাই `tsc`/`tsx` দিয়ে সরাসরি রান/টাইপচেক করা যায়নি এই পাসে।
- নতুন প্রতিটা ফাইলের bracket/paren/brace balance স্ক্রিপ্ট দিয়ে চেক করা হয়েছে — সব ঠিক আছে।
- প্রতিটা import path হাতে verify করা হয়েছে (`../types`, `../policy-context`, relative paths সব সঠিক ডিরেক্টরি-ডেপথ মেনে)।
- `test-policy-pip.ts`-এ roadmap-সামঞ্জস্যপূর্ণ কেসগুলো লেখা হয়েছে (session/apikey/legacy mapping, missing/malformed `authType` normalization, null passthrough, header precedence, array-valued/blank header handling, ip/sessionId passthrough) — কোড-রিভিউ দিয়ে verify করা হয়েছে যে প্রতিটা assertion adapter-এর আসল লজিকের সাথে মেলে, কিন্তু **আসলে execute করে পাস confirm করা এই পাসে সম্ভব হয়নি** (network/node_modules না থাকায়)। পরের রিভিউ পাসে (`node_modules` উপলব্ধ হলে) `npx tsx scripts/src/test-policy-pip.ts` চালিয়ে confirm করা প্রয়োজন — এটা একটা known limitation, production-ready দাবি করা হচ্ছে না।
- Grep করে নিশ্চিত করা হয়েছে `artifacts/api-server/src` জুড়ে কোথাও `subjectFromAuthUser`/`policyContextFromRequest` কল হচ্ছে না — কোনো route/middleware এই adapter সম্পর্কে জানে না, রানটাইম বিহেভিয়ার অপরিবর্তিত।

## Known limitations
- Offline sandbox-এ real `tsc`/test-run verification করা যায়নি (উপরে বলা হয়েছে) — এটা একটা blocking item পরবর্তী audit-এর আগে, ছদ্মবেশে "done" দেখানো হচ্ছে না।
- `sessionId`/`organizationId`/`assuranceMethods` এখনো কোথাও populate হয় না — সেগুলোর প্রকৃত ডেটা সোর্স ভবিষ্যৎ ফেজের কাজ (উপরে বলা হয়েছে)।

## পরের ধাপ (Phase 1C, এই ফেজের অংশ না)
`PolicyEngine`-এর একটা optional decision-observability hook (audit/logging-এর ভিত্তি, কিন্তু Phase 17-এর মতো DB persistence নয়) — যাতে ভবিষ্যতে decision log করা সহজ হয়, engine-এর নিজের কোর লজিক না ছুঁয়ে।
