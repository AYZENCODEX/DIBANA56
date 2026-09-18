/**
 * lib/vault-snapshot-restore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15c — Vault Snapshot Restore: Preview + Merge.
 *
 * routes/vault-snapshot.ts's original POST /vault/snapshot/restore only ever
 * restored Vault entities, and inserted them unconditionally — running it
 * twice on the same backup duplicated every entry, despite the route's own
 * comment claiming it was "safe to run more than once". This module replaces
 * that with a real MERGE across every table the snapshot actually contains
 * (see the `snapshot` shape built in routes/vault-snapshot.ts's POST
 * /vault/snapshot/export): Vault entities, Local accounts, KYC entities,
 * Game entities, and Wallets. For each table, a row already present (same
 * identity key) is left untouched, and only genuinely missing rows are
 * inserted. Nothing is ever updated or deleted — restore stays additive.
 *
 * Feature 15d extends this the same way: Mail Folders, Labels, Rules,
 * Contacts, Templates (body_html re-encrypted on insert, same convention as
 * the Vault's own sensitive fields), Messages (text_body/html_body
 * re-encrypted; identity key is the RFC message_id), Task Submissions,
 * Joined Protocols, and Protocol Ratings all merge-restore the same
 * additive way. Protocol Enrollments (project_enrollments) is backed up
 * (see routes/vault-snapshot.ts) but NOT auto-restored — its vault_entry_id
 * is NOT NULL and points at a Vault Entity row whose id changes on every
 * merge-restore, with no safe remap yet (same reasoning as `entityCoverage`
 * below). Task Submissions' own entity_id/entity_ids/cost_entries fields
 * have the identical problem but are nullable, so those three columns are
 * simply dropped on insert rather than excluding the whole table — see the
 * comment on the `taskSubmissions` RAW_PLANS entry. Finance and the account
 * profile are backed up (see routes/vault-snapshot.ts) but deliberately NOT
 * auto-restored here — see the `finance`/`profile` comment in that file for
 * why.
 *
 * Feature 15e adds Wallet Hub coverage: Built-in Wallet Tokens (key:
 * symbol) and Chain Deposits (key: chain + tx_hash + log_index — the
 * table's own real DB uniqueness constraint) merge-restore the same
 * additive way. Wallet Transfers, Credits, and Credit Transactions are
 * backed up but NOT auto-restored — same reasoning as Finance: these are
 * live balances and two-party money movements, not something a restore
 * should silently rewrite.
 *
 * Feature 15h adds full Local/Vault/KYC/Game entity coverage: KYC Data
 * Entities (kyc_data_entities — key: name + father_name + birth_date,
 * nid_number re-encrypted on insert, same convention as mail
 * templates/messages) merge-restore the same additive way. Category
 * receipts, value history, and entity shares (vault_shares, both granted
 * and received) are backed up (see routes/vault-snapshot.ts) but
 * deliberately NOT auto-restored — see the `entityCoverage` comment in that
 * file for why (entity-id remapping + shares being two-party data).
 *
 * Attachments are intentionally NOT restored here (same as the original
 * code): they're informational in the snapshot, shown in the preview counts
 * if you want to add them, but there's no dedicated attachment-recreate path
 * since vault-attachments.ts's upload flow expects a real file upload, not a
 * base64 blob replay.
 *
 * Two entry points:
 *   - buildRestoreDiff(userId, snapshot) — read-only. Computes what would be
 *     added per table, with a small NON-SENSITIVE preview list (display
 *     names only — never passwords/2FA/backup codes/seed phrases), and
 *     returns counts. Powers POST /vault/snapshot/restore-preview.
 *   - applyRestoreDiff(userId, snapshot) — recomputes the SAME diff from
 *     scratch server-side (never trusts a diff computed on an earlier
 *     request, or anything the client could supply) and inserts only the
 *     missing rows, all tables in one DB transaction. Powers POST
 *     /vault/snapshot/restore.
 *
 * Identity keys (what makes two rows "the same" for merge purposes) are
 * heuristic, since none of these tables has a real uniqueness constraint
 * across their user-facing fields:
 *   - vault         → projectName (case-insensitive) — the same field the
 *                     original restore already required to be present.
 *   - wallets       → chain + address (address case-insensitive).
 *   - localAccounts → category + username + email
 *   - kycEntries    → category + platform + username + email
 *   - gameEntries   → category + username + email
 * A row with every key field blank can never collide with anything, so it's
 * always treated as "new" rather than silently dropped.
 *
 * ASSUMPTIONS TO VERIFY (I built this from routes/vault-snapshot.ts,
 * lib/vault-crypto.ts, routes/local-accounts.ts, routes/kyc.ts and
 * routes/game-entries.ts — I did not have lib/wallet-crypto.ts or the
 * vaultEntriesTable/walletsTable drizzle schema files themselves):
 *   1. `encryptPhrase` — I'm assuming lib/wallet-crypto.ts exports an
 *      `encryptPhrase(plaintext): string` counterpart to the `decryptPhrase`
 *      it's already known to export (imported in routes/vault-snapshot.ts).
 *      If the real export is named differently, fix the dynamic import
 *      inside insertWalletRow() below.
 *   2. `db.transaction(async (tx) => { ... })` — standard drizzle-orm API;
 *      assuming this project's db instance supports it (not exercised
 *      anywhere else in the files I was given). If it doesn't, drop the
 *      `db.transaction` wrapper in applyRestoreDiff() and call the insert
 *      helpers directly against `db` — restore just loses atomicity across
 *      tables (a failure partway through would leave earlier tables' rows
 *      committed), which is a reasonable fallback for an additive-only
 *      operation.
 *   3. Raw-table column exclusion lists (excludeOnInsert) are my best guess
 *      at which columns are foreign keys / server-generated vs. safe to
 *      copy — double check against the real local_accounts / kyc_entries /
 *      game_entries table definitions (migrations 0xx) before relying on
 *      this in production.
 */
import { sql, eq, and } from "drizzle-orm";
import { db, vaultEntriesTable, walletsTable } from "@workspace/db";
import { encryptField } from "./vault-crypto";
import { SENSITIVE_VAULT_FIELDS, generateSerial } from "../routes/vault";
import { reencryptMailboxMessageForRestore, reencryptMailboxTemplateForRestore, reencryptDataEntityForRestore, reencryptEmailAccountForRestore } from "./vault-snapshot-extra";

// DR Evidence Collector Phase 2 (dr-evidence-collector-design.md §1) needs
// applyRestoreDiff() to run against an isolated dr_test_<run_id> schema
// instead of the production `db` singleton, via a per-call override rather
// than a second copy of this file. Every helper below that previously
// closed over the module-level `db` import now takes it as a parameter
// (defaulting to the real `db`, so every existing caller — the production
// POST /vault/snapshot/restore route — is unaffected and doesn't need to
// change). `DbHandle` is deliberately typed as `typeof db` rather than
// drizzle's own NodePgDatabase<...> generic so it stays in sync with
// whatever `db`'s inferred type actually is.
type DbHandle = typeof db;

export type RestoreTableKey =
  | "vault" | "wallets" | "localAccounts" | "kycEntries" | "gameEntries"
  | "mailboxFolders" | "mailboxLabels" | "mailboxRules" | "mailboxTemplates" | "mailboxContacts" | "mailboxMessages"
  // projectEnrollments deliberately excluded — see the comment above its
  // (removed) RAW_PLANS entry: vault_entry_id is NOT NULL and unremappable,
  // so it's reference-only, never auto-merge-restored.
  | "taskSubmissions" | "userProjects" | "projectRatings"
  | "builtinWalletTokens" | "chainDeposits" | "kycDataEntities" | "emailAccounts";

export interface RestoreTableDiff {
  table: RestoreTableKey;
  label: string;
  totalInSnapshot: number;
  toAdd: number;
  alreadyPresent: number;
  /** Up to 5 non-sensitive display labels of rows that would be added. Never contains credentials. */
  sample: string[];
}

export interface RestorePreview {
  exportedAt: string | null;
  tables: RestoreTableDiff[];
  totalToAdd: number;
}

export interface RestoreApplyResult {
  restored: number;
  skipped: number;
  errors: { table: RestoreTableKey; index: number; reason: string }[];
  byTable: Record<RestoreTableKey, { restored: number }>;
}

const norm = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());

// ─── Vault entities ──────────────────────────────────────────────────────
function vaultKey(row: any): string {
  return norm(row.projectName);
}
async function existingVaultKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const rows = await dbHandle.select({ projectName: vaultEntriesTable.projectName })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`));
  return new Set(rows.map(r => norm((r as any).projectName)).filter(Boolean));
}
async function insertVaultRow(tx: typeof db, userId: number, entry: any): Promise<void> {
  const values: Record<string, unknown> = { userId, entitySerial: generateSerial(userId) };
  for (const [key, value] of Object.entries(entry)) {
    if (["id", "userId", "entitySerial", "createdAt", "updatedAt", "deletedAt"].includes(key)) continue;
    if (value === null || value === undefined) continue;
    values[key] = SENSITIVE_VAULT_FIELDS.has(key) ? encryptField(String(value)) : value;
  }
  await (tx as any).insert(vaultEntriesTable).values(values);
}

// ─── Wallets ─────────────────────────────────────────────────────────────
function walletKey(row: any): string {
  const chain = norm(row.chain), address = norm(row.address);
  return address ? `${chain}|${address}` : "";
}
async function existingWalletKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const rows = await dbHandle.select({ chain: walletsTable.chain, address: walletsTable.address })
    .from(walletsTable).where(eq(walletsTable.userId, userId));
  return new Set(rows.map(r => walletKey(r)).filter(Boolean));
}
async function insertWalletRow(tx: typeof db, userId: number, entry: any): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, userId: _u, seedPhrase, encryptedPhrase, createdAt, updatedAt, lastSyncedAt, ...rest } = entry;
  const values: Record<string, unknown> = { ...rest, userId };
  if (seedPhrase) {
    // ASSUMPTION 1 — see file header. Adjust the export name here if wrong.
    const { encryptPhrase } = await import("./wallet-crypto");
    values.encryptedPhrase = encryptPhrase(seedPhrase);
  }
  await (tx as any).insert(walletsTable).values(values);
}

// ─── Raw-SQL tables (localAccounts / kycEntries / gameEntries) ────────────
interface RawTablePlan {
  table: RestoreTableKey;
  sqlTable: string;
  label: string;
  keyColumns: string[];       // snake_case columns making up the identity key
  displayColumns: string[];   // snake_case columns to build the preview label from, in priority order
  excludeOnInsert: string[];  // snake_case columns never copied over
}

const RAW_PLANS: RawTablePlan[] = [
  {
    table: "localAccounts", sqlTable: "local_accounts", label: "Local Accounts",
    keyColumns: ["category", "username", "email"],
    displayColumns: ["username", "email", "label", "category"],
    excludeOnInsert: ["id", "user_id", "vault_entry_id", "receipt_token", "created_at", "updated_at"],
  },
  {
    table: "kycEntries", sqlTable: "kyc_entries", label: "KYC Entities",
    keyColumns: ["category", "platform", "username", "email"],
    displayColumns: ["platform", "username", "email", "category"],
    excludeOnInsert: ["id", "user_id", "data_entity_id", "created_at", "updated_at"],
  },
  {
    table: "gameEntries", sqlTable: "game_entries", label: "Game Entities",
    keyColumns: ["category", "username", "email"],
    displayColumns: ["username", "email", "category"],
    excludeOnInsert: ["id", "user_id", "created_at", "updated_at"],
  },
  // ─── Feature 15d additions ────────────────────────────────────────────
  {
    table: "mailboxFolders", sqlTable: "ayzen_mailbox_folders", label: "Mail Folders",
    keyColumns: ["name"], displayColumns: ["name"],
    excludeOnInsert: ["id", "user_id", "created_at"],
  },
  {
    table: "mailboxLabels", sqlTable: "ayzen_mailbox_labels", label: "Mail Labels",
    keyColumns: ["name"], displayColumns: ["name"],
    excludeOnInsert: ["id", "user_id", "created_at"],
  },
  {
    table: "mailboxRules", sqlTable: "ayzen_mailbox_rules", label: "Mail Rules",
    keyColumns: ["name"], displayColumns: ["name"],
    // action_label_id/action_folder_id point at label/folder rows whose ids
    // may not match after a folder/label was itself just re-created above —
    // dropped on insert rather than risk pointing at the wrong (or no)
    // target; the rule still restores with its match condition intact.
    excludeOnInsert: ["id", "user_id", "created_at", "action_label_id", "action_folder_id"],
  },
  {
    table: "mailboxContacts", sqlTable: "ayzen_contacts", label: "Mail Contacts",
    keyColumns: ["email"], displayColumns: ["name", "email"],
    excludeOnInsert: ["id", "user_id", "created_at"],
  },
  {
    table: "taskSubmissions", sqlTable: "task_submissions", label: "Task Submissions",
    // entity_id kept in the identity key (still useful to distinguish two
    // submissions of the same task against different entities pre-restore)
    // but NEVER copied on insert (see excludeOnInsert) — see the comment
    // below for why.
    keyColumns: ["task_id", "entity_id", "submitted_at"],
    displayColumns: ["notes", "task_id"],
    // entity_id / entity_ids / cost_entries all point at vault_entries rows
    // by id. A merge-restored Vault Entity always gets a brand-new id
    // (insertVaultRow() never preserves the original), so copying these
    // verbatim from an old snapshot would silently reattach the restored
    // submission to whatever entity now happens to hold that old id (or to
    // nothing, if it's been deleted) — the same "no safe remap yet"
    // situation valueHistory/entityLinks/sharesOwned are already excluded
    // for elsewhere in this file. All three are nullable, so dropping them
    // just restores the submission itself (status/proof/notes/cost/profit)
    // without a stale entity link, rather than failing the whole row.
    excludeOnInsert: ["id", "user_id", "receipt_token", "entity_id", "entity_ids", "cost_entries"],
  },
  {
    table: "userProjects", sqlTable: "user_projects", label: "Joined Protocols",
    keyColumns: ["project_id"], displayColumns: ["project_id"],
    excludeOnInsert: ["id", "user_id", "joined_at"],
  },
  // projectEnrollments (project_enrollments) is intentionally NOT a RAW_PLAN
  // here, unlike userProjects above — see the "NOT auto-restored" comment on
  // `projectEnrollments` in routes/vault-snapshot.ts's buildVaultSnapshotPayload.
  // Its vault_entry_id is NOT NULL and, like task_submissions.entity_id
  // above, points at a vault_entries row whose id changes on merge-restore;
  // unlike entity_id there's no nullable fallback here — excluding
  // vault_entry_id on insert would fail the NOT NULL constraint on every
  // single row, and copying it verbatim would silently attach the
  // restored enrollment to the wrong entity. kyc_entry_id/data_entity_id
  // have the exact same unremappable-id problem. So this table stays
  // backed up for reference (still exported, still shown in the JSON) but
  // is never auto-merge-restored — same treatment as entityCoverage.
  {
    table: "projectRatings", sqlTable: "project_ratings", label: "Protocol Ratings",
    keyColumns: ["project_id"], displayColumns: ["project_id"],
    excludeOnInsert: ["id", "user_id", "created_at", "updated_at"],
  },
  {
    table: "builtinWalletTokens", sqlTable: "builtin_wallet_tokens", label: "Built-in Wallet Tokens",
    keyColumns: ["symbol"], displayColumns: ["symbol"],
    excludeOnInsert: ["id", "user_id", "created_at", "updated_at"],
  },
  {
    // chain + tx_hash + log_index is the table's own real DB uniqueness
    // constraint (see schema/chain-deposits.ts), so this identity key can't
    // false-collide the way the heuristic keys above can.
    table: "chainDeposits", sqlTable: "chain_deposits", label: "Chain Deposits",
    keyColumns: ["chain", "tx_hash", "log_index"], displayColumns: ["token_symbol", "amount", "chain"],
    excludeOnInsert: ["id", "user_id", "created_at", "confirmed_at"],
  },
];

// DR Evidence Collector Phase 2 (dr-evidence-collector-design.md §2, the
// verification-suite record-count step): the physical (snake_case) table
// name behind every RestoreTableKey applyRestoreDiff() can write to, so
// lib/dr-test-runner.ts can SELECT COUNT(*) against the isolated schema
// without duplicating this table/key mapping itself. Built from the same
// RAW_PLANS config above plus the two non-RAW_PLANS tables (vault, wallets)
// that go through the drizzle-typed insertVaultRow()/insertWalletRow()
// paths instead.
export const RESTORE_TABLE_SQL_NAMES: Record<RestoreTableKey, string> = {
  vault: "vault_entries",
  wallets: "wallets",
  // mailboxTemplates/mailboxMessages/kycDataEntities aren't in RAW_PLANS —
  // they insert through their own dedicated helpers (insertTemplateRow /
  // insertMessageRow / insertDataEntityRow above, for their re-encryption
  // step) rather than the generic raw-row path, so their physical table
  // names are listed here by hand instead.
  mailboxTemplates: "ayzen_mailbox_templates",
  mailboxMessages: "ayzen_mailbox_messages",
  kycDataEntities: "kyc_data_entities",
  emailAccounts: "email_accounts",
  ...Object.fromEntries(RAW_PLANS.map(p => [p.table, p.sqlTable])),
} as Record<RestoreTableKey, string>;

function rawRowKey(row: Record<string, any>, keyColumns: string[]): string {
  const parts = keyColumns.map(c => norm(row[c]));
  return parts.some(Boolean) ? parts.join("|") : "";
}
function rawRowDisplay(row: Record<string, any>, displayColumns: string[]): string {
  for (const c of displayColumns) if (row[c]) return String(row[c]);
  return "(unnamed entry)";
}
async function existingRawKeys(sqlTable: string, keyColumns: string[], userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const cols = keyColumns.map(c => `"${c}"`).join(", ");
  // sqlTable/keyColumns come from our own RAW_PLANS config, never from the
  // request — safe to interpolate. userId is coerced to Number first.
  const result = await dbHandle.execute(sql.raw(`SELECT ${cols} FROM ${sqlTable} WHERE user_id = ${Number(userId)}`));
  return new Set((result.rows as any[]).map(r => rawRowKey(r, keyColumns)).filter(Boolean));
}
async function insertRawRow(tx: typeof db, plan: RawTablePlan, userId: number, row: Record<string, any>): Promise<void> {
  const cols = Object.keys(row).filter(c => !plan.excludeOnInsert.includes(c) && row[c] !== undefined);
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${row[c]}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO ${sql.raw(plan.sqlTable)} (${colIdent}) VALUES (${valuesSql})`);
}

// ─── Mail Templates (needs body_html re-encrypted on insert) ─────────────
function templateKey(row: any): string {
  return norm(row.name);
}
async function existingTemplateKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const result = await dbHandle.execute(sql`SELECT name FROM ayzen_mailbox_templates WHERE user_id = ${userId}`);
  return new Set((result.rows as any[]).map(r => norm(r.name)).filter(Boolean));
}
async function insertTemplateRow(tx: typeof db, userId: number, entry: Record<string, any>): Promise<void> {
  const row = reencryptMailboxTemplateForRestore(entry);
  const cols = ["name", "subject", "body_html"];
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${row[c] ?? null}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO ayzen_mailbox_templates (${colIdent}) VALUES (${valuesSql})`);
}

// ─── Mail Messages (needs text_body/html_body re-encrypted on insert) ────
// Identity key prefers the RFC message_id (stable, provider-assigned); a
// draft with no message_id yet can never collide, so it's always restored
// as "new" rather than silently dropped.
function messageKey(row: any): string {
  return norm(row.message_id);
}
async function existingMessageKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const result = await dbHandle.execute(sql`SELECT message_id FROM ayzen_mailbox_messages WHERE user_id = ${userId} AND message_id IS NOT NULL`);
  return new Set((result.rows as any[]).map(r => norm(r.message_id)).filter(Boolean));
}
const MESSAGE_INSERT_COLS = [
  "direction", "folder", "is_draft", "resend_email_id", "message_id", "in_reply_to",
  "references_header", "thread_id", "from_addr", "to_addr", "cc_addr", "bcc_addr",
  "subject", "text_body", "html_body", "has_attachments", "is_read", "is_starred",
  "forwarded_to", "received_at",
];
async function insertMessageRow(tx: typeof db, userId: number, entry: Record<string, any>): Promise<void> {
  const row = reencryptMailboxMessageForRestore(entry);
  // folder_id/action_label_id-style references dropped, same reasoning as
  // mailboxRules above — restored messages land back in their system
  // folder ('inbox'/'sent'/etc.), never a custom folder that may not exist
  // (or exist under a different id) on the restoring account.
  const folder = ["inbox", "sent", "drafts", "archive", "trash", "spam"].includes(row.folder) ? row.folder : "inbox";
  const cols = MESSAGE_INSERT_COLS;
  const values: Record<string, any> = { ...row, folder };
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${values[c] ?? null}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO ayzen_mailbox_messages (${colIdent}) VALUES (${valuesSql})`);
}

// ─── KYC Data Entities (needs nid_number re-encrypted on insert) ─────────
// Feature 15h. Identity key deliberately avoids nid_number (encrypted at
// rest — existingDataEntityKeys() below reads straight from the DB without
// decrypting) and uses the other identity fields instead, same approach as
// the RAW_PLANS keys above never using an encrypted column.
function dataEntityKey(row: any): string {
  const parts = [norm(row.name), norm(row.father_name), norm(row.birth_date)];
  return parts.some(Boolean) ? parts.join("|") : "";
}
async function existingDataEntityKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const result = await dbHandle.execute(sql`SELECT name, father_name, birth_date FROM kyc_data_entities WHERE user_id = ${userId}`);
  return new Set((result.rows as any[]).map(r => dataEntityKey(r)).filter(Boolean));
}
const DATA_ENTITY_INSERT_COLS = ["nid_number", "name", "father_name", "birth_date", "photo1_url", "photo2_url", "notes"];
async function insertDataEntityRow(tx: typeof db, userId: number, entry: Record<string, any>): Promise<void> {
  const row = reencryptDataEntityForRestore(entry);
  const cols = DATA_ENTITY_INSERT_COLS;
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${row[c] ?? null}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO kyc_data_entities (${colIdent}) VALUES (${valuesSql})`);
}

// ─── Email Accounts (needs password/auth_key re-encrypted on insert) ──────
// Feature 15v. Identity key is email_address + protocol per user —
// deliberately never password/auth_key (encrypted at rest), same
// never-key-off-an-encrypted-column rule dataEntityKey/templateKey follow
// above. team_id is deliberately dropped on insert (see
// EMAIL_ACCOUNT_INSERT_COLS — it's not in the list, so every restored row
// lands as a personal account, teamId null): re-attaching a restored row to
// a team automatically would grant that team's *current* active members
// visibility into a decrypted credential the backup owner captured for
// their own disaster recovery, not for redistribution, and would do so
// without anyone at the team explicitly choosing it — same "a Settings
// decision, not something a restore should do for you" reasoning
// gatherBackupSystemSnapshot's doc comment gives elsewhere in this file.
// is_default is dropped for the same reason mailboxRules drops its
// label/folder id references: a raw insert bypasses the app's own
// "only one default at a time" logic (routes/email-accounts.ts), so a
// restored row always comes back as non-default rather than risking two
// rows both flagged default, or silently displacing whichever one the
// account is actually configured to use today.
function emailAccountKey(row: any): string {
  const email = norm(row.email_address), protocol = norm(row.protocol);
  return email ? `${email}|${protocol}` : "";
}
async function existingEmailAccountKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const result = await dbHandle.execute(sql`SELECT email_address, protocol FROM email_accounts WHERE user_id = ${userId}`);
  return new Set((result.rows as any[]).map(r => emailAccountKey(r)).filter(Boolean));
}
const EMAIL_ACCOUNT_INSERT_COLS = [
  "label", "email_address", "protocol", "provider", "imap_host", "imap_port",
  "smtp_host", "smtp_port", "username", "password", "auth_key", "session_pooler",
  "use_ssl", "notes", "tags",
];
async function insertEmailAccountRow(tx: typeof db, userId: number, entry: Record<string, any>): Promise<void> {
  const row = reencryptEmailAccountForRestore(entry);
  const cols = [...EMAIL_ACCOUNT_INSERT_COLS, "is_default"];
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const values: Record<string, any> = { ...row, is_default: false };
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${values[c] ?? null}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO email_accounts (${colIdent}) VALUES (${valuesSql})`);
}

// ─── Diff (preview) ──────────────────────────────────────────────────────
export async function buildRestoreDiff(userId: number, snapshot: any): Promise<RestorePreview> {
  const tables: RestoreTableDiff[] = [];


  {
    const entries: any[] = Array.isArray(snapshot.vault) ? snapshot.vault : [];
    const existing = await existingVaultKeys(userId);
    const toAdd = entries.filter(e => { const k = vaultKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "vault", label: "Vault Entities",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.projectName || "(unnamed entry)"),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.wallets) ? snapshot.wallets : [];
    const existing = await existingWalletKeys(userId);
    const toAdd = entries.filter(e => { const k = walletKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "wallets", label: "Wallets",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => `${e.label || e.chain || "Wallet"} · ${String(e.address ?? "").slice(0, 10)}…`),
    });
  }

  for (const plan of RAW_PLANS) {
    const entries: any[] = Array.isArray(snapshot[plan.table]) ? snapshot[plan.table] : [];
    const existing = await existingRawKeys(plan.sqlTable, plan.keyColumns, userId);
    const toAdd = entries.filter(e => { const k = rawRowKey(e, plan.keyColumns); return !k || !existing.has(k); });
    tables.push({
      table: plan.table, label: plan.label,
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => rawRowDisplay(e, plan.displayColumns)),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.mailboxTemplates) ? snapshot.mailboxTemplates : [];
    const existing = await existingTemplateKeys(userId);
    const toAdd = entries.filter(e => { const k = templateKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "mailboxTemplates", label: "Mail Templates",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.name || "(unnamed template)"),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.mailboxMessages) ? snapshot.mailboxMessages : [];
    const existing = await existingMessageKeys(userId);
    const toAdd = entries.filter(e => { const k = messageKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "mailboxMessages", label: "Mail Messages",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.subject || "(no subject)"),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.kycDataEntities) ? snapshot.kycDataEntities : [];
    const existing = await existingDataEntityKeys(userId);
    const toAdd = entries.filter(e => { const k = dataEntityKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "kycDataEntities", label: "KYC Data Entities",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.name || "(unnamed identity record)"),
    });
  }

  {
    const entries: any[] = Array.isArray(snapshot.emailAccounts) ? snapshot.emailAccounts : [];
    const existing = await existingEmailAccountKeys(userId);
    const toAdd = entries.filter(e => { const k = emailAccountKey(e); return !k || !existing.has(k); });
    tables.push({
      table: "emailAccounts", label: "Connected Mail Accounts",
      totalInSnapshot: entries.length, toAdd: toAdd.length, alreadyPresent: entries.length - toAdd.length,
      sample: toAdd.slice(0, 5).map(e => e.label || e.email_address || "(unnamed mail account)"),
    });
  }

  return {
    exportedAt: typeof snapshot.exportedAt === "string" ? snapshot.exportedAt : null,
    tables,
    totalToAdd: tables.reduce((s, t) => s + t.toAdd, 0),
  };
}

// ─── Apply (merge restore) ───────────────────────────────────────────────
export interface ApplyRestoreDiffOptions {
  // DR Evidence Collector Phase 2: pass an isolated-schema drizzle instance
  // (see lib/dr-test-db.ts) to restore into `dr_test_<run_id>` instead of
  // production. Omitted (or undefined) on every existing caller — the real
  // POST /vault/snapshot/restore route — which keeps using the production
  // `db` singleton exactly as before.
  dbOverride?: DbHandle;
}

export async function applyRestoreDiff(userId: number, snapshot: any, opts: ApplyRestoreDiffOptions = {}): Promise<RestoreApplyResult> {
  const activeDb = opts.dbOverride ?? db;
  const errors: RestoreApplyResult["errors"] = [];
  const byTable: RestoreApplyResult["byTable"] = {
    vault: { restored: 0 }, wallets: { restored: 0 },
    localAccounts: { restored: 0 }, kycEntries: { restored: 0 }, gameEntries: { restored: 0 },
    mailboxFolders: { restored: 0 }, mailboxLabels: { restored: 0 }, mailboxRules: { restored: 0 },
    mailboxTemplates: { restored: 0 }, mailboxContacts: { restored: 0 }, mailboxMessages: { restored: 0 },
    taskSubmissions: { restored: 0 }, userProjects: { restored: 0 },
    projectRatings: { restored: 0 },
    builtinWalletTokens: { restored: 0 }, chainDeposits: { restored: 0 },
    kycDataEntities: { restored: 0 },
    emailAccounts: { restored: 0 },
  };

  // ASSUMPTION 2 — see file header — about db.transaction() support. Runs
  // against activeDb (production `db`, or the isolated-schema override) so
  // a DR test's restore is fully atomic within its own throwaway schema
  // too, not just in production.
  await activeDb.transaction(async (tx) => {
    const vaultEntries: any[] = Array.isArray(snapshot.vault) ? snapshot.vault : [];
    const existingVault = await existingVaultKeys(userId, activeDb);
    for (let i = 0; i < vaultEntries.length; i++) {
      const entry = vaultEntries[i];
      const k = vaultKey(entry);
      if (k && existingVault.has(k)) continue;
      if (!entry.projectName) { errors.push({ table: "vault", index: i, reason: "Missing projectName" }); continue; }
      try {
        await insertVaultRow(tx as any, userId, entry);
        byTable.vault.restored++;
        if (k) existingVault.add(k);
      } catch (err: any) {
        errors.push({ table: "vault", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    const wallets: any[] = Array.isArray(snapshot.wallets) ? snapshot.wallets : [];
    const existingWallets = await existingWalletKeys(userId, activeDb);
    for (let i = 0; i < wallets.length; i++) {
      const entry = wallets[i];
      const k = walletKey(entry);
      if (k && existingWallets.has(k)) continue;
      if (!entry.address) { errors.push({ table: "wallets", index: i, reason: "Missing address" }); continue; }
      try {
        await insertWalletRow(tx as any, userId, entry);
        byTable.wallets.restored++;
        if (k) existingWallets.add(k);
      } catch (err: any) {
        errors.push({ table: "wallets", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    for (const plan of RAW_PLANS) {
      const entries: any[] = Array.isArray(snapshot[plan.table]) ? snapshot[plan.table] : [];
      const existing = await existingRawKeys(plan.sqlTable, plan.keyColumns, userId, activeDb);
      for (let i = 0; i < entries.length; i++) {
        const row = entries[i];
        const k = rawRowKey(row, plan.keyColumns);
        if (k && existing.has(k)) continue;
        try {
          await insertRawRow(tx as any, plan, userId, row);
          byTable[plan.table].restored++;
          if (k) existing.add(k);
        } catch (err: any) {
          errors.push({ table: plan.table, index: i, reason: err?.message ?? "Insert failed" });
        }
      }
    }

    const templates: any[] = Array.isArray(snapshot.mailboxTemplates) ? snapshot.mailboxTemplates : [];
    const existingTemplates = await existingTemplateKeys(userId, activeDb);
    for (let i = 0; i < templates.length; i++) {
      const entry = templates[i];
      const k = templateKey(entry);
      if (k && existingTemplates.has(k)) continue;
      if (!entry.name) { errors.push({ table: "mailboxTemplates", index: i, reason: "Missing name" }); continue; }
      try {
        await insertTemplateRow(tx as any, userId, entry);
        byTable.mailboxTemplates.restored++;
        if (k) existingTemplates.add(k);
      } catch (err: any) {
        errors.push({ table: "mailboxTemplates", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    const messages: any[] = Array.isArray(snapshot.mailboxMessages) ? snapshot.mailboxMessages : [];
    const existingMessages = await existingMessageKeys(userId, activeDb);
    for (let i = 0; i < messages.length; i++) {
      const entry = messages[i];
      const k = messageKey(entry);
      if (k && existingMessages.has(k)) continue;
      try {
        await insertMessageRow(tx as any, userId, entry);
        byTable.mailboxMessages.restored++;
        if (k) existingMessages.add(k);
      } catch (err: any) {
        errors.push({ table: "mailboxMessages", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    const dataEntities: any[] = Array.isArray(snapshot.kycDataEntities) ? snapshot.kycDataEntities : [];
    const existingDataEntities = await existingDataEntityKeys(userId, activeDb);
    for (let i = 0; i < dataEntities.length; i++) {
      const entry = dataEntities[i];
      const k = dataEntityKey(entry);
      if (k && existingDataEntities.has(k)) continue;
      if (!entry.name) { errors.push({ table: "kycDataEntities", index: i, reason: "Missing name" }); continue; }
      try {
        await insertDataEntityRow(tx as any, userId, entry);
        byTable.kycDataEntities.restored++;
        if (k) existingDataEntities.add(k);
      } catch (err: any) {
        errors.push({ table: "kycDataEntities", index: i, reason: err?.message ?? "Insert failed" });
      }
    }

    const emailAccounts: any[] = Array.isArray(snapshot.emailAccounts) ? snapshot.emailAccounts : [];
    const existingEmailAccounts = await existingEmailAccountKeys(userId, activeDb);
    for (let i = 0; i < emailAccounts.length; i++) {
      const entry = emailAccounts[i];
      const k = emailAccountKey(entry);
      if (k && existingEmailAccounts.has(k)) continue;
      if (!entry.email_address) { errors.push({ table: "emailAccounts", index: i, reason: "Missing email_address" }); continue; }
      try {
        await insertEmailAccountRow(tx as any, userId, entry);
        byTable.emailAccounts.restored++;
        if (k) existingEmailAccounts.add(k);
      } catch (err: any) {
        errors.push({ table: "emailAccounts", index: i, reason: err?.message ?? "Insert failed" });
      }
    }
  });

  const restored = Object.values(byTable).reduce((s, t) => s + t.restored, 0);
  return { restored, skipped: errors.length, errors: errors.slice(0, 100), byTable };
}
