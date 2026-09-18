# OIDC Roadmap — Season 1, Phase 1D-c: Key Lifecycle States

## যা আগে থেকেই ছিল
- Phase 1C (migration 078, `jwt_signing_keys` টেবিল): `status` কলাম
  ইতিমধ্যে তিনটা lifecycle state model করে — `active` / `retiring` /
  `retired` — প্লাস DB-level guarantee: exactly এক row `active` থাকতে পারে
  (`jwt_signing_keys_single_active` partial unique index), আর
  `retiring`/`retired`-এর জন্য timestamp consistency check (`retiring_at`,
  `retired_at`)।
- Phase 1D-a (`getVerificationKeys()`, `mergeVerificationKeys()`) আর 1D-b
  (`resolveVerificationKeys()`) দুটোই ইতিমধ্যে এই state model-টা সঠিকভাবে
  respect করে — verify পথ `retired` row বাদ দেয়, `active`/`retiring` দুটোই
  verify করে। কিন্তু rule-টা **implicit** ছিল, দুই জায়গায় আলাদা করে লেখা:
  - `fetchDbVerificationKeys()`-এর SQL-এ: `WHERE status IN ('active', 'retiring')`
  - `mergeVerificationKeys()`-এ: `if (k.status !== "active" && k.status !== "retiring") continue;`

  এই দুইটা এতদিন কাকতালীয়ভাবে সমান ছিল — কিন্তু কিছু enforce করছিল না যে
  ভবিষ্যতে একটা বদলালে অন্যটাও বদলাবে।

## যেটা যোগ করা হলো (Phase 1D-c)
`lib/jwt-keys.ts`-এ explicit lifecycle-rule functions — "কোন state সাইন
করতে পারে, কোনটা verify করতে পারে" প্রশ্নের একটামাত্র জায়গা:

- **`JwtKeyLifecycleStatus`** (`"active" | "retiring" | "retired"`) — DB
  কলামটা যা যা হতে পারে তার সম্পূর্ণ union। এটা `JwtKeyStatus`-এর (1D-a,
  শুধু `"active" | "retiring"`) superset — `JwtKeyStatus` ইচ্ছাকৃতভাবে এখনো
  আলাদা, ছোট টাইপ, কারণ একটা `VerificationKey`-এর কখনোই `status: "retired"`
  থাকার কথা না (SQL filter + merge, দুটোই সেটা আটকায়) — টাইপ-লেভেলেই সেই
  invariant-টা এনফোর্স করা।
- **`canSign(status)`** — শুধু `"active"` true। DB-এর single-active
  constraint-ই আজকে এটা enforce করছে, আর `signAuthToken()`/
  `signOAuthState()` (lib/jwt.ts) এখনো শুধু `getActiveKeypair()`-এর
  env-keypair দিয়েই সাইন করে, `jwt_signing_keys` পড়ে না — তাই `canSign()`
  আজকে কোনো live call-site-এ ব্যবহার হচ্ছে না, এটা Phase 1D-d-এর rotation
  write path-এর জন্য rule-টা আগে থেকেই নাম দিয়ে রাখা।
- **`canVerify(status)`** — `"active"` অথবা `"retiring"` true, `"retired"`
  সবসময় false। এটাই grace-period guarantee-টার নাম: সাইন করা বন্ধ হয়ে
  যাওয়া (`retiring`) key-ও ততদিন verify করে যাবে যতদিন না Phase 1D-e-এর
  retention policy অনুযায়ী `retired`-এ move করে।
- `fetchDbVerificationKeys()` আর `mergeVerificationKeys()` — দুটোই এখন এই
  একই `canVerify()`-থেকে derive করা rule ব্যবহার করে (SQL query
  `VERIFY_ELIGIBLE_STATUSES = ALL_LIFECYCLE_STATUSES.filter(canVerify)`
  দিয়ে dynamically বানানো হয়, hand-written `IN (...)` লিটারেলের বদলে) —
  ফলে দুইটা জায়গা আর আলাদাভাবে drift করতে পারবে না।
- **`warnIfMultipleActive()`** — merge-এর পরে যদি একের বেশি `active` key
  দেখা যায় (আজকে DB-এর constraint দিয়েই unreachable হওয়ার কথা, কিন্তু env
  keypair fallback logic-এর সাথে DB-এর কোনো সত্যিকার `active` row মিললে
  যদি kid না মেলে, তাহলে দুইটাই `active` হিসেবে merge-এ ঢুকে যায় — এটা
  আজকের বাস্তবতায় সম্ভব, কারণ 1C-এর কোনো write path নেই বলে যেকোনো
  ম্যানুয়ালি insert করা row-ই env-এর kid-এর সাথে না মেলার কথা) — এই
  drift-টা log করে, throw করে না (এটা read path, write path না)।

### এই ফেজে যা **নেই** (ইচ্ছাকৃতভাবে — Phase 1D-d/1D-e-এর কাজ)
- Rotation trigger/script — কোনো নতুন write path `jwt_signing_keys`-এ নেই,
  `canSign()` এখনো কোথাও actual signing decision-এ ব্যবহার হয় না
  (Phase 1D-d)।
- Retention duration / কবে `retiring` থেকে `retired`-এ move করা নিরাপদ —
  সেই policy প্রশ্ন (Phase 1D-e)।
- রোডম্যাপের illustrative চার-state sketch (`ACTIVE → RETIRING → GRACE →
  REMOVED`) অনুযায়ী কোনো নতুন DB column/state যোগ করা হয়নি — `retiring`
  DB state-টাই roadmap-এর `RETIRING` আর `GRACE` দুটোকেই কভার করে ধরা হয়েছে
  (নিচে বিস্তারিত), কারণ আজকের schema-তে ওই দুইয়ের মধ্যে আলাদা কোনো
  observable difference নেই। প্রয়োজন হলে সেটা split করা একটা retention-policy
  সিদ্ধান্ত, 1D-e-এর কাজ, schema recreate করার কাজ না।
- Token claims, discovery endpoint — অপরিবর্তিত।

### Roadmap-এর 4-state sketch বনাম আজকের 3-column schema
Roadmap টেক্সট lifecycle-টাকে illustrative ভাবে চারটা state হিসেবে দেখায়
(`ACTIVE → RETIRING → GRACE → REMOVED`), কিন্তু Phase 1C-এর schema (যেটা
"do not recreate" বলা আছে) মাত্র তিনটা column value রাখে (`active` /
`retiring` / `retired`)। এই দুইটা একই lifecycle-এর বিভিন্ন granularity-তে
বর্ণনা — সাইন করা বন্ধ হওয়া আর verify করা বন্ধ হওয়ার মাঝের পুরো window-টাই
আজকের `retiring` — সেখানে কোনো আলাদা DB-distinguishable মধ্যবর্তী state
নেই। তাই এই ফেজে `retiring`-কেই roadmap-এর `RETIRING`+`GRACE` দুটোর জন্যই
ব্যবহার করা হয়েছে — `canVerify("retiring") === true` লাইনটাই সেই grace
guarantee। এই ম্যাপিং একটা explicit ডিজাইন সিদ্ধান্ত, চুপচাপ ধরে নেওয়া না —
উপরে code comment-এও লেখা আছে।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/jwt-keys.ts` | নতুন exports: `JwtKeyLifecycleStatus`, `canSign()`, `canVerify()`। `fetchDbVerificationKeys()`-এর SQL এখন `VERIFY_ELIGIBLE_STATUSES` (derived from `canVerify()`) দিয়ে বানানো — hand-written `IN (...)` literal সরানো হলো। `mergeVerificationKeys()`-এর filter এখন `canVerify()` কল করে, আগের hand-written check-এর বদলে; merge-এর শেষে `warnIfMultipleActive()` কল যোগ হলো। `JwtKeyStatus`, `VerificationKey`, `getVerificationKeys()`, `resolveVerificationKeys()`, `getActiveKeypair()` — সবগুলোর public signature/behavior অপরিবর্তিত। |
| `scripts/src/test-key-lifecycle.ts` | **নতুন ফাইল** — `canSign()`/`canVerify()`-এর জন্য সরাসরি assertion, প্লাস `mergeVerificationKeys()` এখনো `canVerify()`-এর সাথে agree করে কিনা তার regression check (drift-scenario সহ)। |
| `scripts/package.json` | নতুন script: `pnpm --filter @workspace/scripts jwt:test-key-lifecycle` |

`lib/jwt.ts` টাচ করা হয়নি এই ফেজে — এটা শুধু `resolveVerificationKeys()`
(1D-b) কল করে, যেটা অপরিবর্তিত। `routes/auth.ts`, `lib/auth-utils.ts`,
`lib/vault-backup-cloud.ts` — এরা কেউ `jwt-keys.ts` সরাসরি import করে না।

## যা টেস্ট করা হয়েছে
- **Logic tests (পাশ)**: নতুন `canSign()`/`canVerify()`/আপডেট করা
  `mergeVerificationKeys()`-এর হুবহু body একটা dependency-free `.mjs`
  ফাইলে বসিয়ে plain `node`-এ চালানো হয়েছে (এই sandbox-এ `node_modules`
  নেই, network off, তাই আসল `tsx` চালিয়ে `@workspace/db`/`./logger`
  resolve করা যায়নি — Phase 1D-a/1D-b-এও একই সীমাবদ্ধতা ছিল) — ১০টা
  কেসই পাশ করেছে:
  1. শুধু `"active"` সাইন করতে পারে।
  2. `canSign()` সব known status-এর উপর total (boolean রিটার্ন করে)।
  3. `"active"` আর `"retiring"` verify করতে পারে, `"retired"` পারে না।
  4. সাইন করতে পারা মানেই verify করতে পারা (subset guarantee)।
  5. `canVerify()`-ও total।
  6. `VERIFY_ELIGIBLE_STATUSES` ঠিক `canVerify()`-এর সাথে মেলে।
  7. একটা `"retiring"` DB key — grace period — এখনও merge-এ verify-able
     হিসেবে থাকে।
  8. একটা `"retired"` DB key কখনোই merge result-এ আসে না।
  9. DB-এর active row-এর `kid` env keypair-এর `kid`-এর সাথে মিললে merge-এর
     পর ঠিক একটাই `active` key থাকে (steady-state, Phase 1D-d-এর পর যেমনটা
     হওয়ার কথা)।
  10. DB-এর active row আলাদা `kid`-এর হলে (আজকের বাস্তবতা — 1C-এর কোনো
      write path নেই) merge-এ দুইটা `active` key চলে আসে —
      `warnIfMultipleActive()` ঠিক এই কেসটাই ধরার জন্য।
  `scripts/src/test-key-lifecycle.ts` একই কেসগুলো (real import সহ, node
  dependency-free নয়) আসল export থেকে চালানোর জন্য repo-তে রাখা হয়েছে
  (`npx tsx scripts/src/test-key-lifecycle.ts` অথবা
  `pnpm --filter @workspace/scripts jwt:test-key-lifecycle`) — dev
  environment-এ node_modules থাকলে সরাসরি চলবে, এখানে চালিয়ে verify করা
  যায়নি।
- `tsc --noEmit --skipLibCheck` (isolated temp dir-এ, tsconfig ছাড়া) দিয়ে
  `jwt-keys.ts`, `jwt.ts`, `test-key-lifecycle.ts` — সবগুলো standalone চেক
  করা হয়েছে — শুধু প্রত্যাশিত noise (missing `@types/node`,
  `@workspace/db`, `jsonwebtoken`, `./logger` type declarations —
  dependencies ইনস্টল করা নেই বলে, আগের ফেজগুলোতেও একই situation ছিল),
  নতুন কোডে কোনো actual syntax/logic error পাওয়া যায়নি।
- Import graph গ্রেপ করে দেখা হয়েছে — `jwt-keys.ts`-এর নতুন exports
  (`canSign`, `canVerify`, `JwtKeyLifecycleStatus`) এই ফেজের আগে কোথাও
  ব্যবহার হতো না (নতুন), আর পুরনো exports (`JwtKeyStatus`,
  `VerificationKey`, `getVerificationKeys`, `resolveVerificationKeys`,
  `getActiveKeypair`) যেসব ফাইল import করে (`jwt.ts` একমাত্র সরাসরি
  importer) — তাদের কেউই এই ফেজের কোনো পরিবর্তনে touch হয়নি।

## জানা limitation
- `warnIfMultipleActive()`-এর log output সরাসরি test করা হয়নি (logger
  mock করা লাগত, যেটা এই sub-phase-এর scope-এর বাইরে) — শুধু এটা যে কেসে
  ট্রিগার হওয়ার কথা (২টা active key merge-এ) সেটা assert করা হয়েছে, log
  call-টা নিজে না।
- `canSign()` আজকে কোনো live decision-এ ব্যবহার হয় না (কারণ signing এখনো
  `jwt_signing_keys` পড়েই না) — এটার আসল ব্যবহার Phase 1D-d rotation write
  path শুরু হলে verify করা যাবে।

## পরের ধাপ (Phase 1D-d)
- Rotation trigger/service/script — নতুন key generate/load করে নতুন `kid`
  assign করে active-এ promote করা, আগের active key-কে
  retiring/verification-only state-এ move করা। এখন যেহেতু `canSign()`
  আগে থেকেই আছে, rotation-এর "promote to active" ধাপ সরাসরি সেটা কল
  করতে পারবে rule পুনরায় না লিখেই।
