# Route Integration Roadmap — Season A, Phase A2: RBAC-PEP Shim

## যা আগে থেকেই ছিল
- `requireAdmin`/`requireDev`/`requireRoles(...roles)` — প্রতিটাই নিজের হাতে-লেখা
  `if (user.role !== ...)` চেক করত, ভুল হলে নিজের একটা ad hoc 403 বডি বানাত।
  কোনো `Decision`, কোনো reason code, কোনো audit trail — PDP-র কিছুই এই পথে
  involve হতো না।
- Policy Engine-এর PEP toolkit (`lib/policy/pep/middleware.ts`) আগে থেকেই
  `requireRole(roles, options)` বানিয়ে রেখেছিল ঠিক এই কাজের জন্যেই — role-
  membership কে সরাসরি PDP-র মধ্য দিয়ে চালানো — কিন্তু `middlewares/auth.ts`
  কখনো সেটা use করেনি (file header নিজেই এটা note করে রেখেছিল)।

## যেটা যোগ করা হলো (Phase A2)
`requireAdmin`/`requireDev`/`requireRoles()`-এর ভেতরের হাতে-লেখা role-check
সরিয়ে `requireRole()` (PDP-backed) দিয়ে replace করা হলো — **বাইরের behavior
এক বিন্দুও না বদলে**।

### কীভাবে exact response shape রাখা হলো
`requireRole()`-এর নিজের default DENY rendering ব্যবহার না করে, প্রতিটা
function তার নিজস্ব `onDeny` callback পাস করে — যেটা ঠিক আগের মতোই
`{ error: "Forbidden", code: "NOT_ADMIN"/"NOT_DEV"/"NOT_ALLOWED", solution: "..." }`
বডি বানায়। মানে: **decision-making** এখন PDP করে, কিন্তু **response rendering**
ঠিক আগের মতোই — কোনো frontend/API consumer-এর `response.code === "NOT_ADMIN"`
চেক ভাঙবে না।

`req.user` এখন role-check চালানোর **আগে** set করা হয় (আগে চেক-পাশ হওয়ার পরে
সেট হতো) — কারণ PEP-র `authorize()` সরাসরি `req.user` পড়ে Subject বানায়।
DENY হলে সাথে সাথে response পাঠিয়ে return করে দেওয়া হয় (next() কল হয় না),
তাই কোনো downstream handler কখনো "সাময়িকভাবে সেট হওয়া" `req.user` দেখে না।

### `authType: "oidc"` PDP-তে হারিয়ে যাচ্ছিল — সেটাও ঠিক করা হলো
Phase A1-এ `getUserFromToken()` নতুন `authType: "oidc"` রিটার্ন করা শুরু
করেছিল, কিন্তু PDP-র নিজের `SubjectAuthType` union আর `subjectFromAuthUser()`-এর
`VALID_AUTH_TYPES` set শুধু `"session"|"apikey"|"legacy"` চিনত — একটা
OIDC-authenticated request PDP-তে ঢুকলে নিঃশব্দে `"session"` হয়ে যেত (ভুল
আচরণ না, কিন্তু ভুল তথ্য — কোনো ভবিষ্যৎ authType-aware rule OIDC vs session
আলাদা করতে পারত না)। যেহেতু এই ফেজই প্রথম real traffic PDP-তে পাঠাচ্ছে,
`"oidc"`-কে দুই জায়গাতেই (`SubjectAuthType`, `VALID_AUTH_TYPES`) যোগ করে দেওয়া
হলো — এখন role অপরিবর্তিত থাকে, শুধু `authType` সঠিকভাবে carry হয়।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/middlewares/auth.ts` | `requireAdmin`/`requireDev`/`requireRoles()` — ভেতরের role-check `pepRequireRole()`-এ (PDP-backed) সরানো, `onDeny` দিয়ে exact আগের response shape রাখা; `req.user` role-check-এর আগে set; module-load-এ একবার বানানো `adminRoleCheck`/`devRoleCheck` (fixed role set) — per-request নতুন engine বানানো হয় না; `requireAuth`/`requireSessionAuth` **অপরিবর্তিত** (কোনো RBAC decision নেই, তাই shim করার কিছু নেই) |
| `artifacts/api-server/src/lib/policy/types.ts` | `SubjectAuthType` union-এ `"oidc"` যোগ |
| `artifacts/api-server/src/lib/policy/pip/subject-adapter.ts` | `VALID_AUTH_TYPES` set-এ `"oidc"` যোগ — Phase A1-এর নতুন authType এখন PDP-তে সঠিকভাবে পৌঁছায়, `"session"`-এ silently normalize হয় না |

**কোনো route file touch করা হয়নি** — 106টা legacy route যেভাবে `requireAdmin`/
`requireRoles(...)` import করত, ঠিক সেভাবেই import করে; শুধু এখন সেই কল
ভেতরে ভেতরে PDP-র মধ্য দিয়ে যায়।

## এখনো যা যোগ হয়নি (ইচ্ছাকৃতভাবে, পরের ফেজ)
- **Phase A3 (telemetry hookup)** — `adminRoleCheck`/`devRoleCheck`-এর
  `PolicyEngine`-এ কোনো `onDecision` audit hook attach করা হয়নি এখনো, তাই এই
  নতুন PDP-routed decision-গুলো এখনো `admin-policy-console`/
  `authorization-telemetry`-তে দেখা যাবে না। এই ফেজের লক্ষ্য ছিল শুধু
  decision-making সরানো, observability যোগ করা না — সেটা A3-এর কাজ।
- Season B/C-এর ownership/step-up upgrade এখনো শুরু হয়নি।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Backward-compatible: প্রতিটা
existing legacy route-এর জন্য response শেষ পর্যন্ত অপরিবর্তিত (same status
code, same body shape) — শুধু ভেতরে PDP জড়িত হলো।

## যা টেস্ট করা হয়েছে
- তিনটা edited ফাইলের bracket/brace balance চেক করা হয়েছে।
- `requireRole` সত্যিই `lib/policy/pep/middleware.ts`-এ named export হিসেবে
  আছে কিনা, আর সিগনেচার (`roles: readonly string[], options: PepMiddlewareOptions`)
  আমাদের কলের সাথে মেলে কিনা grep করে confirm করা হয়েছে।
- `lib/policy/**`-এর কোনো ফাইল `middlewares/auth.ts` import করে কিনা grep করে
  circular-import risk বাতিল করা হয়েছে (শুধু comment-এ reference আছে,
  কোনো `import` statement নেই)।
- পুরো workspace-এর উপর একটা সংশোধনকৃত (project root-এ বসানো, তাই `include`
  ঠিকমতো resolve হওয়া) `tsc --noEmit --skipLibCheck` চালানো হয়েছে — ৪০৫টা
  ফাইল আসলে check হয়েছে তা `--listFiles` দিয়ে যাচাই করা হয়েছে। `node_modules`
  ইনস্টল না থাকায় প্রতিটা ফাইলেই missing-module/missing-type noise আসে
  (আগের phase-গুলোর CHANGES doc-এও একই expected limitation লেখা আছে) —
  এই তিনটা edited ফাইলে সেই noise ছাড়া আর কোনো error আসেনি।
- `requireRole()`-এর `onDeny` callback-এ ৪-প্যারামিটার টাইপের জায়গায়
  ২-প্যারামিটার ফাংশন পাস করা structurally sound কিনা (TypeScript-এ কম
  প্যারামিটারের ফাংশন বেশি-প্যারামিটার-প্রত্যাশী টাইপে assignable) — এটা
  আলাদাভাবে reasoning করে confirm করা হয়েছে, কারণ pnpm workspace install
  ছাড়া পুরো call graph-এর উপর ১০০% নিশ্চিত একটা live type-check চালানো যায়নি।
