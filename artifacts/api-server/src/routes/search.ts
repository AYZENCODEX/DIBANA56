import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

// GET /search?q=... — global search across projects, tasks, users, and all Vault sections
router.get("/search", requireAuth, async (req, res): Promise<void> => {
  const q = ((req.query.q as string) ?? "").trim();
  if (!q || q.length < 2) {
    res.json({ projects: [], users: [], tasks: [], entities: [], local: [], kyc: [], game: [], mail: [], finance: [], wallets: [], marketplace: [] });
    return;
  }

  const isAdmin = req.user?.role === "admin";
  const userId = req.user!.userId;
  const like = `%${q}%`;

  const [projectRows, taskRows, entityRows, localRows, kycRows, gameRows, mailRows, financeRows, walletRows, marketplaceRows] = await Promise.all([
    db.execute(sql`
      SELECT id, name, category, status, tier FROM projects
      WHERE LOWER(name) LIKE LOWER(${like}) OR LOWER(category) LIKE LOWER(${like}) LIMIT 6
    `),
    db.execute(sql`
      SELECT t.id, t.name, t.category, t.task_category, p.name as project_name
      FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      WHERE LOWER(t.name) LIKE LOWER(${like}) LIMIT 6
    `),
    db.execute(sql`
      SELECT v.id, v.project_name, v.category, v.email
      FROM vault_entries v
      WHERE v.user_id = ${userId}
        AND (LOWER(v.project_name) LIKE LOWER(${like}) OR LOWER(COALESCE(v.email,'')) LIKE LOWER(${like})
             OR LOWER(COALESCE(v.twitter_username,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(v.discord_username,'')) LIKE LOWER(${like})
             OR LOWER(COALESCE(v.telegram_username,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(v.entity_serial,'')) LIKE LOWER(${like}))
      LIMIT 6
    `),
    db.execute(sql`
      SELECT id, label, username, email, category
      FROM local_accounts
      WHERE user_id = ${userId}
        AND (LOWER(COALESCE(label,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(username,'')) LIKE LOWER(${like})
             OR LOWER(COALESCE(email,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(category,'')) LIKE LOWER(${like}))
      LIMIT 6
    `),
    db.execute(sql`
      SELECT id, name, username, email, platform, category
      FROM kyc_entries
      WHERE user_id = ${userId}
        AND (LOWER(COALESCE(name,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(username,'')) LIKE LOWER(${like})
             OR LOWER(COALESCE(email,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(platform,'')) LIKE LOWER(${like})
             OR LOWER(COALESCE(category,'')) LIKE LOWER(${like}))
      LIMIT 6
    `),
    db.execute(sql`
      SELECT id, username, email, category, rank
      FROM game_entries
      WHERE user_id = ${userId}
        AND (LOWER(COALESCE(username,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(email,'')) LIKE LOWER(${like})
             OR LOWER(COALESCE(category,'')) LIKE LOWER(${like}))
      LIMIT 6
    `),
    db.execute(sql`
      SELECT id, email_account_id, source_category, source_id, subject, from_addr, message_date
      FROM mail_messages
      WHERE user_id = ${userId}
        AND (LOWER(COALESCE(subject,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(from_addr,'')) LIKE LOWER(${like}))
      ORDER BY message_date DESC NULLS LAST
      LIMIT 6
    `),
    // Ryft — finance ledger entries (Phase 7: unified search federation)
    db.execute(sql`
      SELECT id, title, kind, status, currency, amount
      FROM finance_ledger_entries
      WHERE user_id = ${userId}
        AND (LOWER(COALESCE(title,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(kind,'')) LIKE LOWER(${like}))
      LIMIT 6
    `),
    // Ryft — wallets (Phase 7: unified search federation)
    db.execute(sql`
      SELECT id, label, address, chain, balance_usd
      FROM wallets
      WHERE user_id = ${userId}
        AND (LOWER(COALESCE(label,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(address,'')) LIKE LOWER(${like})
             OR LOWER(COALESCE(chain,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(notes,'')) LIKE LOWER(${like}))
      LIMIT 6
    `),
    // Verve — marketplace listings (Phase 7: unified search federation).
    // Deliberately scoped to the user's own listings + active listings
    // anyone can see (not other sellers' non-active listings), same
    // "search only what you're allowed to see" posture as the vault/local/
    // kyc/game sections above being user_id-scoped.
    db.execute(sql`
      SELECT id, title, listing_type, price_azn, status
      FROM marketplace_listings
      WHERE (seller_id = ${userId} OR status = 'active')
        AND (LOWER(COALESCE(title,'')) LIKE LOWER(${like}) OR LOWER(COALESCE(description,'')) LIKE LOWER(${like}))
      LIMIT 6
    `),
  ]);

  let userRows: any[] = [];
  if (isAdmin) {
    const result = await db.execute(sql`
      SELECT id, username, email, role, status FROM users
      WHERE LOWER(username) LIKE LOWER(${like}) OR LOWER(email) LIKE LOWER(${like}) LIMIT 6
    `);
    userRows = result.rows as any[];
  }

  res.json({
    projects: projectRows.rows,
    users: userRows,
    tasks: taskRows.rows,
    entities: entityRows.rows,
    local: localRows.rows,
    kyc: kycRows.rows,
    game: gameRows.rows,
    mail: mailRows.rows,
    finance: financeRows.rows,
    wallets: walletRows.rows,
    marketplace: marketplaceRows.rows,
  });
});

export default router;
