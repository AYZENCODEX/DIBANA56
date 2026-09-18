/**
 * lib/mail-sync.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Core "fetch inbox via IMAP → cache into mail_messages" logic, shared by:
 *  - POST /email-accounts/:id/fetch-inbox (manual "Sync" button in the Mail Hub)
 *  - syncAllMailAccounts() — the scheduled auto-sync cron (see index.ts)
 */
import { db, emailAccountsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as imaps from "imap-simple";
import { decryptField } from "./vault-crypto";
import { fetchLatestMessages } from "./imap-fetch";
import { logger } from "./logger";

export interface SyncedMessage {
  uid: number; seqno: number; seen: boolean;
  date: string; from: string; to: string; subject: string;
}

export interface SyncOptions {
  limit?: number;
  mailbox?: string;
  sourceCategory?: string;
  sourceId?: string | number | null;
}

/** Connect to one account's IMAP inbox, fetch the latest N headers, and upsert them into mail_messages. */
export async function syncInbox(
  account: typeof emailAccountsTable.$inferSelect,
  opts: SyncOptions = {}
): Promise<{ messages: SyncedMessage[]; total: number }> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const mailbox = opts.mailbox ?? "INBOX";

  if (!account.imapHost || !(account.password || account.authKey)) {
    throw new Error("IMAP not configured — host and password/auth key required");
  }

  const imapConfig = {
    imap: {
      user: account.username ?? account.emailAddress,
      password: decryptField(account.authKey) || decryptField(account.password),
      host: account.imapHost,
      port: account.imapPort ?? 993,
      tls: account.useSSL !== false,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 15000,
      connTimeout: 15000,
    },
  };

  let connection: any = null;
  try {
    try {
      connection = await (imaps as any).connect(imapConfig);
    } catch (connErr: any) {
      logger.error(
        { accountId: account.id, host: account.imapHost, port: imapConfig.imap.port, err: connErr?.message ?? connErr },
        "[mail-sync] IMAP connect/auth failed",
      );
      throw new Error(`IMAP connect failed for ${account.imapHost}:${imapConfig.imap.port} — ${connErr?.message ?? connErr}`);
    }

    let box: any;
    try {
      box = await connection.openBox(mailbox);
    } catch (boxErr: any) {
      logger.error(
        { accountId: account.id, mailbox, err: boxErr?.message ?? boxErr },
        "[mail-sync] IMAP openBox failed",
      );
      throw new Error(`Could not open mailbox "${mailbox}" — ${boxErr?.message ?? boxErr}`);
    }
    const total = box.messages?.total ?? 0;

    if (total === 0) {
      connection.end();
      return { messages: [], total: 0 };
    }

    const fetchOptions = {
      bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)"],
      struct: false,
      markSeen: false,
    };
    // NOTE: imap-simple has no fetchMessages() method — that was the root
    // cause of this regression (every call threw "connection.fetchMessages
    // is not a function", silently swallowed by syncAllMailAccounts()'s
    // per-account catch block). fetchLatestMessages() uses the library's
    // actual search() API instead. See lib/imap-fetch.ts for details.
    const messages = await fetchLatestMessages(connection, limit, fetchOptions);

    const result: SyncedMessage[] = messages.reverse().map((msg: any) => {
      const headerPart = msg.parts.find((p: any) => p.which.startsWith("HEADER"));
      const hdr = headerPart?.body ?? {};
      const parseAddresses = (raw: string | string[] | undefined): string => {
        if (!raw) return "";
        const s = Array.isArray(raw) ? raw[0] : raw;
        return s.replace(/\r?\n\s*/g, " ").trim();
      };
      return {
        uid: msg.attributes?.uid ?? msg.seqNo,
        seqno: msg.seqNo,
        seen: !!(msg.attributes?.flags ?? []).includes("\\Seen"),
        date: parseAddresses(hdr.date),
        from: parseAddresses(hdr.from),
        to: parseAddresses(hdr.to),
        subject: parseAddresses(hdr.subject) || "(no subject)",
      };
    });

    connection.end();

    const sourceCategory = opts.sourceCategory || "other";
    const sourceId = opts.sourceId != null ? String(opts.sourceId) : null;
    for (const m of result) {
      await db.execute(sql`
        INSERT INTO mail_messages (user_id, email_account_id, source_category, source_id, uid, seqno, from_addr, to_addr, subject, message_date)
        VALUES (${account.userId}, ${account.id}, ${sourceCategory}, ${sourceId}, ${m.uid}, ${m.seqno}, ${m.from}, ${m.to}, ${m.subject}, ${m.date ? new Date(m.date) : null})
        ON CONFLICT (email_account_id, uid) DO UPDATE SET
          seqno = EXCLUDED.seqno,
          source_category = EXCLUDED.source_category,
          source_id = COALESCE(EXCLUDED.source_id, mail_messages.source_id),
          fetched_at = NOW()
      `);
    }

    return { messages: result, total };
  } catch (err: any) {
    try { connection?.end(); } catch { /* ignore */ }
    logger.error({ accountId: account.id, err: err?.message ?? err }, "[mail-sync] syncInbox failed");
    throw err;
  }
}

/**
 * Scheduled auto-sync — called on a timer (see index.ts). Syncs every
 * IMAP-configured account for every user, resolving each account's Vault
 * category/entity by matching its email address against vault_entries,
 * local_accounts, kyc_entries, and game_entries so cached mail lands under
 * the right hierarchy tab. Each account is isolated: one failure (bad
 * credentials, IMAP timeout) never stops the rest of the batch.
 */
export async function syncAllMailAccounts(): Promise<{ synced: number; failed: number }> {
  const accounts = await db.select().from(emailAccountsTable);
  let synced = 0, failed = 0;

  for (const account of accounts) {
    if (!account.imapHost || !(account.password || account.authKey)) continue;
    try {
      const source = await resolveMailSource(account.userId, account.emailAddress);
      await syncInbox(account, { limit: 20, sourceCategory: source?.category, sourceId: source?.id });
      synced++;
    } catch (err: any) {
      // Best-effort — a single account's IMAP failure (bad password, host
      // down, timeout) must never block the rest of the scheduled batch —
      // but it must be logged, or regressions like this one go unnoticed
      // until a user complains mail stopped syncing.
      logger.warn(
        { accountId: account.id, email: account.emailAddress, err: err?.message ?? err },
        "[mail-sync] scheduled sync failed for account",
      );
      failed++;
    }
    // Small stagger so a large account list doesn't hammer the IMAP hosts
    // (and this event loop) all at once.
    await new Promise(r => setTimeout(r, 250));
  }
  return { synced, failed };
}

async function resolveMailSource(userId: number, email: string): Promise<{ category: string; id: number } | null> {
  if (!email) return null;
  const checks: Array<{ table: string; category: string }> = [
    { table: "vault_entries", category: "entity" },
    { table: "local_accounts", category: "local" },
    { table: "kyc_entries", category: "kyc" },
    { table: "game_entries", category: "game" },
  ];
  for (const { table, category } of checks) {
    const r = await db.execute(sql.raw(
      `SELECT id FROM ${table} WHERE user_id = ${userId} AND email = '${email.replace(/'/g, "''")}' LIMIT 1`
    ));
    if (r.rows.length > 0) return { category, id: (r.rows[0] as any).id };
  }
  return null;
}
