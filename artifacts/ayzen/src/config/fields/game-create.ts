import type { FieldDef } from "@/config/types";

// Field config for components/game-entries.tsx's Add/Edit Game Entity
// dialog. Same config-driven pattern as kyc-create.ts / entity-create.ts —
// consumer renders <SchemaForm fields={GAME_FIELDS.filter(...)} tab="..." .../>
// per active top-level tab.
//
// Category (the box picker) is its own step in the dialog, not a field here.
//
// "tags" (key === "tags") is listed here for the field set's documentation,
// but it isn't a plain SchemaForm text field — it's a free-typed,
// space-to-commit chip list (see TagInput in game-entries.tsx), stored as a
// JSON string array. game-entries.tsx renders it as its own control on the
// Info tab and excludes key === "tags" from what it passes into SchemaForm
// (same pattern kyc-create.ts documents for "paid").

export const GAME_FIELDS: FieldDef[] = [
  // ── Account ───────────────────────────────────────────────────────────
  {
    key: "username", label: "Username", type: "text", tab: "account",
    pairKey: "acct-1", placeholder: "account username / handle", compact: true,
  },
  {
    key: "accountPassword", label: "Account Password", type: "password", tab: "account",
    pairKey: "acct-1", placeholder: "••••••••", compact: true,
  },
  {
    key: "notes", label: "Notes", type: "textarea", tab: "account",
    placeholder: "Any additional info about this game account...", rows: 3,
  },

  // ── Email ─────────────────────────────────────────────────────────────
  {
    key: "email", label: "Email", type: "text", tab: "email",
    pairKey: "email-1", placeholder: "account@email.com", compact: true,
  },
  {
    key: "emailPassword", label: "Email Password", type: "password", tab: "email",
    pairKey: "email-1", placeholder: "••••••••", compact: true,
  },
  {
    key: "email2fa", label: "Email 2FA Secret", type: "text", tab: "email",
    pairKey: "email-2", placeholder: "TOTP secret...", compact: true,
  },
  {
    key: "emailBackupCode", label: "Email Backup Code", type: "text", tab: "email",
    pairKey: "email-2", placeholder: "backup code...", compact: true,
  },

  // ── Info ──────────────────────────────────────────────────────────────
  {
    key: "rank", label: "Rank", type: "text", tab: "info",
    pairKey: "info-1", placeholder: "e.g. Immortal, Mythic Glory", compact: true,
  },
  {
    key: "level", label: "Level", type: "text", tab: "info",
    pairKey: "info-1", placeholder: "e.g. 120", compact: true,
  },
  {
    key: "accountAge", label: "Account Age", type: "text", tab: "info",
    placeholder: "e.g. 3 years", compact: true,
  },
  {
    key: "tags", label: "Tags", type: "text", tab: "info",
    help: "Type whatever this account has and press space to turn it into a tag.",
  },
];
