# OIDC Roadmap — Season 3, Phase 6e-c: Failure Handling

Phase 6e-a-এর নিজের কথায়: *"Deliberately has no `attempt`/`retryAfter`-style
fields yet — that's 6e-c's own shape to add, not speculated here."*
Phase 6e-b-এর নিজের কথায়: *"Retry/backoff policy is explicitly 6e-c's own
scope, not speculated in this function."* এই পাস ঠিক সেই reserved scope —
roadmap-এর নিজের ভাষায়: **"Define safe behavior when propagation fails."**

## যা যোগ/পরিবর্তন করা হলো

| ফাইল | পরিবর্তন |
|---|---|
| `migrations/087_ayzen_oidc_backchannel_logout_queue.sql` | **নতুন** — `ayzen_oidc_backchannel_logout_queue` টেবিল (durable retry queue) |
| `artifacts/api-server/src/lib/oidc-logout-propagation.ts` | **আপডেট** — 6e-b-এর উপর appended: `enqueueBackchannelLogoutRetry()`, `nextBackchannelLogoutRetryDelayMs()` (pure backoff), `claimNextBackchannelLogoutBatch()`, `processBackchannelLogoutQueueRow()`, `runBackchannelLogoutQueueSweep()`, stale-lock/startup recovery, `startBackchannelLogoutQueueWorker()`; `dispatchBackchannelLogoutForUser()`-এর দুটো failure branch-ই এখন শুধু log করার বদলে `enqueueBackchannelLogoutRetry()` কল করে |
| `artifacts/api-server/src/index.ts` | নতুন `startBackchannelLogoutQueueWorker()` import + startup sequence-এ `startSendQueueWorker()`-এর ঠিক পাশে কল |
| `scripts/src/test-oidc-backchannel-logout-queue.ts` | **নতুন** — `nextBackchannelLogoutRetryDelayMs()`-এর pure backoff-curve টেস্ট |

## ডিজাইন — কেন এই শেপ

- **নতুন retry convention না, বিদ্যমানটাই আবার ব্যবহার করা হলো।** এই
  codebase-এর নিজস্ব একটাই durable-retry-queue প্যাটার্ন আছে —
  `lib/mail-send-queue.ts` (migrations 047/048): durable table + `FOR
  UPDATE SKIP LOCKED` claim + exponential backoff w/ jitter +
  stale-lock/startup crash recovery + give-up-after-N-attempts। এই পাস
  ঠিক সেই শেপ Back-Channel Logout-এর জন্য পুনরায় প্রয়োগ করেছে, দ্বিতীয়
  কোনো retry দর্শন উদ্ভাবন না করে।
- **নতুন আলাদা ফাইল না, `oidc-logout-propagation.ts`-এই appended।** 6e-a
  আর 6e-b দুটোই এই একই ফাইলে appended হয়েছিল (নতুন ফাইল না বানিয়ে)। 6e-c-ও
  একই কনভেনশন মেনেছে — আলাদা ফাইলে queue লজিক রাখলে
  `deliverBackchannelLogoutOverHttp`/`issueOidcLogoutToken` re-export করতে
  গিয়ে দুই ফাইলের মধ্যে circular import তৈরি হতো (queue ফাইল
  send-logic থেকে import করে, আবার `dispatchBackchannelLogoutForUser()`-কে
  queue ফাইল থেকে enqueue কল করতে হতো)। এক ফাইলে রাখায় সেই সমস্যা নেই।
- **প্রতিটা retry attempt-এ একটা ফ্রেশ Logout Token মিন্ট হয়, কোনো stored
  JWT replay হয় না।** `LOGOUT_TOKEN_TTL_SECONDS` মাত্র ২ মিনিট — একটা
  backoff-delayed retry মিনিট কয়েক পরে চললে stored token ততক্ষণে expire
  হয়ে যেত (receiving side `exp` enforce করে, 6e-b-এর নিজস্ব ডিজাইন
  সিদ্ধান্ত)। তাই queue টেবিল signed JWT না, retry-র জন্য দরকারি বাইন্ডিং
  (`user_id`, `client_id`, `backchannel_logout_uri`) রাখে; প্রতিটা attempt-এ
  `issueOidcLogoutToken()` নতুন করে কল হয়, ইনলাইন প্রথম attempt যেভাবে করে
  ঠিক সেভাবেই।
- **`attempts` শুরু হয় 1 দিয়ে, 0 না।** queue row-টার অস্তিত্বই একটা
  already-failed inline attempt-এর প্রমাণ, তাই `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS`
  (=5)-এর বিপরীতে গোনা `attempts` মান হিসেব ঠিক থাকে আলাদা কোনো
  "row বানানোর আগের attempts" tally ছাড়াই। ফলাফল: ১টা ইনলাইন attempt + ৪টা
  queued retry = মোট ৫টা attempt-এর পর dead-letter।
- **`backchannel_logout_uri` snapshot করা হয়, প্রতি retry-তে re-resolve না।**
  একটা queued row তার own retry history-জুড়ে একটাই টার্গেটের বিপরীতে
  চলে — মাঝপথে operator যদি client-এর URI rotate করে, পুরনো queued row-গুলো
  পুরনো URI-র বিপরীতেই শেষ হয় (বা dead-letter হয়), আর rotation-এর পরের নতুন
  logout event `resolveBackchannelLogoutTargets()`-এর সবসময় fresh lookup
  দিয়ে নতুন URI-ই পায়। প্রতি retry-তে re-resolve করলে আরেকটা সূক্ষ্ম কেস
  খুলে যেত: client যদি URI পুরোপুরি সরিয়ে ফেলে (`NULL` করে), তাহলে live
  re-lookup কিছুই পেত না, আর "এই attempt স্কিপ করো কিন্তু dead-letter-ও
  করো না" — এমন একটা তৃতীয় branch লাগত। fixed snapshot এই জটিলতা এড়ায়।
- **`dead_letter`, "retry forever" না।** একটা permanently-gone target
  (Sylo decommission হয়ে গেছে, বা URI rotate হয়েছে কিন্তু `oidc_clients`
  row আপডেট হয়নি) অন্যথায় অসীম সংখ্যক queue row জমাত।
  `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS` সেটা বাউন্ড করে — শেষ attempt ব্যর্থ
  হলে row `'dead_letter'`-এ যায় (`logger.error`/`logBus.error`-এ
  REQUIRES-ATTENTION হিসেবে লগ হয়), 6e-d-এর future dashboards/alerting এই
  status column-টাই key করবে।
- **`pool.connect()` + raw `BEGIN`/`COMMIT`, drizzle `db.transaction()` না।**
  এই ফাইল (আর `lib/oidc-clients.ts`, `lib/sessions.ts`) শুরু থেকেই raw
  `pool` ব্যবহার করে, কখনো drizzle `db` না — `claimNextBackchannelLogoutBatch()`
  সেই কনভেনশনই বজায় রেখেছে, `mail-send-queue.ts`-এর মতো drizzle-এর built-in
  transaction wrapper না পেয়েও একই guarantee (atomically claim, no
  double-claim across worker instances) দেয়।
- **`Date` object সরাসরি bind করা হয়, SQL-এ interval arithmetic না।**
  প্রথম খসড়ায় `now() + ($n || ' milliseconds')::interval` ব্যবহার করা
  হয়েছিল — সেটা কাজ করলেও অপ্রয়োজনীয়ভাবে জটিল। `mail-send-queue.ts`-এর
  নিজস্ব `enqueueSend()` যেভাবে করে (`new Date(Date.now() + delayMs)`
  JS-এ কম্পিউট করে সরাসরি bind করা) সেই একই, সরল কনভেনশনে ঠিক করা হয়েছে।
- **কোনো নতুন drizzle schema mirror যোগ করা হয়নি।** `user_sessions`
  (migration 086)-এর মতোই এই queue টেবিলের কোনো drizzle mirror নেই —
  একমাত্র consumer এই ফাইলের raw SQL, তাই আলাদা schema definition রাখলে
  শুধু দুই জায়গায় column list ম্যানুয়ালি sync রাখার বোঝা বাড়ত, বাস্তব কোনো
  সুবিধা ছাড়াই।
- **`user_id` FK `ON DELETE CASCADE`, `client_id`-এ কোনো FK না।** `user_id`
  `users(id)`-এর সাথে CASCADE — অ্যাকাউন্ট ডিলিট হয়ে গেলে সেই ইউজারের জন্য
  logout propagation retry করার কোনো মানে নেই। `client_id`-এ FK নেই — ঠিক
  migration 086-এর `origin_client_id`-এর মতোই যুক্তি: এটা একটা attempt-এর
  উপর historical tag, live join target না।

## যা ইচ্ছাকৃতভাবে এখানে নেই (পরবর্তী সাব-ফেজের কাজ)

- Dead-lettered row লিস্ট করা বা ম্যানুয়ালি replay করার কোনো admin
  UI/endpoint — 6e-c-এর নিজস্ব task list-এ ("define safe behavior when
  propagation fails") চাওয়া হয়নি, আর `mail-send-queue.ts`-এর dead-letter
  সমতুল্য (Drafts) যেভাবে ইউজারের আগে থেকেই থাকা একটা surface, এই queue-এর
  তেমন কোনো বিদ্যমান surface নেই যাতে piggyback করা যায়।
- `oidc.backchannel_logout.*`-এর জন্য structured metrics/dashboards/alerting
  (এই পাসে শুধু `logger`/`logBus` call যোগ হয়েছে, কোনো নতুন observability
  infrastructure না) — **6e-d (Monitoring)**।
- `dispatchBackchannelLogoutForUser()`-এর নিজস্ব userId-scoped,
  one-event-per-registered-client শেপ বা তিনটা call site-এর কোনো
  পরিবর্তন — এই পাস শুধু delivery attempt ব্যর্থ হওয়ার *পরে* কী হয় সেটা
  বদলেছে, কখন একটা attempt trigger হয় সেটা না।
- Full end-to-end verification (real login → real revoke → real ব্যর্থ
  delivery → real retry → real dead-letter, লাইভ DB-সহ) — **6e-e (E2E
  Logout Verification)**।

## টেস্ট

`scripts/src/test-oidc-backchannel-logout-queue.ts` কাভার করে (pure
function, কোনো live DB ছাড়াই): `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS`-এর মান,
`nextBackchannelLogoutRetryDelayMs()`-এর exponential curve (attempts
1..4-এর জন্য জিটার-সহ প্রত্যাশিত রেঞ্জ), negative/zero attempts-এর
defensive floor, বড় attempts-এর জন্য cap, আর monotonic non-decreasing
বৈশিষ্ট্য।

**DB-নির্ভর অংশ এই পাসে exercise করা হয়নি** — `enqueueBackchannelLogoutRetry()`,
`claimNextBackchannelLogoutBatch()`, `processBackchannelLogoutQueueRow()`,
`runBackchannelLogoutQueueSweep()`, আর দুটো recovery ফাংশন। এগুলো
`test-oidc-clients.ts`/6e-b-এর `test-oidc-backchannel-logout-receive.ts`-এর
নিজস্ব precedent অনুযায়ী লাইভ dev DB-এর বিপরীতে হাতে-verify করা দরকার —
migration 087 রান করার পর একটা লোকাল HTTP listener বানিয়ে (কয়েকবার fail
করে তারপর succeed করে) `runBackchannelLogoutQueueSweep()` বারবার কল করে
row-টার `status`/`attempts` progression `'delivered'`-এ শেষ হয় কিনা, আর
আলাদাভাবে `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS`-বার consecutive fail করিয়ে
`'dead_letter'`-এ শেষ হয় কিনা — দুটোই যাচাই করা উচিত।

**পরিবেশগত সীমাবদ্ধতা (এই পাসে):** এই sandbox-এ network/`pnpm install`
অ্যাক্সেস নেই, তাই কোনো টেস্ট স্ক্রিপ্ট (নতুন বা বিদ্যমান) বাস্তবে চালিয়ে
দেখা যায়নি এখানে — 6e-a/6e-b-এর নিজস্ব একই সীমাবদ্ধতা। বাস্তব dev
পরিবেশে `pnpm install`-এর পর `npx tsx scripts/src/test-oidc-backchannel-logout-queue.ts`
(এবং migration 087 Supabase SQL Editor-এ, migration 086-এর পরে) চালিয়ে
নিশ্চিত করা দরকার।

## পরবর্তী সাব-ফেজ

**6e-d — Monitoring**: `oidc.backchannel_logout.*`-এর জন্য structured
metrics/dashboards/alerting — বিশেষভাবে এই পাসের `'dead_letter'` status-কে
একটা actionable alert-এ পরিণত করা।
