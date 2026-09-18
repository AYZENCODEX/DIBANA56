# AYZEN Account System — SSO সেশন ম্যানেজমেন্ট + Account Switcher

## যা আগে থেকেই ছিল
- Mail, Vault, Finance, Marketplace — সবই একই React SPA-এর ভেতরের route।
- একবার login করলেই একটাই JWT token সব module-এ কাজ করে (single sign-on ইতিমধ্যেই সত্য)।
- Email/password, magic link, OTP, TOTP 2FA, passkey, step-up MFA — সব আগে থেকেই ছিল।

## যেটা অনুপস্থিত ছিল (এবার যোগ করা হলো)
সেই shared session-টা **দেখা বা নিয়ন্ত্রণ করার কোনো উপায় ছিল না**। JWT-টা ছিল একটা bare bearer token —
কোনো নির্দিষ্ট device/session revoke করা যেত না, password পাল্টানো ছাড়া। Google Account-এর
"Manage your devices" পেজের মতো কিছু ছিল না।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/index.ts` | নতুন `user_sessions` টেবিল migration |
| `artifacts/api-server/src/lib/jwt.ts` | JWT-তে `sid` (session id) claim যোগ |
| `artifacts/api-server/src/lib/sessions.ts` | **নতুন ফাইল** — create/list/touch/revoke session |
| `artifacts/api-server/src/lib/auth-utils.ts` | প্রতি request-এ session revoke-চেক |
| `artifacts/api-server/src/routes/auth.ts` | সব login flow session-bound টোকেন ইস্যু করে + নতুন endpoints:<br>`GET /api/auth/sessions`<br>`POST /api/auth/sessions/:id/revoke`<br>`POST /api/auth/sessions/revoke-others` |

Password reset হলে এখন **automatically** বাকি সব session sign out হয়ে যায় (security best practice, Google/GitHub-ও এভাবে করে)।

### Frontend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/ayzen/src/pages/user/security.tsx` | নতুন **"Sessions & Devices"** ট্যাব — active session list, per-device sign-out, "sign out of all other sessions" বাটন |
| `artifacts/ayzen/src/hooks/use-auth.tsx` | Multi-account সাপোর্ট: `accounts`, `switchAccount()`, `removeAccount()` |
| `artifacts/ayzen/src/pages/login.tsx` | Google-স্টাইল **"Choose an account"** স্ক্রিন — সেভ করা account-এ ক্লিক করলে password ছাড়াই সাথে সাথে switch হয়ে যায় |
| `artifacts/ayzen/src/components/layout/app-sidebar.tsx` | Sidebar-এর প্রোফাইল মেনুতে quick account-switcher যোগ |

## কীভাবে কাজ করে (security মডেল)
- প্রতিটা login-এ একটা `user_sessions` row তৈরি হয় + JWT-তে সেই row-এর id (`sid`) embed হয়।
- প্রতি authenticated request-এ সেই `sid` চেক হয় — revoked/expired হলে request 401 পাবে, JWT signature ভ্যালিড থাকলেও।
- পুরনো টোকেন (এই ফিচার আসার আগে ইস্যু করা) — এদের কোনো `sid` নেই, তাই ওরা আগের মতোই কাজ করে যতক্ষণ না স্বাভাবিকভাবে expire হয় (৭ দিন)।
- Account switcher-এ একাধিক account-এর token browser-এর `localStorage`-এ থাকে (ঠিক Google-এর মতোই একসাথে একাধিক account সাইন-ইন থাকে) — কিন্তু server-side validity-ই আসল সত্য, তাই কোনো নতুন trust boundary তৈরি হয়নি।

## যা টেস্ট করা হয়েছে
- সব edited ফাইল bracket/paren balance-চেক করা হয়েছে।
- `tsc --noEmit` দিয়ে syntax/type-চেক করা হয়েছে (node_modules না থাকায় শুধু "cannot find module" জাতীয় প্রত্যাশিত noise এসেছে, কোনো actual syntax/logic error পাওয়া যায়নি)।
- Runtime/DB-লেভেল টেস্ট করা যায়নি (network/DB access নেই এই sandbox-এ) — deploy করার পর migration ঠিকমতো চলছে কিনা এবং `/api/auth/sessions` response verify করে নেওয়ার পরামর্শ থাকলো।
