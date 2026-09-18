import type { FieldDef } from "@/config/types";

// Field config for components/local-accounts.tsx's Add/Edit Account dialog
// (AccountFormDialog). See UI_CONFIG_PLAN.md Phase B — "Local account
// create/view".
//
// Covers the "creds", "dates", and "value" tabs. The "platform" tab stays
// its own bit of page code (same call as entity-create.ts made for the
// entity dialog's "other" tab): it renders a different metric label,
// placeholder, and farming-tips list per selected category, sourced from
// config/vault-local.ts's LOCAL_ACCOUNT_PLATFORM_META — that's genuinely
// per-category dynamic content, not a fixed field set. The "points" tab
// is also excluded: it's a live add/history log tied to a saved account
// id, not a form field.
//
// Adding a credential field to creds/dates/value = one entry here.

export const LOCAL_ACCOUNT_FIELDS: FieldDef[] = [
  // ── Credentials ────────────────────────────────────────────────────
  {
    key: "username", label: "Username", type: "text", tab: "creds",
    pairKey: "creds-1", pairGap: "gap-2", placeholder: "@handle", compact: true,
  },
  {
    key: "password", label: "Password", type: "password", tab: "creds",
    pairKey: "creds-1", pairGap: "gap-2", placeholder: "••••••••", compact: true,
  },
  {
    key: "email", label: "Email", type: "text", tab: "creds",
    pairKey: "creds-2", pairGap: "gap-2", placeholder: "account@gmail.com", compact: true,
  },
  {
    key: "email_password", label: "Email Password", type: "password", tab: "creds",
    pairKey: "creds-2", pairGap: "gap-2", placeholder: "••••••••", compact: true,
  },
  {
    key: "recovery_email", label: "Recovery Email", type: "text", tab: "creds",
    pairKey: "creds-3", pairGap: "gap-2", placeholder: "recovery@gmail.com", compact: true,
  },
  {
    key: "recovery_email_password", label: "Recovery Pass", type: "password", tab: "creds",
    pairKey: "creds-3", pairGap: "gap-2", placeholder: "••••••••", compact: true,
  },
  {
    key: "twofa", label: "2FA Secret", type: "text", tab: "creds",
    pairKey: "creds-4", pairGap: "gap-2", placeholder: "TOTP / backup code", compact: true,
  },
  {
    key: "recovery_email_twofa", label: "Recovery 2FA", type: "text", tab: "creds",
    pairKey: "creds-4", pairGap: "gap-2", placeholder: "recovery email TOTP", compact: true,
  },
  {
    key: "backup_codes", label: "Backup Codes", type: "textarea", tab: "creds",
    placeholder: "Paste backup codes (one per line or space separated)", rows: 3,
  },

  // ── Dates & Meta ───────────────────────────────────────────────────
  {
    key: "label", label: "Label / Nickname", type: "text", tab: "dates",
    placeholder: "e.g. Main acc, farming1...",
  },
  {
    key: "account_create_date", label: "Account Create Date", type: "date", tab: "dates",
  },
  {
    key: "account_buy_date", label: "Account Buy Date", type: "date", tab: "dates",
  },
  {
    key: "account_last_login_date", label: "Last Login Date", type: "date", tab: "dates",
  },

  // ── Value & ROI ────────────────────────────────────────────────────
  {
    key: "account_worth", label: "Account Worth ($)", type: "number", tab: "value",
    pairKey: "value-1", pairGap: "gap-2", placeholder: "0.00", compact: false,
  },
  {
    key: "buy_price", label: "Buy Price ($)", type: "number", tab: "value",
    pairKey: "value-1", pairGap: "gap-2", placeholder: "0.00", compact: false,
  },
];
