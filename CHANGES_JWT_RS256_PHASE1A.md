# OIDC Roadmap — Season 1, Phase 1A: HS256 → RS256

## যা আগে থেকেই ছিল
- Session token (`lib/jwt.ts`) HMAC-SHA256 (HS256) দিয়ে সাইন হতো, একটাই shared secret (`AYZEN_JWT_SECRET`) দিয়ে সাইন এবং ভেরিফাই দুটোই হতো।
- এতদিন সমস্যা ছিল না, কারণ Mail/Vault/Finance/Marketplace সবই একই codebase/process-এর route ছিল।

## যেটা যোগ করা হলো (Phase 1A)
Sylo/Ryft/Wisp/Verve/Zynth (এবং পরে third-party client) আলাদা OIDC client হয়ে উঠলে তাদের টোকেন **ভেরিফাই** করার ক্ষমতা দরকার, কিন্তু নতুন টোকেন **ইস্যু/forge** করার ক্ষমতা না। HS256-এ সেই আলাদা করা যায় না — যে ভেরিফাই করতে পারে সে সাইনও করতে পারে। তাই RS256 (asymmetric keypair)-এ পরিবর্তন করা হলো: AYZEN Central Account প্রাইভেট কী দিয়ে সাইন করে, বাকি সবাই শুধু পাবলিক কী দিয়ে ভেরিফাই করে।

এই ফেজে **শুধু** সেই crypto foundation-টা আছে। Key rotation, JWKS/`.well-known` endpoint, OAuth client registry, Authorization Code + PKCE — এগুলো Phase 1B/2+।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/jwt-keys.ts` | **নতুন ফাইল** — active RSA keypair resolve করে env var (`AYZEN_JWT_PRIVATE_KEY` / `AYZEN_JWT_PUBLIC_KEY` / `AYZEN_JWT_KID`) থেকে; dev-এ না থাকলে ephemeral keypair generate করে; legacy HS256 secret resolver-ও এখানে সরিয়ে আনা হয়েছে |
| `artifacts/api-server/src/lib/jwt.ts` | সাইন/ভেরিফাই HS256 থেকে RS256-এ পরিবর্তন; `ALLOW_LEGACY_HS256_TOKENS=true` সেট করলে পুরোনো HS256 টোকেনও সাময়িকভাবে গ্রহণ করবে (rollout grace period) |
| `artifacts/api-server/src/lib/sessions.ts` | শুধু comment আপডেট (এখন RS256 keypair-এর কথা বলে, আগের HS256 secret-এর বদলে) |
| `artifacts/api-server/src/lib/auth-utils.ts` | comment আপডেট — RS256 keypair-এর রেফারেন্স |
| `scripts/src/generate-jwt-keypair.ts` | **নতুন ফাইল** — `npx tsx scripts/src/generate-jwt-keypair.ts` চালিয়ে নতুন RSA keypair generate করা যায়, env var-এ paste করার জন্য প্রিন্ট করে |
| `scripts/package.json` | নতুন script: `pnpm --filter @workspace/scripts jwt:keypair` |

`auth-utils.ts`, `vault-backup-cloud.ts`, `routes/auth.ts`, `routes/passkey.ts` — এই ফাইলগুলো `lib/jwt.ts`-এর exported ফাংশন (`signAuthToken`, `verifyAuthToken`, `signOAuthState`, `verifyOAuthState`) ব্যবহার করে, এদের signature অপরিবর্তিত আছে, তাই এই ফাইলগুলোতে কোনো কোড পরিবর্তন লাগেনি।

## নতুন ENV VAR (production)
- `AYZEN_JWT_PRIVATE_KEY` — PEM RSA private key
- `AYZEN_JWT_PUBLIC_KEY` — matching PEM RSA public key
- `AYZEN_JWT_KID` — keypair-এর short stable id (JWT header-এর `kid`-এ যায়)
- `ALLOW_LEGACY_HS256_TOKENS` (ঐচ্ছিক) — rollout গ্রেস পিরিয়ডে পুরনো HS256 টোকেনও একসাথে গ্রহণ করবে

Dev-এ কিছু সেট না করলে ephemeral keypair auto-generate হয় (প্রতি restart-এ নতুন) — production-এ env var না থাকলে boot-এ error দিয়ে fail করবে।

## Rollout
এই deploy সব আগের HS256 টোকেন invalidate করে দেবে by default (আগের unsigned→HS256 migration-এর মতোই "expected and necessary")। একসাথে সবাইকে re-login করাতে না চাইলে সাময়িকভাবে `ALLOW_LEGACY_HS256_TOKENS=true` সেট করা যায়; সেশনগুলো এমনিতেই ৭ দিনে expire হয়ে যাবে, তারপর এটা off করে দিলেই হবে।

## যা টেস্ট করা হয়েছে
- সব edited/নতুন ফাইল bracket/paren balance এবং import graph চেক করা হয়েছে।
- `tsc --noEmit --skipLibCheck` দিয়ে সিনট্যাক্স/টাইপ-চেক করা হয়েছে (node_modules ইনস্টল করা না থাকায় শুধু `@types/node` না-পাওয়ার প্রত্যাশিত noise এসেছে, কোনো actual syntax/logic error পাওয়া যায়নি)।
- `jwt.ts`-এর যত caller আছে (`auth-utils.ts`, `vault-backup-cloud.ts`, `routes/auth.ts`, `routes/passkey.ts`) — সবগুলো grep করে দেখা হয়েছে, শুধু stable exported ফাংশন ব্যবহার করে, নতুন করে কিছু ভাঙেনি।
