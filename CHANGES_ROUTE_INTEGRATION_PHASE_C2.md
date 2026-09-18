# Route Integration Roadmap — Season C, Phase C2: Mechanical Sweep (batch 2)

## যা আগে থেকেই ছিল
Phase C1 (batch 1) `support.ts`/`tasks.ts`-এর "owner, OR admin" shape-এর
৫টা hand-rolled check-কে PDP-routed করেছিল, আর নিজের "এখনো যা বাকি" অংশে
পরের batch-এর জন্য `passkey.ts`/`vault-reauth.ts`-কে চিহ্নিত করেছিল —
"credential/challenge ownership... কোনো admin-bypass নেই, শুধু strict
ownership... সম্ভবত `requireOwnership()` সরাসরি ফিট করবে"। এই ফেজ (batch 2)
সেই দুটো ফাইল করল।

`support.ts`/`tasks.ts`-এর মতো grep পুনরায় চালানো হলো (`userId !== `/
`!== .*userId`) দুটো ফাইলে। ফলাফল প্রত্যাশার চেয়ে একটু বেশি সূক্ষ্ম:

- **`routes/passkey.ts`** — গ্রেপ-এ **দুটো** hit: `POST
  /passkey/register/verify`-এর challenge-ownership check (`entry.userId
  !== userId`), আর `POST /passkey/login/verify`-এর challenge-ownership
  check (`challenge.userId !== user.id`)। এছাড়া `PATCH`/`DELETE
  /passkey/:id`-এর নিজস্ব ownership check grep-এ ধরা পড়েনি — ওগুলো
  `finance.ts`-এর মতো SQL-এ combined (`where(and(eq(id), eq(userId)))`),
  `!==` শেপ না। কিন্তু C1-এর নিজের ভাষা ("credential ... ownership") স্পষ্টতই
  এই দুটোকেও বোঝাচ্ছিল, তাই এই ফেজে সেগুলোও কভার করা হলো।
- **`routes/vault-reauth.ts`** — একটা hit: `POST
  /vault/reauth/passkey/verify`-এর `cred.userId !== userId`।

## যেটা যোগ করা হলো (Phase C2)

### `routes/passkey.ts`-এর `POST /passkey/login/verify`-এর hit — **out of scope, false positive** (C1-এর `events.ts`-এর মতো)
এই route-এর কোনো `requireAuth` নেই — এই route-টাই হলো session তৈরির
উপায় (passkey verify করেই session আসে)। ওই পয়েন্টে `req.user` সেট নেই,
তাই `authorize()`-এর কোনো real PDP subject বানানোর উপায় নেই
(`subjectFromAuthUser(null)` → null subject → `PolicyEngine`-এর
`UNAUTHENTICATED` early-deny — একজন legit owner-ও deny হয়ে যেত)। PDP-তে
পাঠানো মানে হয় প্রতিটা legit login deny করা, নয়তো একটা fake subject বানানো
— কোনোটাই এই ফেজের কাজ না। C1-এর `events.ts` ঠিক এই একই কারণে ("presence
broadcast, কোনো authz check না") untouched রাখা হয়েছিল — এখানে কারণটা
ভিন্ন (subject না থাকা, বনাম আদৌ কোনো authz প্রশ্নই না থাকা) কিন্তু
সিদ্ধান্ত একই: touch করা হয়নি, শুধু কোড-এ একটা comment যোগ হলো ব্যাখ্যা
করে কেন।

### বাকি তিনটা check — সবগুলোই strict ownership, কোনো role-override লাগেনি
`support.ts`/`tasks.ts` (Phase C1)-এর বিপরীতে, এই ব্যাচের প্রতিটা check-ই
"owner, full stop" — কোনো admin bypass নেই (একটা passkey credential বা
registration challenge ঠিক একটাই account-এর, কখনো অন্য কারো role যাই হোক না
কেন তার access নেই)। তাই `createResourceOwnershipRule()` একাই যথেষ্ট —
Phase C1-এর নতুন `createRoleOverrideRule()` এখানে দরকার হয়নি, register করা
হয়নি।

| ফাইল | Route | নতুন `action` | Response gate (অপরিবর্তিত) |
|---|---|---|---|
| `passkey.ts` | `POST /passkey/register/verify` | `passkey.register_challenge.verify` | `400 { error: "Challenge expired or invalid. Try again." }` |
| `passkey.ts` | `PATCH /passkey/:id` | `passkey.credential.update` | `404 { error: "Passkey not found" }` |
| `passkey.ts` | `DELETE /passkey/:id` | `passkey.credential.delete` | `404 { error: "Passkey not found" }` |
| `vault-reauth.ts` | `POST /vault/reauth/passkey/verify` | `vault.reauth.passkey_verify` | `401 { error: "This passkey does not belong to your account" }` |

### `requireOwnership()` মিডলওয়্যার না, **inline `authorize()`** — কেন C1-এর মতোই
Phase C1-এর নিজের যুক্তি অনুযায়ী প্রত্যাশা ছিল `requireOwnership()`
(route-level middleware, Phase B1-এর মতো) "সরাসরি ফিট করবে"। কোড দেখার পর
সেটা সঠিক হয়নি, ঠিক C1-এর নিজের `support.ts`/`tasks.ts`-এর মতো কারণেই:

- **`PATCH /passkey/:id`** — handler-এর ভেতরে ownership নির্ধারণের **আগেই**
  একটা হাতে-লেখা validation চলে (`name` required, ৪০০)। `requireOwnership()`
  route-level middleware হিসেবে বসালে সেটা এই validation-এরও আগে চলত —
  ফলে একজন non-owner খালি `name` দিয়ে PATCH করলে আগে যেখানে `400 "name is
  required"` পেত, এখন `404 "Passkey not found"` পেত। এই ফেজ সেই ordering
  বদলাতে রাজি না (Rule: exact behavior preserve)।
- **`DELETE /passkey/:id`** — একইভাবে, `requireVaultPin()` চেক ownership
  নির্ধারণের আগে চলে। Middleware বসালে PIN-check-এর আগেই ownership decide
  হয়ে যেত, একই ordering সমস্যা।
- **`vault-reauth.ts`-এর `passkey/verify`** — এখানে middleware-এর জন্য কোনো
  ordering সমস্যা নেই ঠিক, কিন্তু handler নিজেই আগে থেকেই credential row-টা
  fetch করে (WebAuthn verification-এর জন্য পরে লাগবে) — একটা
  `ResourceRefBuilder`-ভিত্তিক middleware সেই একই row আবার আলাদা করে fetch
  করত। ইতিমধ্যে-fetch-করা `cred` variable-টাই reuse করা হলো।

তাই সবক'টাতেই `authorize()` (mid-handler primitive, `lib/policy/pep/authorize.ts`
— এর নিজের হেডার একেই "a conditional check that shouldn't gate the whole
route" বলে documented করে রেখেছে) ব্যবহার করা হলো, ঠিক যেখানে ownership
determination আগে হতো সেই একই জায়গায়, ordering-টা byte-for-byte অক্ষত রেখে।

### Resource lookup — DB থেকে আসল owner, sentinel trick (Phase B1-এর মতোই)
`PATCH`/`DELETE /passkey/:id` প্রতিটাই ownership check-এর আগে একটা হালকা
`SELECT { userId } FROM passkey_credentials WHERE id = :id` চালায় — client-
supplied কিছু trust করা হয়নি। `id`-টা আদৌ কোনো credential-এর না হলে
`PASSKEY_OWNER_SENTINEL_NONE` (`-1`) বসে, ownership rule সেটার সাথে কোনো
real `subject.userId` মেলাতে পারে না (abstain) → default-deny → এখনো একই
`404 "Passkey not found"` — একটা 500 না, ঠিক `finance.ts`-এর
`FINANCE_OWNER_SENTINEL_NONE`-এর মতোই।

`vault-reauth.ts`-এ আলাদা কোনো নতুন SELECT লাগেনি — হ্যান্ডলার নিজেই আগে
থেকে `cred` fetch করত, সেটাই resource ref-এ পাস করা হলো
(`VAULT_REAUTH_OWNER_SENTINEL_NONE = -1` ব্যবহার হয় শুধু `cred` না-থাকা
কেসে)। `cred` সরাসরি ব্যবহার করার ফলে এরপরের কোডে (WebAuthn verification)
TypeScript-এর জন্য `cred` non-null narrow করতে একটা defensive
`if (!cred) { ... return; }` (runtime-এ কখনো true হয় না — sentinel ownerId
কখনো ALLOW পায় না) `ownership-rule.ts`-এর নিজের "Defensive only" null-
subject check-এর মতো একই posture-এ যোগ করা হয়েছে।

`passkey.ts`-এর register/verify-তে কোনো নতুন DB read লাগেনি — challenge-টা
in-memory (`consumeChallenge()`), সেটার `entry.userId`-ই resource ref-এ
পাস করা হলো (`entry` না থাকলে সেটা আগেই আলাদাভাবে ৪০০ রিটার্ন করে, যেটা
existence-এর প্রশ্ন, ownership-এর না — সেটা অপরিবর্তিত রাখা হয়েছে, ঠিক C1-এর
"record না পেলে 404" নীতির মতোই)।

### একটাই engine per file, module-load-time
`passkeyOwnershipEngine` (`passkey.ts`-এর তিনটা check শেয়ার করে) আর
`vaultReauthOwnershipEngine` (`vault-reauth.ts`-এর একটা check) — দুটোই
module load-এ একবার বানানো (cheap, stateless), দুটোই `pepDecisionObserver`
(Phase A3) দিয়ে wired — মানে এই ৪টা decision এখন প্রথমবারের মতো
`authorization_audit_log`-এ row হয় আর `authorization-telemetry`-তে গণনা
হয়।

## Backend

| ফাইল | পরিবর্তন |
|---|---|
| `routes/passkey.ts` | `pepDecisionObserver` import (`../middlewares/auth`); `PolicyEngine`/`createResourceOwnershipRule`/`authorize` import; module-level `PASSKEY_OWNER_SENTINEL_NONE`, `passkeyOwnershipEngine`; `POST /passkey/register/verify`-এর challenge ownership check `authorize()` কলে বদলানো; `PATCH`/`DELETE /passkey/:id`-এ একটা নতুন resource-lookup SELECT + `authorize()` কল যোগ (existing combined-where update/delete অপরিবর্তিত); `POST /passkey/login/verify`-এর challenge ownership check-এ একটা comment যোগ (কেন out-of-scope) — কোড অপরিবর্তিত। |
| `routes/vault-reauth.ts` | `pepDecisionObserver` import; `PolicyEngine`/`createResourceOwnershipRule`/`authorize` import; module-level `VAULT_REAUTH_OWNER_SENTINEL_NONE`, `vaultReauthOwnershipEngine`; `POST /vault/reauth/passkey/verify`-এর `cred.userId !== userId` check `authorize()` কলে বদলানো (already-fetched `cred` reuse করে), + একটা defensive `!cred` narrow guard। |

## এই ফেজে যা সরানো হয়নি
- `PATCH`/`DELETE /passkey/:id`-এর existing combined-where
  (`eq(id) AND eq(userId)`) update/delete queries — এখনো আছে, এখনো
  আসল enforcement, নতুন `authorize()` কল একটা দ্বিতীয়, পর্যবেক্ষণযোগ্য
  স্তর, replace না।
- `POST /passkey/login/verify`-এর `challenge.userId !== user.id` check —
  hand-rolled-ই থাকল, উপরে ব্যাখ্যা করা কারণে।

## এখনো যা বাকি (Season C-এর পরের batch-গুলোর কাজ)
- `finance-invoices.ts` (988 লাইন), `teams.ts` (1557 লাইন) — বড়, নিজের
  batch প্রাপ্য, এই ফেজে touch করা হয়নি (Phase C1-এই বাদ দেওয়া হয়েছিল)।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE/neutral —
প্রতিটা route-এর জন্য response শেষ পর্যন্ত অপরিবর্তিত (same status code,
same body, same owner-only logic), শুধু ভেতরে এখন PDP জড়িত।

## যা টেস্ট করা হয়েছে
- এডিট করা দুটো route ফাইলের bracket/brace/paren balance স্ক্রিপ্ট দিয়ে
  চেক করা হয়েছে — সব শূন্যে মেলে।
- `tsc --noEmit --skipLibCheck --ignoreConfig` দুটো ফাইলের উপর চালানো
  হয়েছে — বাকি থাকা প্রতিটা error module-resolution-জনিত (`express`/
  `@workspace/db`/`drizzle-orm`/ইত্যাদি, node_modules install না থাকায়)
  অথবা pre-existing implicit-any, ঠিক আগের ফেজগুলোর মতোই বেসলাইন noise।
  নতুন যোগ করা কোনো identifier (`passkeyOwnershipEngine`,
  `vaultReauthOwnershipEngine`, `PASSKEY_OWNER_SENTINEL_NONE`,
  `VAULT_REAUTH_OWNER_SENTINEL_NONE`, `createResourceOwnershipRule`,
  `authorize`, `PolicyEngine`, `pepDecisionObserver`) নিয়ে কোনো error
  ওঠেনি — grep করে আলাদাভাবে যাচাই করা হয়েছে।
- প্রতিটা import সোর্স ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান কিনা grep
  করে যাচাই করা হয়েছে (`createResourceOwnershipRule` →
  `lib/policy/resource/ownership-rule.ts`, `PolicyEngine` →
  `lib/policy/policy-engine.ts`, `authorize` →
  `lib/policy/pep/authorize.ts`, `pepDecisionObserver` →
  `middlewares/auth.ts`)।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ:
  owner → ownership rule ALLOW → আগের success path (আগের মতোই)। non-owner
  বা নাই-এমন id/credential → ownership rule abstain (sentinel বা real
  mismatch) → default-deny (`NO_MATCHING_POLICY`) → আগের একই error status/
  body (আগের মতোই)। `PATCH`/`DELETE /passkey/:id`-এ নাম-validation/PIN-check
  এখনো ownership check-এর আগে চলে, ordering অপরিবর্তিত।
