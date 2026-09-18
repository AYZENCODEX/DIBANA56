/**
 * lib/vault-snapshot-extra.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15d — Vault Backup Coverage Expansion: Native Mailbox, Projects
 * (Protocols/Enrollments), Tasks, Finance, and User Profile.
 *
 * routes/vault-snapshot.ts's buildVaultSnapshotPayload() originally only
 * covered the tables this app calls "the Vault" in the narrow sense (Vault
 * entities, Local/KYC/Game accounts, Wallets, Attachments). This module adds
 * the rest of a user's data to that same encrypted backup blob, so a single
 * .ayzenbak actually is a full-account disaster-recovery snapshot:
 *
 *   - mailbox  — native ayzen.tech mailbox: folders, messages (bodies
 *                decrypted the same way routes/ayzen-mailbox.ts does for
 *                display), labels + message-label links, rules, compose
 *                templates (bodyHtml decrypted), saved contacts, and
 *                attachments (metadata always, encrypted content only when
 *                includeAttachments is set — outbound only, since inbound
 *                bytes live at Resend, not in our own DB).
 *   - projects — this user's relationship to the (shared/global) projects
 *                catalog: which protocols they've joined, their per-project
 *                enrollments (which entity/account is running which
 *                protocol), ROI ledger, ratings, and PnL receipt links. The
 *                projects catalog itself is platform-wide admin data, not
 *                this user's data, so it is deliberately NOT included here.
 *   - tasks    — this user's task submissions (the task catalog itself is
 *                platform-wide, same reasoning as the projects catalog).
 *   - finance  — every finance_* row this user owns, including child rows
 *                (invoice lines, repayments, journal lines, asset owners,
 *                invoice events/agreements) resolved via their parent's
 *                user_id since the child tables don't carry one directly,
 *                plus attachments (receipt/document uploads — metadata
 *                always, content_base64 only when includeAttachments).
 *   - profile  — the user's own users-table row, with auth secrets
 *                (password hash, 2FA secret) stripped — everything else
 *                (handles, digest prefs, invoice branding, etc.) is just
 *                account configuration, not a credential.
 *   - walletHub — everything the "Wallet Hub" page (pages/user/wallet-hub.tsx)
 *                shows beyond the base `wallets` rows already covered by
 *                buildVaultSnapshotPayload's own walletsTable query:
 *                internal AZN/USDT/BDT/XP balances (credits) + their
 *                purchase history (credit_transactions), user-to-user
 *                transfers (wallet_transfers), off-chain built-in-wallet
 *                token balances (builtin_wallet_tokens), and on-chain
 *                deposit history (chain_deposits).
 *
 * Every query is wrapped in .catch(() => []) the same way the original
 * local_accounts/kyc_entries/game_entries queries in vault-snapshot.ts are —
 * a table that doesn't exist yet on some install (or a column that's
 * mid-migration) degrades that one section to empty instead of failing the
 * whole export.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { decryptField, encryptField } from "./vault-crypto";

const rows = (p: Promise<{ rows: any[] }>): Promise<any[]> => p.then(r => r.rows).catch(() => []);

// ─── Mailbox ────────────────────────────────────────────────────────────────
export interface MailboxSnapshot {
  folders: any[];
  messages: any[];
  labels: any[];
  messageLabels: any[];
  rules: any[];
  templates: any[];
  contacts: any[];
  attachments: any[];
}

export async function gatherMailboxSnapshot(userId: number, includeAttachments: boolean): Promise<MailboxSnapshot> {
  const [folders, rawMessages, labels, messageLabels, rules, rawTemplates, contacts, rawAttachments] = await Promise.all([
    rows(db.execute(sql`SELECT * FROM ayzen_mailbox_folders WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM ayzen_mailbox_messages WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM ayzen_mailbox_labels WHERE user_id = ${userId}`)),
    rows(db.execute(sql`
      SELECT ml.* FROM ayzen_mailbox_message_labels ml
      JOIN ayzen_mailbox_messages m ON m.id = ml.message_id
      WHERE m.user_id = ${userId}
    `)),
    rows(db.execute(sql`SELECT * FROM ayzen_mailbox_rules WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM ayzen_mailbox_templates WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM ayzen_contacts WHERE user_id = ${userId}`)),
    // ayzen_mailbox_attachments carries no user_id of its own — resolved via
    // its parent message, same join pattern the finance child tables below
    // use. encrypted_content is only ever populated for OUTBOUND attachments
    // (inbound bytes live at Resend, fetched on demand — see the schema
    // comment on ayzenMailboxAttachmentsTable); metadata is always gathered,
    // the (potentially large) content only when includeAttachments is set —
    // same one flag that already gates Vault's own binary attachments.
    rows(db.execute(sql`
      SELECT a.* FROM ayzen_mailbox_attachments a
      JOIN ayzen_mailbox_messages m ON m.id = a.message_id
      WHERE m.user_id = ${userId}
    `)),
  ]);

  // Bodies are stored encrypted at rest (same convention as Vault sensitive
  // fields) — decrypt here so the backup is immediately readable/restorable,
  // matching how buildVaultSnapshotPayload() already handles the Vault's own
  // sensitive fields and wallet seed phrases.
  const safeDecrypt = (v: string | null): string | null => { try { return decryptField(v); } catch { return v; } };
  const messages = rawMessages.map(m => ({
    ...m,
    text_body: safeDecrypt(m.text_body),
    html_body: safeDecrypt(m.html_body),
  }));
  const templates = rawTemplates.map(t => ({
    ...t,
    body_html: safeDecrypt(t.body_html),
  }));
  // Decrypted bytes go into a distinct field (content_base64), same
  // convention as vault-snapshot.ts's own attachment handling
  // (`encryptedContent: undefined, dataBase64: decryptField(...)`). Leaving
  // the plaintext under the original `encrypted_content` key would mislead
  // anyone reading the raw backup JSON into thinking the content is still
  // encrypted, when it is not.
  const attachments = rawAttachments.map(a => ({
    ...a,
    encrypted_content: undefined,
    content_base64: includeAttachments && a.encrypted_content ? safeDecrypt(a.encrypted_content) : null,
  }));

  return { folders, messages, labels, messageLabels, rules, templates, contacts, attachments };
}

// ─── Projects (protocols this user has joined/enrolled/rated) ─────────────
export interface ProjectsSnapshot {
  userProjects: any[];
  enrollments: any[];
  roiLedger: any[];
  ratings: any[];
  pnlReceipts: any[];
}

export async function gatherProjectsSnapshot(userId: number): Promise<ProjectsSnapshot> {
  const [userProjects, enrollments, roiLedger, ratings, pnlReceipts] = await Promise.all([
    rows(db.execute(sql`SELECT * FROM user_projects WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM project_enrollments WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM entity_project_roi WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM project_ratings WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM project_pnl_receipts WHERE user_id = ${userId}`)),
  ]);
  return { userProjects, enrollments, roiLedger, ratings, pnlReceipts };
}

// ─── Tasks ──────────────────────────────────────────────────────────────────
export interface TasksSnapshot {
  submissions: any[];
}

export async function gatherTasksSnapshot(userId: number): Promise<TasksSnapshot> {
  const submissions = await rows(db.execute(sql`SELECT * FROM task_submissions WHERE user_id = ${userId}`));
  return { submissions };
}

// ─── Finance ────────────────────────────────────────────────────────────────
export interface FinanceSnapshot {
  parties: any[];
  ledgerEntries: any[];
  invoiceLines: any[];
  repayments: any[];
  assets: any[];
  assetOwners: any[];
  depreciation: any[];
  recurringRules: any[];
  budgets: any[];
  attachments: any[];
  currencyRates: any[];
  books: any[];
  reportSchedules: any[];
  accounts: any[];
  journalEntries: any[];
  journalLines: any[];
  amortization: any[];
  goals: any[];
  netWorthSnapshots: any[];
  paymentMethods: any[];
  invoices: any[];
  invoiceLineItems: any[];
  invoiceEvents: any[];
  paymentAgreements: any[];
}

export async function gatherFinanceSnapshot(userId: number, includeAttachments: boolean): Promise<FinanceSnapshot> {
  const [
    parties, ledgerEntries, assets, depreciation, recurringRules, budgets,
    currencyRates, books, reportSchedules, accounts, journalEntries,
    amortization, goals, netWorthSnapshots, paymentMethods, invoices, rawAttachments,
  ] = await Promise.all([
    rows(db.execute(sql`SELECT * FROM finance_parties WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_ledger_entries WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_assets WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_depreciation WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_recurring_rules WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_budgets WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_currency_rates WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_books WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_report_schedules WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_accounts WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_journal_entries WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_amortization WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_goals WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_net_worth_snapshots WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_payment_methods WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM finance_invoices WHERE user_id = ${userId}`)),
    // finance_attachments carries user_id directly (unlike the other child
    // tables below) — receipt/document uploads on ledger entries.
    // content_base64 is the heavy part (raw file bytes); metadata is always
    // gathered, content only when includeAttachments — same flag/convention
    // as Vault's and Mailbox's own attachments.
    rows(db.execute(sql`SELECT * FROM finance_attachments WHERE user_id = ${userId}`)),
  ]);

  // Child tables carry no user_id of their own — resolved via their parent's
  // id, scoped to rows already known to belong to this user above.
  const [invoiceLines, repayments, assetOwners, journalLines, invoiceLineItems, invoiceEvents, paymentAgreements] = await Promise.all([
    rows(db.execute(sql`
      SELECT il.* FROM finance_invoice_lines il
      JOIN finance_ledger_entries e ON e.id = il.entry_id
      WHERE e.user_id = ${userId}
    `)),
    rows(db.execute(sql`
      SELECT r.* FROM finance_repayments r
      JOIN finance_ledger_entries e ON e.id = r.entry_id
      WHERE e.user_id = ${userId}
    `)),
    rows(db.execute(sql`
      SELECT o.* FROM finance_asset_owners o
      JOIN finance_assets a ON a.id = o.asset_id
      WHERE a.user_id = ${userId}
    `)),
    rows(db.execute(sql`
      SELECT jl.* FROM finance_journal_lines jl
      JOIN finance_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.user_id = ${userId}
    `)),
    rows(db.execute(sql`
      SELECT li.* FROM finance_invoice_line_items li
      JOIN finance_invoices inv ON inv.id = li.invoice_id
      WHERE inv.user_id = ${userId}
    `)),
    rows(db.execute(sql`
      SELECT ev.* FROM finance_invoice_events ev
      JOIN finance_invoices inv ON inv.id = ev.invoice_id
      WHERE inv.user_id = ${userId}
    `)),
    rows(db.execute(sql`
      SELECT pa.* FROM finance_payment_agreements pa
      JOIN finance_invoices inv ON inv.id = pa.invoice_id
      WHERE inv.user_id = ${userId}
    `)),
  ]);

  const attachments = rawAttachments.map(a => ({
    ...a,
    content_base64: includeAttachments ? a.content_base64 : null,
  }));

  return {
    parties, ledgerEntries, invoiceLines, repayments, assets, assetOwners,
    depreciation, recurringRules, budgets, attachments, currencyRates, books, reportSchedules,
    accounts, journalEntries, journalLines, amortization, goals, netWorthSnapshots,
    paymentMethods, invoices, invoiceLineItems, invoiceEvents, paymentAgreements,
  };
}

// ─── User profile (account configuration, not credentials) ────────────────
// Explicitly strips password_hash and two_fa_secret — auth material never
// belongs in a backup blob that can be re-decrypted by anyone who eventually
// gets the export password, even though that password is itself the user's
// own. Everything else here is display/config data (handles, digest
// preferences, invoice branding, streaks, etc).
const USER_PROFILE_EXCLUDE = new Set(["password_hash", "two_fa_secret"]);

export async function gatherUserProfileSnapshot(userId: number): Promise<Record<string, unknown> | null> {
  const [row] = await rows(db.execute(sql`SELECT * FROM users WHERE id = ${userId}`));
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (USER_PROFILE_EXCLUDE.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function reencryptMailboxMessageForRestore(m: Record<string, any>): Record<string, any> {
  return {
    ...m,
    text_body: m.text_body != null ? encryptField(String(m.text_body)) : m.text_body,
    html_body: m.html_body != null ? encryptField(String(m.html_body)) : m.html_body,
  };
}

export function reencryptMailboxTemplateForRestore(t: Record<string, any>): Record<string, any> {
  return {
    ...t,
    body_html: t.body_html != null ? encryptField(String(t.body_html)) : t.body_html,
  };
}

// ─── Wallet Hub ─────────────────────────────────────────────────────────────
// Base wallet rows (address/chain/encryptedPhrase/etc) are already gathered
// directly in buildVaultSnapshotPayload() via walletsTable — this covers the
// rest of what the Wallet Hub page shows.
export interface WalletHubSnapshot {
  transfers: any[];
  builtinTokens: any[];
  credits: any[];
  creditTransactions: any[];
  chainDeposits: any[];
}

export async function gatherWalletHubSnapshot(userId: number): Promise<WalletHubSnapshot> {
  const [transfers, builtinTokens, credits, creditTransactions, chainDeposits] = await Promise.all([
    // Transfers are two-sided (sender OR receiver) — a transfer this user
    // received from someone else is still part of their own wallet history.
    rows(db.execute(sql`SELECT * FROM wallet_transfers WHERE from_user_id = ${userId} OR to_user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM builtin_wallet_tokens WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM credits WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM credit_transactions WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM chain_deposits WHERE user_id = ${userId}`)),
  ]);
  return { transfers, builtinTokens, credits, creditTransactions, chainDeposits };
}

// ─── Activity trace ─────────────────────────────────────────────────────────
// Feature 15f — Vault Backup Coverage Expansion: Activity Trace. Every
// action this app traces about the user — the general event log
// (routes/history.ts's `user_activity`, written by lib/activity.ts's
// logActivity(), which is itself how a "vault_snapshot_exported" /
// "vault_snapshot_restored" / "vault_backup_scheduled_run" event gets
// recorded in the first place) plus the two Vault-specific audit trails
// (`vault_activity_log` — created/updated/seed-revealed/deleted events per
// entity, and `vault_field_history` — old/new value per per-field edit) —
// was NOT part of the backup blob until now. A disaster-recovery snapshot
// that rebuilds every table but drops the trail of who-changed-what-when is
// missing the audit evidence, not just convenience data.
//
// Same treatment as `finance`/`profile` below: included in every
// export/scheduled backup for reference, but never auto-restored (an audit
// log's whole point is an immutable record of what already happened — a
// merge-restore re-inserting old trace rows would just be forging history
// with a new timestamp, not recovering anything).
//
// Capped to the most recent ACTIVITY_TRACE_LIMIT rows per table rather than
// the full history: unlike the rest of this app's data, an activity log
// grows forever, so pulling it unbounded would itself blow past the
// per-user storage quota (MAX_TOTAL_SNAPSHOT_BYTES in
// routes/vault-snapshot.ts) on the very first export for any account with a
// long history. Older activity stays queryable in-app (routes/history.ts)
// even once it ages out of new backups.
const ACTIVITY_TRACE_LIMIT = 2000;

export interface ActivitySnapshot {
  userActivity: any[];
  vaultActivityLog: any[];
  vaultFieldHistory: any[];
}

export async function gatherActivitySnapshot(userId: number): Promise<ActivitySnapshot> {
  const [userActivity, vaultActivityLog, vaultFieldHistory] = await Promise.all([
    rows(db.execute(sql`
      SELECT * FROM user_activity WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${ACTIVITY_TRACE_LIMIT}
    `)),
    rows(db.execute(sql`
      SELECT * FROM vault_activity_log WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${ACTIVITY_TRACE_LIMIT}
    `)),
    rows(db.execute(sql`
      SELECT * FROM vault_field_history WHERE user_id = ${userId}
      ORDER BY changed_at DESC LIMIT ${ACTIVITY_TRACE_LIMIT}
    `)),
  ]);
  return { userActivity, vaultActivityLog, vaultFieldHistory };
}

// ─── Entity coverage (full backup for Local/Vault/KYC/Game entities) ──────
// Feature 15h — Vault Backup Coverage Expansion: Entity Coverage.
//
// The base entity tables (Vault entries, Local accounts, KYC entries, Game
// entries) were already gathered directly in buildVaultSnapshotPayload() —
// but four more pieces of *this same entity data* lived outside those four
// tables and were missing from the backup blob entirely:
//
//   - dataEntities   — `kyc_data_entities`: the actual identity record
//                       (name/father's name/birth date/photos/NID) that a
//                       KYC Entity OR a Vault Entity can link via
//                       `data_entity_id` (see routes/kyc-data-entities.ts).
//                       This is real identity data, not metadata — losing
//                       it on a restore would mean a "restored" KYC/Vault
//                       entity with no underlying identity record behind
//                       it. `nid_number` is encrypted at rest the same way
//                       Vault's own sensitive fields are; decrypted here so
//                       the backup is immediately usable, same convention
//                       as `vault`/mailbox bodies/templates above.
//   - categoryReceipts — `vault_category_receipts`: shareable receipt-card
//                       links minted per (user, category) across Local
//                       Accounts / Vault Entities in that category (see
//                       migrations 022/023). Reference data, not restored
//                       (see snapshot-shape comment in vault-snapshot.ts).
//   - valueHistory    — `value_history`: the $ worth / follower-count P&L
//                       timeline recorded per Vault or Local entity
//                       (sourceType "vault" | "local", sourceId = that
//                       entity's row id). Included for disaster-recovery
//                       reference; NOT auto-restored because sourceId
//                       points at a specific entity row id that a merge
//                       restore reassigns a fresh id to — same "no safe
//                       remap yet" situation as mailboxAttachments.
//   - sharesOwned / sharesReceived — `vault_shares`: access grants across
//                       ALL FOUR entity types (local/entity/kyc/game — see
//                       ENTITY_TABLES in routes/vault-shares.ts), gathered
//                       both directions since a share this user granted
//                       away and a share someone granted TO this user are
//                       both part of this user's own account state. Same
//                       "not auto-restored" reasoning as valueHistory
//                       (entity_id would point at the wrong row post-
//                       restore) plus it's two-party data — silently
//                       reinstating a grant on someone else's account isn't
//                       something a restore should ever do on its own.
//   - entityLinks     — `vault_entity_links`: the "Linked Entities" graph
//                       (alt_of / shares_wallet / shares_email / etc — see
//                       schema/vault.ts's vaultEntityLinksTable and
//                       routes/vault-entity-links.ts). Scoped by userId
//                       directly (unlike sharesOwned/sharesReceived it isn't
//                       two-party), but entityId/linkedEntityId both point
//                       at a vault_entries row id, so it has the exact same
//                       "no safe remap yet" restore limitation as
//                       valueHistory above — a merge-restored Vault Entity
//                       gets a brand-new id, and there's no id-remapping
//                       table yet to rewrite a link onto it. Included for
//                       disaster-recovery reference, not auto-restored.
//
// Every query uses the same .catch(() => []) degrade-to-empty pattern as
// the rest of this file.
export interface EntityCoverageSnapshot {
  dataEntities: any[];
  categoryReceipts: any[];
  valueHistory: any[];
  sharesOwned: any[];
  sharesReceived: any[];
  entityLinks: any[];
}

export async function gatherEntityCoverageSnapshot(userId: number): Promise<EntityCoverageSnapshot> {
  const [rawDataEntities, categoryReceipts, valueHistory, sharesOwned, sharesReceived, entityLinks] = await Promise.all([
    rows(db.execute(sql`SELECT * FROM kyc_data_entities WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM vault_category_receipts WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM value_history WHERE user_id = ${userId} ORDER BY created_at DESC`)),
    // owner_id: shares this user granted away on their own entities.
    rows(db.execute(sql`SELECT * FROM vault_shares WHERE owner_id = ${userId}`)),
    // shared_with_user_id: shares someone else granted TO this user.
    rows(db.execute(sql`SELECT * FROM vault_shares WHERE shared_with_user_id = ${userId}`)),
    // Feature 15i — Linked Entities graph, scoped directly by userId (every
    // vault_entity_links row already carries the owning user's id, unlike
    // vault_shares which needs the owner/shared_with split above).
    rows(db.execute(sql`SELECT * FROM vault_entity_links WHERE user_id = ${userId} ORDER BY created_at DESC`)),
  ]);

  const safeDecrypt = (v: string | null): string | null => { try { return decryptField(v); } catch { return v; } };
  const dataEntities = rawDataEntities.map(d => ({ ...d, nid_number: safeDecrypt(d.nid_number) }));

  return { dataEntities, categoryReceipts, valueHistory, sharesOwned, sharesReceived, entityLinks };
}

// ─── Emergency Access (dead-man-switch nominations + grants) ──────────────
// Feature 15j — Vault Backup Coverage Expansion: Emergency Access.
//
// A separate, account-level feature (not entity data — see the "Not
// touched" note in CHANGES_VAULT_BACKUP_ENTITY_COVERAGE.md), but it's still
// this user's own configuration and workflow state, same category as
// profile/walletHub, so it belongs in a full disaster-recovery snapshot too.
//
//   - contactsOwned — `emergency_contacts` this user nominated (userId).
//   - grantsOwned   — `emergency_access_grants` triggered against THIS
//                     user's own vault (ownerUserId).
//   - grantsAsContact — grants where this user is the nominated contact
//                     (resolved via emergency_contacts.contact_user_id,
//                     since emergency_access_grants itself only carries
//                     contact_id, not the contact's own user id) — a grant
//                     this user might need to act on is part of their own
//                     account state too, same "both directions" reasoning
//                     sharesOwned/sharesReceived already use.
//
// Reference-only, same as finance/profile/activity: NOT auto-restored.
// contact_id / owner_user_id would need remapping post-restore same as
// every other cross-row reference above, and access_token_hash rows
// represent a live workflow state (a pending or still-valid grant) — silently
// reinstating one on restore is exactly the kind of "replay old state as if
// it just happened" mistake activity/finance are already excluded for.
export interface EmergencyAccessSnapshot {
  contactsOwned: any[];
  grantsOwned: any[];
  grantsAsContact: any[];
}

export async function gatherEmergencyAccessSnapshot(userId: number): Promise<EmergencyAccessSnapshot> {
  const [contactsOwned, grantsOwned, grantsAsContact] = await Promise.all([
    rows(db.execute(sql`SELECT * FROM emergency_contacts WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM emergency_access_grants WHERE owner_user_id = ${userId}`)),
    rows(db.execute(sql`
      SELECT g.* FROM emergency_access_grants g
      JOIN emergency_contacts c ON c.id = g.contact_id
      WHERE c.contact_user_id = ${userId}
    `)),
  ]);
  return { contactsOwned, grantsOwned, grantsAsContact };
}

/** Re-encrypts nid_number on restore, same convention as reencryptMailboxMessageForRestore/reencryptMailboxTemplateForRestore above. */
export function reencryptDataEntityForRestore(d: Record<string, any>): Record<string, any> {
  return {
    ...d,
    nid_number: d.nid_number != null ? encryptField(String(d.nid_number)) : d.nid_number,
  };
}

// ─── Account & Platform Extras ─────────────────────────────────────────────
// Feature 15m — Vault Backup Coverage Expansion: Account & Platform Extras.
//
// The remaining account-scoped surfaces this app tracks per-user that
// weren't part of the backup blob yet — none of these are "the Vault" in
// any sense, but same as profile/walletHub/emergencyAccess, they're this
// user's own account/workflow state, so a full disaster-recovery snapshot
// should cover them too:
//
//   - notifications      — `notifications`: in-app notification history.
//                           Capped to ACCOUNT_EXTRAS_LIMIT most recent rows,
//                           same unbounded-growth reasoning as
//                           gatherActivitySnapshot's ACTIVITY_TRACE_LIMIT.
//   - referralsMade / referralsReceived — `referrals`: gathered both
//                           directions (referrer_id and referred_id), same
//                           "both directions matter" reasoning
//                           sharesOwned/sharesReceived and
//                           grantsOwned/grantsAsContact already use — a
//                           referral this user was the recipient of is
//                           still part of their own account history.
//   - subscription        — `subscriptions`: this user's billing/plan
//                           state. At most one row (userId is unique on
//                           this table). Contains a CoinGate order id/url,
//                           never a raw payment credential.
//   - supportTickets / supportMessages — `support_tickets` this user
//                           opened, plus every `support_messages` row on
//                           those tickets — resolved via the ticket's own
//                           user_id, same child-table join pattern the
//                           finance/mailbox-attachment queries above use.
//                           Includes support-agent replies, not just this
//                           user's own messages, since the full thread is
//                           what "this ticket" means for recovery purposes.
//   - apiKeys              — `api_keys`: developer API keys, METADATA ONLY.
//                           key_hash is stripped, same reasoning
//                           gatherUserProfileSnapshot already uses for
//                           password_hash — a hash of a bearer secret has
//                           no place in a backup blob that can eventually
//                           be re-decrypted by anyone holding the export
//                           password. name/keyPrefix/type/scopes/timestamps
//                           are just account configuration/audit trail.
//   - passkeys              — `passkey_credentials`: WebAuthn credentials,
//                           included in full. credential_id/public_key are
//                           the PUBLIC half of a key pair the user's own
//                           authenticator holds the private half of (see
//                           schema/passkeys.ts's doc comment) — nothing
//                           here can be used to sign in without the
//                           physical authenticator, same non-secret status
//                           as a Vault entry's non-sensitive fields.
//   - polymarketTrades      — `polymarket_trades`: real-money Polymarket
//                           trade history placed through this user's AYZEN
//                           wallet. Local audit/display log only —
//                           Polymarket's own CLOB remains the source of
//                           truth for live order state.
//
// Every query uses the same .catch(() => []) degrade-to-empty pattern as
// the rest of this file. Reference-only, same treatment as
// finance/profile/activity/entityCoverage/emergencyAccess: included in
// every export/scheduled backup, counted, NEVER auto-restored — a
// notification, a support thread, or a billing/subscription record is
// exactly the kind of "replay old workflow state as if it just happened"
// case activity/emergencyAccess are already excluded for, and re-inserting
// someone's own api_keys/passkeys rows with fresh ids would just create
// dead, unusable credential records (the actual secret behind an api key
// was never stored, and a passkey needs its authenticator physically
// present to ever be created in the first place).
const ACCOUNT_EXTRAS_LIMIT = 2000;

const API_KEY_EXCLUDE = new Set(["key_hash"]);

export interface AccountExtrasSnapshot {
  notifications: any[];
  referralsMade: any[];
  referralsReceived: any[];
  subscription: any | null;
  supportTickets: any[];
  supportMessages: any[];
  apiKeys: any[];
  passkeys: any[];
  polymarketTrades: any[];
}

export async function gatherAccountExtrasSnapshot(userId: number): Promise<AccountExtrasSnapshot> {
  const [
    notifications, referralsMade, referralsReceived, subscriptionRows,
    supportTickets, supportMessages, rawApiKeys, passkeys, polymarketTrades,
  ] = await Promise.all([
    rows(db.execute(sql`
      SELECT * FROM notifications WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${ACCOUNT_EXTRAS_LIMIT}
    `)),
    // referrer_id: referrals this user made (invited someone else in).
    rows(db.execute(sql`SELECT * FROM referrals WHERE referrer_id = ${userId}`)),
    // referred_id: referrals this user was the recipient of.
    rows(db.execute(sql`SELECT * FROM referrals WHERE referred_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM subscriptions WHERE user_id = ${userId} LIMIT 1`)),
    rows(db.execute(sql`SELECT * FROM support_tickets WHERE user_id = ${userId}`)),
    // support_messages carries no user_id of its own — resolved via its
    // parent ticket, same join pattern the finance child tables use.
    rows(db.execute(sql`
      SELECT m.* FROM support_messages m
      JOIN support_tickets t ON t.id = m.ticket_id
      WHERE t.user_id = ${userId}
    `)),
    rows(db.execute(sql`SELECT * FROM api_keys WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM passkey_credentials WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM polymarket_trades WHERE user_id = ${userId}`)),
  ]);

  const apiKeys = rawApiKeys.map(k => {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(k)) {
      if (API_KEY_EXCLUDE.has(key)) continue;
      out[key] = v;
    }
    return out;
  });

  return {
    notifications, referralsMade, referralsReceived,
    subscription: subscriptionRows[0] ?? null,
    supportTickets, supportMessages, apiKeys, passkeys, polymarketTrades,
  };
}

// ─── Team ───────────────────────────────────────────────────────────────────
// Feature 15n — Vault Backup Coverage Expansion: Team & Earning.
//
// Teams (routes/teams.ts) is its own account-scoped feature — a user's
// team memberships, the teams they lead, and everything they've personally
// posted/requested inside a team — same "this user's own data" category as
// walletHub/emergencyAccess/accountExtras, so it now rides along too:
//
//   - teamsOwned          — `teams` rows this user owns (owner_id). The
//                           team's own row (name/description/status/slug),
//                           not the other members' data.
//   - memberships          — `team_members` rows for this user, across
//                           EVERY team they belong to (not just owned ones)
//                           — this is what "which teams am I in, and with
//                           what role/status" means for this user's own
//                           account state.
//   - joinRequestsMade     — `team_join_requests` this user filed (their
//                           own pending/approved/rejected requests to join
//                           a team), not requests other people filed to
//                           join a team this user leads.
//   - favorites            — `team_favorites`: teams this user starred.
//   - messagesSent         — `team_messages` this user posted, across every
//                           team's chat — not the full chat log for teams
//                           this user is merely a member of (that's other
//                           members' data too).
//   - announcementsPosted  — `team_announcements` this user authored
//                           (created_by) — only leaders can post these, so
//                           in practice this is populated for teamsOwned.
//   - missionsCreated      — `team_missions` this user created (created_by)
//                           on a team they lead. Team-wide mission *catalog*
//                           entries a user didn't create are platform/team
//                           data, not this user's own, same reasoning the
//                           projects catalog is excluded for elsewhere in
//                           this file.
//   - teamActivityLegacy   — `team_activity_log`: the pre-Phase-17-audit-fix
//                           bespoke team log (see routes/teams.ts's "Phase
//                           17 audit fix" comment) — nothing writes to it
//                           anymore, but historical rows for events this
//                           user triggered (user_id) are still on disk and
//                           still part of this user's own history.
//   - teamActivityShared   — `activity_log` rows with subject_type='team'
//                           where THIS user was the actor (actor_user_id) —
//                           the current (post-fix) team event log. This
//                           generic table is reused by several other
//                           features too (project-enrollment history, etc.)
//                           but was never itself scoped into any backup
//                           surface before now; this pulls only the
//                           team-subject slice this user personally caused.
//
// Reference-only, same treatment as walletHub/activity/emergencyAccess/
// accountExtras: included in every export/scheduled backup, counted, NEVER
// auto-restored. A restored team_members/teams row would need id-remapping
// for team_id the same as every other cross-row reference in this backup,
// and re-inserting old team chat/announcements/join-request rows would
// replay old workflow state as if it just happened — same mistake the
// activity trail is already excluded for.
//
// Every query uses the same .catch(() => []) degrade-to-empty pattern as
// the rest of this file.
const TEAM_ACTIVITY_LIMIT = 2000;

export interface TeamSnapshot {
  teamsOwned: any[];
  memberships: any[];
  joinRequestsMade: any[];
  favorites: any[];
  messagesSent: any[];
  announcementsPosted: any[];
  missionsCreated: any[];
  teamActivityLegacy: any[];
  teamActivityShared: any[];
}

export async function gatherTeamSnapshot(userId: number): Promise<TeamSnapshot> {
  const [
    teamsOwned, memberships, joinRequestsMade, favorites, messagesSent,
    announcementsPosted, missionsCreated, teamActivityLegacy, teamActivityShared,
  ] = await Promise.all([
    rows(db.execute(sql`SELECT * FROM teams WHERE owner_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM team_members WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM team_join_requests WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM team_favorites WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM team_messages WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM team_announcements WHERE created_by = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM team_missions WHERE created_by = ${userId}`)),
    rows(db.execute(sql`
      SELECT * FROM team_activity_log WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${TEAM_ACTIVITY_LIMIT}
    `)),
    rows(db.execute(sql`
      SELECT * FROM activity_log
      WHERE subject_type = 'team' AND actor_user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${TEAM_ACTIVITY_LIMIT}
    `)),
  ]);
  return {
    teamsOwned, memberships, joinRequestsMade, favorites, messagesSent,
    announcementsPosted, missionsCreated, teamActivityLegacy, teamActivityShared,
  };
}

// ─── Earning ────────────────────────────────────────────────────────────────
// Feature 15n — Vault Backup Coverage Expansion: Team & Earning.
//
// The "Earn" page (pages/user/earn.tsx, routes/earn-links.ts) lets a user
// mint shareable pay-per-click links (`earn_links`) that credit AZN to
// their own wallet on each click. The resulting balance itself
// (`credits.azn_balance`) is already covered by gatherWalletHubSnapshot
// above — what was missing was the links themselves: title, target URL,
// share code, per-click rate, and the running click_count/earned_azn
// counters, i.e. the configuration and performance of this user's own
// earning links, not just the money they produced.
//
// Reference-only, NOT auto-restored: `code` is globally unique
// (routes/earn-links.ts's randomCode()), so a merge-restore re-inserting an
// old code verbatim could collide with a code re-issued to someone else in
// the meantime — same "no safe remap yet" situation valueHistory/
// entityLinks are already excluded for elsewhere in this file.
export interface EarningSnapshot {
  earnLinks: any[];
}

export async function gatherEarningSnapshot(userId: number): Promise<EarningSnapshot> {
  const earnLinks = await rows(db.execute(sql`SELECT * FROM earn_links WHERE user_id = ${userId}`));
  return { earnLinks };
}

// ─── Backup System (self-coverage) ───────────────────────────────────────────
// Feature 15t — Vault Backup Coverage Expansion: the backup system's own
// per-user configuration, so a full disaster-recovery restore from an old
// .ayzenbak can also tell you how YOUR backups were set up — not just what
// they contained:
//
//   - schedule           — this user's vault_backup_schedules row (Feature
//                          15c): frequency/day/hour, whether attachments are
//                          included, which destination is configured, and
//                          the last few run outcomes. `webhookSecret` is
//                          STRIPPED — see WEBHOOK_SECRET_EXCLUDE below; it's
//                          an HMAC signing key, not configuration, and
//                          leaking it into a backup blob (which can itself
//                          be emailed/webhooked/cloud-delivered) would let
//                          anyone who ever obtains one backup forge delivery
//                          payloads for every future one.
//   - cloudConnections    — vault_backup_cloud_connections rows (Feature
//                          15l): provider + accountLabel + folderId only.
//                          `accessToken`/`refreshToken` are STRIPPED — see
//                          CLOUD_CONNECTION_EXCLUDE — those are live OAuth
//                          credentials for the user's own Google Drive/
//                          Dropbox; backing them up would mean a stolen
//                          backup blob grants access to a DIFFERENT
//                          account's cloud storage, not just this app.
//   - deliveries          — vault_backup_deliveries rows (off-vault delivery
//                          audit log): destination/target/status/error per
//                          attempt. `target` is already just an email
//                          address or webhook URL, no secret embedded in it.
//   - auditLog            — this user's own slice of vault_backup_audit_log
//                          (ownerUserId = userId): every security-relevant
//                          backup event, safe by construction since that
//                          table's own write discipline (see
//                          lib/vault-backup-audit.ts's header comment)
//                          already forbids putting secrets in `detail`.
//   - vaultSecurityPosture — a BOOLEAN-ONLY summary of vault_security
//                          (hasVaultPin/hasEntityPin/hasVaultPassword/
//                          vaultTwoFaEnabled/authStepPolicy). Deliberately
//                          NEVER the hash columns themselves: a 4-digit PIN
//                          hash is brute-forceable offline in well under a
//                          second (10,000 possibilities), so unlike a normal
//                          password hash, storing it anywhere ciphertext can
//                          later be decrypted TO is a real credential leak,
//                          not just defense-in-depth. The booleans still let
//                          a restore/audit reviewer see "is this vault PIN-
//                          protected" without ever reconstituting the PIN.
//   - projectTemplates    — ayzen_project_templates rows this user authored
//                          (created_by) — admin/moderator-created prefill
//                          templates for the "Initialize New Protocol"
//                          dialog (see schema/project-templates.ts). Their
//                          own authored content, same category as
//                          announcementsPosted/missionsCreated above.
//
// Reference-only, NOT auto-restored — same treatment as every other nested
// domain in this file: re-inserting a schedule/cloud-connection row from an
// old backup could silently resurrect a stale delivery destination (an
// ex-employee's email, a rotated webhook) without the user explicitly
// choosing to; that's a decision for Settings, not a restore.
const BACKUP_SYSTEM_AUDIT_LIMIT = 500;
const WEBHOOK_SECRET_EXCLUDE = new Set(["webhook_secret"]);
const CLOUD_CONNECTION_EXCLUDE = new Set(["access_token", "refresh_token"]);

function stripKeys(row: Record<string, unknown>, exclude: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(row)) {
    if (exclude.has(key)) continue;
    out[key] = v;
  }
  return out;
}

export interface BackupSystemSnapshot {
  schedule: Record<string, unknown> | null;
  cloudConnections: Record<string, unknown>[];
  deliveries: any[];
  auditLog: any[];
  vaultSecurityPosture: Record<string, unknown> | null;
  projectTemplates: any[];
}

export async function gatherBackupSystemSnapshot(userId: number): Promise<BackupSystemSnapshot> {
  const [
    scheduleRows, cloudRows, deliveries, auditLog, securityRows, projectTemplates,
  ] = await Promise.all([
    rows(db.execute(sql`SELECT * FROM vault_backup_schedules WHERE user_id = ${userId} LIMIT 1`)),
    rows(db.execute(sql`SELECT * FROM vault_backup_cloud_connections WHERE user_id = ${userId}`)),
    rows(db.execute(sql`
      SELECT * FROM vault_backup_deliveries WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${BACKUP_SYSTEM_AUDIT_LIMIT}
    `)),
    rows(db.execute(sql`
      SELECT * FROM vault_backup_audit_log WHERE owner_user_id = ${userId}
      ORDER BY created_at DESC LIMIT ${BACKUP_SYSTEM_AUDIT_LIMIT}
    `)),
    rows(db.execute(sql`SELECT * FROM vault_security WHERE user_id = ${userId} LIMIT 1`)),
    rows(db.execute(sql`SELECT * FROM ayzen_project_templates WHERE created_by = ${userId}`)),
  ]);

  const schedule = scheduleRows[0] ? stripKeys(scheduleRows[0], WEBHOOK_SECRET_EXCLUDE) : null;
  const cloudConnections = cloudRows.map(r => stripKeys(r, CLOUD_CONNECTION_EXCLUDE));
  const sec = securityRows[0] ?? null;
  const vaultSecurityPosture = sec ? {
    hasVaultPin: !!sec.vault_pin_hash,
    hasEntityPin: !!sec.entity_pin_hash,
    hasVaultPassword: !!sec.vault_password_hash,
    vaultTwoFaEnabled: !!sec.vault_two_fa_enabled,
    authStepPolicy: sec.auth_step_policy,
  } : null;

  return { schedule, cloudConnections, deliveries, auditLog, vaultSecurityPosture, projectTemplates };
}

// ─── Email Accounts ─────────────────────────────────────────────────────────
// Feature 15u — Vault Backup Coverage Expansion: Connected Mail Accounts.
//
// The native mailbox (gatherMailboxSnapshot above) covers everything a user
// composed/received/organized *inside* ayzen.tech Mail. It never covered
// email_accounts (lib/db/src/schema/email-accounts.ts) — the external
// IMAP/SMTP mailboxes a user connects (routes/email-accounts.ts) so AYZEN
// can fetch/send through their own existing Gmail/Outlook/custom-domain
// inbox instead of (or alongside) the native one. A disaster-recovery
// restore that rebuilds every native message but can't tell you which
// outside mailboxes you'd wired up, at what host/port, isn't full coverage.
//
// password/authKey are field-encrypted at rest with the same vault-crypto
// primitive (encryptField/decryptField) used for Vault entity fields and
// mailbox template bodies — this table IS the credential, not a live
// bearer token to a system AYZEN itself holds a session with (the
// cloud-connection OAuth tokens and webhook_secret gatherBackupSystemSnapshot
// deliberately excludes above are the latter: AYZEN's own currently-valid
// grant to reach a THIRD PARTY, where a stolen backup blob would grant that
// access wholesale). A connected mailbox's password is exactly the kind of
// secret this app's Vault exists to back up, same as a wallet seed phrase
// (buildVaultSnapshotPayload) or a Vault entity's own sensitive fields — so,
// like those, it's decrypted back into the snapshot rather than stripped.
//
// Scoped to rows this user owns (userId — "who created/owns config edits",
// per email-accounts.ts's own comment), which includes both their personal
// accounts (teamId null) and any team mailbox they personally set up.
// Team-mailbox rows another member configured are that member's own backup,
// not this user's — same "my own slice, not everything I can currently see"
// scoping gatherTeamSnapshot uses elsewhere in this file.
//
// Restored the same additive merge way mailboxContacts/mailboxRules are:
// flattened to a top-level `emailAccounts` array (see the payload key in
// routes/vault-snapshot.ts) and wired into vault-snapshot-restore.ts as
// its own dedicated insert path (reencryptEmailAccountForRestore below,
// same "needs a field re-encrypted on insert" treatment mailbox templates/
// messages and KYC data entities already get, rather than the generic
// RAW_PLANS raw-row path which doesn't re-encrypt anything). Identity key
// is emailAddress + protocol per user — deliberately never password/
// authKey, same "never key off an encrypted column" rule every other
// re-encrypting insert path in this file already follows.
export interface EmailAccountsSnapshot {
  accounts: any[];
}

export async function gatherEmailAccountsSnapshot(userId: number): Promise<EmailAccountsSnapshot> {
  const accountRows = await rows(db.execute(sql`SELECT * FROM email_accounts WHERE user_id = ${userId}`));
  const accounts = accountRows.map(r => ({
    ...r,
    password: r.password ? decryptField(r.password) : null,
    auth_key: r.auth_key ? decryptField(r.auth_key) : null,
  }));
  return { accounts };
}

// Flattened to a top-level array (rather than nested under `emailAccounts`)
// so the same merge-restore mechanism mailboxContacts/mailboxRules already
// use can address these directly — see the RestoreTableKey /
// insertEmailAccountRow addition in vault-snapshot-restore.ts. Restorable
// the same additive way (skip if an existing row's email+protocol already
// matches, otherwise insert): a restore never overwrites or deletes a row
// that's still there, only re-adds one that's genuinely missing, same
// semantics every other RAW_PLANS-style table in this app already has —
// so a since-deleted personal or team-mailbox connection reappearing on
// restore is the same accepted trade-off restoring an old mail rule or
// contact already carries, not a new risk this table introduces.
export function reencryptEmailAccountForRestore(a: Record<string, any>): Record<string, any> {
  return {
    ...a,
    password: a.password != null ? encryptField(String(a.password)) : a.password,
    auth_key: a.auth_key != null ? encryptField(String(a.auth_key)) : a.auth_key,
  };
}

// ─── Mailbox Deliverability & Reputation (Feature 15w) ─────────────────────
// The native mailbox itself (gatherMailboxSnapshot, Feature 15d) covers what
// a user composed/received/organized. It never covered the moderation state
// built on top of it: who they've blocked or allowed as a sender, which of
// their own outbound recipients have been auto-flagged/blocked for bouncing
// or complaining, and whether their own account is currently rate-limited or
// paused for sending too many bad messages. Losing that on a disaster-
// recovery restore means re-discovering your own block list and re-tripping
// every bounce flag you'd already worked through, one bad send at a time.
//
//   - senderReputation    — ayzen_mailbox_sender_reputation: this user's own
//                            Block/Allow decisions on inbound senders (the
//                            screen behind GET /mailbox/senders?status=...),
//                            plus the flood-control counters that feed spam
//                            auto-routing. status is user-curated data, not
//                            just telemetry — the same class of "your own
//                            decision" as a mailbox rule or a saved contact.
//   - recipientReputation — ayzen_mailbox_recipient_reputation: addresses
//                            THIS user has sent to that bounced/complained
//                            enough to be auto-flagged or blocked, gating
//                            POST /send. Also a live moderation decision,
//                            not just a log of what happened.
//   - sendingHealth       — ayzen_mailbox_sending_health: one row per user,
//                            this account's own rolling bounce/complaint
//                            rate and healthy/warning/paused status. Fully
//                            derived/computed (recomputed from live sends,
//                            never something a user edits directly), so it's
//                            backed up for reference the same way
//                            gatherActivitySnapshot's audit trails are, not
//                            because a restore should ever write it back.
//
// Deliberately excluded — same "transient worker state / platform-wide
// admin config" reasoning gatherBackupSystemSnapshot and
// gatherEmailAccountsSnapshot's doc comments already use elsewhere in this
// file:
//   - ayzen_mailbox_send_queue    — a durable outbox for messages already
//     captured in mailboxMessages above; the queue row itself is mid-flight
//     worker state (status/attempts/locked_by) with no lasting value once a
//     send has settled, same class as otp_codes.
//   - ayzen_mailbox_sending_config — a SINGLETON row (id always 1) of
//     admin-tunable platform thresholds, not scoped to any one user at all —
//     same reasoning email/config platform tables are excluded everywhere
//     else in this app's backup.
export interface MailboxReputationSnapshot {
  senderReputation: any[];
  recipientReputation: any[];
  sendingHealth: Record<string, unknown> | null;
}

export async function gatherMailboxReputationSnapshot(userId: number): Promise<MailboxReputationSnapshot> {
  const [senderReputation, recipientReputation, sendingHealthRows] = await Promise.all([
    rows(db.execute(sql`SELECT * FROM ayzen_mailbox_sender_reputation WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM ayzen_mailbox_recipient_reputation WHERE user_id = ${userId}`)),
    rows(db.execute(sql`SELECT * FROM ayzen_mailbox_sending_health WHERE user_id = ${userId}`)),
  ]);
  return { senderReputation, recipientReputation, sendingHealth: sendingHealthRows[0] ?? null };
}

// ─── External Mail Sync Cache (Feature 15x) ─────────────────────────────────
// gatherEmailAccountsSnapshot (Feature 15u) backs up WHICH external IMAP/SMTP
// mailboxes a user connected — host, port, credentials. It never backed up
// the actual synced content sitting in `mail_messages`: the header cache
// (lib/mail-sync.ts's syncAccountInbox) plus any message bodies a user has
// opened and lazily cached (routes/email-accounts.ts's fetch-body handler,
// same encryptField/decryptField-at-rest convention every other cached mail
// body in this app already uses — see gatherMailboxSnapshot's messages
// above). A disaster-recovery restore that reconnects your Gmail but shows
// an empty inbox until the next sync isn't full coverage of what the Email
// Manager page was actually showing you.
//
// Scoped to `user_id = userId` (mail_messages carries its own user_id
// directly, unlike ayzen_mailbox_attachments' via-parent-message join).
// body_text is only ever populated for messages the user has actually
// opened (fetched lazily, not eagerly for the whole inbox) — decrypted here
// the same way gatherMailboxSnapshot decrypts native message bodies, so the
// backup is immediately readable without a second pass against this app's
// own field-encryption keys.
//
// Reference-only, NOT auto-restored — unlike the native mailbox, this table
// is a CACHE of a system of record that lives outside AYZEN entirely (the
// user's actual Gmail/Outlook/IMAP server). Re-inserting stale cached rows
// on restore could resurrect message content the user has since deleted at
// the source, and the correct recovery path is simply re-syncing the
// account (POST /email-accounts/:id/sync) — which rebuilds this cache from
// the live mailbox, not from an old backup. Same "backed up for reference,
// not silently replayed" treatment as finance/profile/activity above.
export interface ExternalMailSnapshot {
  messages: any[];
}

export async function gatherExternalMailSnapshot(userId: number): Promise<ExternalMailSnapshot> {
  const raw = await rows(db.execute(sql`SELECT * FROM mail_messages WHERE user_id = ${userId}`));
  const messages = raw.map(m => ({
    ...m,
    body_text: m.body_text ? (() => { try { return decryptField(m.body_text); } catch { return m.body_text; } })() : m.body_text,
  }));
  return { messages };
}
