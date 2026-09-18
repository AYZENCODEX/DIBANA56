# Route Integration Roadmap — Season C, Phase C32: Regression suite (manual → automated)

## এই ফেজের scope
C19A থেকে C31 পর্যন্ত প্রতিটা ফেজের QA ম্যানুয়াল ছিল — bracket-balance count,
grep দিয়ে wiring confirm, হাতে owner/non-owner/nonexistent-id verify করা।
এই ফেজে roadmap-এর নিজের বলা একই তিন case (owner → allow, non-owner →
configured deny, nonexistent id → same deny) একটা automated suite-এ কোড
করা হয়েছে, যাতে ভবিষ্যতে কোনো resource builder / action string / `onDeny`
body ভুলে বদলে গেলে CI-তেই ধরা পড়ে।

## নতুন ফাইল
- `scripts/src/lib/ownership-route-test-kit.ts` — জেনেরিক হারনেস: fake
  `req`/`res`/`next`, `db.select(...).limit(1)` (drizzle shape) ও
  `db.execute(sql\`...\`)` (raw-SQL shape, শুধু `kycEntryResource`) দুটোর
  জন্য আলাদা mock helper, আর `runOwnershipRouteSuite()` যেটা একটা route-spec
  নিয়ে তিনটা case-ই চালায়।
- `scripts/src/test-route-ownership-regression.ts` — ২৮টা route-এর spec
  টেবিল + runner। `package.json`-এ
  `route-integration:test-ownership-regression` script যোগ হয়েছে।

## Scope: কোন ২৮টা route কভার হয়েছে, কেন শুধু এই ২৮টা
পুরো `routes/` ট্রি-তে মাত্র দুইটা `ResourceRefBuilder` আছে যেগুলো exported
এবং একাধিক ফাইলে reuse হয় — `vaultEntryResource`
(`vault-entity-links.ts`) আর `kycEntryResource` (`kyc.ts`)। বাকি ৩০+
ফাইলের builder (`local-accounts.ts`, `two-factor.ts`, `security.ts`,
`teams.ts`, `finance.ts`-এর দুইটা, ইত্যাদি) file-local, unexported। এই
suite রিয়েল প্রোডাকশন `requireOwnership()` + রিয়েল exported builder
সরাসরি import করে চালায় (hand-rolled stand-in না), তাই শুধু ওই দুইটা
builder-এর ওপর নির্ভরশীল route-গুলোতেই পৌঁছাতে পারে:

| ফাইল | route সংখ্যা | builder |
|---|---|---|
| `vault.ts` | ১৪ (C30-এর ৩ core CRUD + C31-এর ১১ peripheral) | `vaultEntryResource` |
| `vault-entity-links.ts` | ১ (`GET /vault/:id/links`) | `vaultEntryResource` |
| `entities.ts` | ৫ | `vaultEntryResource` |
| `value-history.ts` | ৩ | `vaultEntryResource` |
| `kyc.ts` | ৪ | `kycEntryResource` |
| `exchange-api.ts` | ১ | `kycEntryResource` (reuse, C19B) |
| **মোট** | **২৮** | |

`vault-entity-links.ts`-এর বাকি দুইটা route (`vaultEntityLinkResource`-গেটেড)
এই ফেজের বাইরে — সেই builder file-local, unexported। বাকি ~৩০টা ফাইলের
locally-scoped builder-ও এই কারণেই বাইরে — এটাই এই ফেজের নিজের documented
follow-up (নিচে "যা বাকি" দেখুন)।

## সব spec আসল route source-এর সাথে line-by-line যাচাই করা হয়েছে
প্রতিটা route-এর action string ও deny body হাতে হাতে সোর্সের বিপরীতে
diff করে confirm করা হয়েছে (grep, verbatim):

- `vault.ts`-এর ১৪টা route-ই `requireVaultEntryOwnership(action, onDeny)`
  দিয়ে গেটেড, প্রতিটা action string ও deny body suite-এর টেবিলের সাথে
  হুবহু মেলে — `DELETE /vault/:id`-এর `message`-key deny (অন্য সবগুলো
  `error`-key) এবং `restore`/`purge`-এর `"Trashed vault entry not found"`
  body দুটোই pre-existing quirk হিসেবে অপরিবর্তিত রাখা হয়েছে, "normalize"
  করা হয়নি।
- `vault-entity-links.ts`-এর `GET /vault/:id/links` তার নিজের thin
  wrapper-এ fixed `{ error: "Vault entry not found" }`/404 ব্যবহার করে —
  মেলে।
- `entities.ts`-এর ৫টার মধ্যে `roi` read/update দুটো deliberately 403/
  `{ error: "Forbidden" }` (বাকি তিনটা 404) — এই pre-existing difference-ও
  পিন করে রাখা হয়েছে।
- `value-history.ts`-এর `GET /vault/:id/value-history` deny কখনো
  `.status()` call করে না — শুধু `res.json([])`, তাই Express default
  200 প্রযোজ্য — suite এটা 200/`[]` হিসেবে capture করে, 404 বলে "ঠিক" করে
  না।
- `kyc.ts`-এর ৪টা route real exported `requireKycEntryOwnership` দিয়ে
  সরাসরি চালানো হয়েছে (কোনো reconstruction লাগেনি) — `DELETE
  /kyc-entries/:id`-এর silent `{ success: true }`/200 no-op deny-ও
  অপরিবর্তিত পিন করা।
- `exchange-api.ts`-এর একমাত্র route একই `requireKycEntryOwnership`
  reuse করে (C19B) — সেই ফাইল নিজে import না করে (third-party exchange-
  integration dependency এড়াতে), শুধু action string + onDeny body
  verbatim কপি করে।

## Mock shape ভ্যারিফাই করা হয়েছে
`kycEntryResource` (`kyc.ts`) `db.execute(sql\`SELECT user_id FROM
kyc_entries ...\`)` দিয়ে raw SQL চালায়, রেজাল্ট `row.user_id`
(snake_case) — `RAW_SQL_USER_ID_ROW` mock এই শেপ-ই produce করে।
`vaultEntryResource` drizzle-এর `.select({ userId: ... }).from(...)
.where(...).limit(1)` ব্যবহার করে, রেজাল্ট `row.userId` (camelCase) —
`DRIZZLE_USER_ID_ROW` এই শেপ produce করে। দুটোই সোর্সের বিপরীতে line-by-
line confirm করা হয়েছে।

## Run
```
DATABASE_URL=postgres://test:test@localhost:5432/test \
VAULT_FIELD_ENCRYPTION_KEY=$(openssl rand -hex 32) \
npx tsx scripts/src/test-route-ownership-regression.ts
```
দুই env var-ই শুধু present/well-formed হলেই চলে, reachable হওয়ার দরকার
নেই — কোনো route handler কখনো invoke হয় না (শুধু ownership middleware),
আর resource builder-এর একমাত্র DB call ততক্ষণে mock দিয়ে প্রতিস্থাপিত।
`pg.Pool` কখনো construction-এ connect করে না, শুধু query চালানোর সময় —
আর সেই সময়ের আগেই mock বসে যায়।

## যাচাই (এই sandbox-এ যা করা সম্ভব হয়েছে)
- TypeScript AST parse (compiler API দিয়ে) — উভয় ফাইলে ০ syntax
  diagnostic।
- Bracket balance: উভয় ফাইলে `{}`/`()` সংখ্যা সমান।
- Spec count: টেবিলে ঠিক ২৮টা এন্ট্রি (১৪ vault + ১ links + ৫ entities +
  ৩ value-history + ৪ kyc + ১ exchange-api), উপরের scope টেবিলের সাথে মেলে।
- `package.json`-এ নতুন script যোগ হয়েছে, অন্য কোনো entry অপরিবর্তিত।
- এই sandbox-এ `node_modules`/network না থাকায় suite-টা আসলে চালিয়ে
  pass/fail কনফার্ম করা সম্ভব হয়নি — সেটা CI/লোকাল ডেভ এনভায়রনমেন্টে করতে
  হবে (উপরের run command দিয়ে)। কোড-লেভেলে যা verify করা যায় (action
  string, deny body, mock shape, import path) সবই আসল সোর্সের বিপরীতে
  হাতে diff করে মেলানো হয়েছে।

## যা বাকি (এই ফেজের নিজের documented follow-up, C33-এর সাথে natural pairing)
বাকি ~৩০টা route-ফাইলের locally-scoped builder (`localAccountResource`,
ইত্যাদি) এই suite-এর scope-এর বাইরে কারণ সেগুলো এখনো export হয়নি। প্রতিটার
জন্য: (১) builder export করা, (২) এই suite-এর টেবিলে এক লাইন যোগ করা —
এই দুই-ধাপ প্যাটার্নটা C33-এর pattern-doc-এই natural জায়গা (সেই ফেজ এমনিতেই
লিখবে কখন একটা builder export করা উচিত)।
