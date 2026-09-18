import { Router, type Request, type Response } from "express";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireAdmin, requireRoles, pepDecisionObserver } from "../middlewares/auth";
import crypto from "crypto";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

// ── Plan / type config ──────────────────────────────────────────────────────

const PLAN_AZN_COST: Record<string, number> = {
  pro: 30,
  enterprise: 60,
  lifetime_pro: 500,
  lifetime_enterprise: 1000,
  username: 50,
  achievement_badge: 0,
};

const PLAN_DURATION_DAYS: Record<string, number> = {
  pro: 30,
  enterprise: 30,
  lifetime_pro: 36500, // ~100 years = lifetime
  lifetime_enterprise: 36500,
  username: 36500,
  achievement_badge: 36500,
};

function planToCategory(plan: string): string {
  if (plan === "username") return "username";
  if (plan === "achievement_badge") return "badge";
  if (plan.startsWith("lifetime")) return "lifetime_pass";
  return "subscription_pass";
}

function planToNftType(plan: string): string {
  if (plan === "username") return "username";
  if (plan === "achievement_badge") return "achievement_badge";
  if (plan === "lifetime_pro" || plan === "lifetime_enterprise") return "lifetime_pass";
  return "subscription_pass";
}

function generateTokenId(): string {
  return "AYZEN-" + crypto.randomBytes(8).toString("hex").toUpperCase();
}

// ── SVG image generation ──────────────────────────────────────────────────────

function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

function generateNftImage(plan: string, opts: {
  username?: string;
  badgeName?: string;
  tokenId?: string;
}): string {
  const { username = "user", badgeName = "Pioneer", tokenId = "AYZEN-0000" } = opts;
  const short = tokenId.slice(-8);

  switch (plan) {
    case "username": return svgToDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#040812"/><stop offset="100%" stop-color="#0a1628"/></linearGradient>
        <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00d4cc"/><stop offset="100%" stop-color="#0088cc"/></linearGradient>
        <filter id="gf"><feGaussianBlur in="SourceGraphic" stdDeviation="4"/></filter>
      </defs>
      <rect width="400" height="400" rx="24" fill="url(#bg)"/>
      <rect x="2" y="2" width="396" height="396" rx="22" fill="none" stroke="url(#glow)" stroke-width="2" opacity="0.8"/>
      <rect x="8" y="8" width="384" height="384" rx="18" fill="none" stroke="#00d4cc" stroke-width="0.5" opacity="0.3"/>
      <circle cx="200" cy="140" r="50" fill="#041a2a" stroke="#00d4cc" stroke-width="2"/>
      <text x="200" y="155" text-anchor="middle" font-family="monospace" font-size="36" font-weight="bold" fill="#00d4cc">${username.slice(0, 1).toUpperCase()}</text>
      <text x="200" y="210" text-anchor="middle" font-family="monospace" font-size="22" font-weight="bold" fill="#ffffff">@${username.length > 12 ? username.slice(0, 12) + "…" : username}</text>
      <text x="200" y="240" text-anchor="middle" font-family="monospace" font-size="10" fill="#00d4cc" opacity="0.7">USERNAME · NFT</text>
      <rect x="60" y="270" width="280" height="1" fill="#00d4cc" opacity="0.2"/>
      <text x="200" y="300" text-anchor="middle" font-family="monospace" font-size="9" fill="#4a8090" letter-spacing="2">AYZEN PLATFORM</text>
      <text x="200" y="320" text-anchor="middle" font-family="monospace" font-size="8" fill="#334455">${short}</text>
      <circle cx="30" cy="30" r="3" fill="#00d4cc" opacity="0.4"/>
      <circle cx="370" cy="30" r="3" fill="#00d4cc" opacity="0.4"/>
      <circle cx="30" cy="370" r="3" fill="#00d4cc" opacity="0.4"/>
      <circle cx="370" cy="370" r="3" fill="#00d4cc" opacity="0.4"/>
    </svg>`);

    case "achievement_badge": return svgToDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0a0800"/><stop offset="100%" stop-color="#1a1200"/></linearGradient>
        <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffd700"/><stop offset="50%" stop-color="#ffaa00"/><stop offset="100%" stop-color="#ff8800"/></linearGradient>
        <linearGradient id="badge-bg" cx="50%" cy="50%" r="50%" fx="50%" fy="50%"><stop offset="0%" stop-color="#2a1800"/><stop offset="100%" stop-color="#1a0e00"/></linearGradient>
      </defs>
      <rect width="400" height="400" rx="24" fill="url(#bg)"/>
      <rect x="2" y="2" width="396" height="396" rx="22" fill="none" stroke="url(#gold)" stroke-width="2" opacity="0.8"/>
      <polygon points="200,50 218,105 278,105 230,138 248,193 200,160 152,193 170,138 122,105 182,105" fill="url(#gold)" opacity="0.9"/>
      <circle cx="200" cy="230" r="70" fill="#1a1200" stroke="url(#gold)" stroke-width="3"/>
      <circle cx="200" cy="230" r="62" fill="none" stroke="#ffaa00" stroke-width="0.5" stroke-dasharray="4,4" opacity="0.5"/>
      <text x="200" y="222" text-anchor="middle" font-family="monospace" font-size="11" font-weight="bold" fill="#ffd700" letter-spacing="1">ACHIEVEMENT</text>
      <text x="200" y="242" text-anchor="middle" font-family="monospace" font-size="13" font-weight="bold" fill="#ffffff">${badgeName.length > 12 ? badgeName.slice(0, 12) : badgeName}</text>
      <text x="200" y="260" text-anchor="middle" font-family="monospace" font-size="9" fill="#ffaa00" opacity="0.6">BADGE · NFT</text>
      <text x="200" y="320" text-anchor="middle" font-family="monospace" font-size="8" fill="#443300" letter-spacing="2">AYZEN · ${short}</text>
    </svg>`);

    case "pro": return svgToDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#040d14"/><stop offset="100%" stop-color="#071a28"/></linearGradient>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00d4cc"/><stop offset="100%" stop-color="#0066cc"/></linearGradient>
      </defs>
      <rect width="400" height="400" rx="24" fill="url(#bg)"/>
      <rect x="0" y="0" width="400" height="120" rx="24" fill="url(#accent)" opacity="0.12"/>
      <rect x="2" y="2" width="396" height="396" rx="22" fill="none" stroke="#00d4cc" stroke-width="2" opacity="0.6"/>
      <text x="200" y="70" text-anchor="middle" font-family="monospace" font-size="52" fill="#00d4cc" opacity="0.15">⚡</text>
      <text x="200" y="90" text-anchor="middle" font-family="monospace" font-size="14" font-weight="bold" fill="#00d4cc" letter-spacing="6">PRO PASS</text>
      <rect x="40" y="110" width="320" height="1" fill="#00d4cc" opacity="0.2"/>
      <text x="200" y="165" text-anchor="middle" font-family="monospace" font-size="64" fill="#00d4cc" opacity="0.08">⚡</text>
      <text x="200" y="200" text-anchor="middle" font-family="monospace" font-size="11" fill="#ffffff" opacity="0.7">SUBSCRIPTION PASS</text>
      <text x="200" y="230" text-anchor="middle" font-family="monospace" font-size="11" fill="#00d4cc" opacity="0.5">30-DAY ACCESS · TRADEABLE</text>
      <rect x="60" y="290" width="100" height="40" rx="8" fill="#041a2a" stroke="#00d4cc" stroke-width="1" opacity="0.8"/>
      <text x="110" y="308" text-anchor="middle" font-family="monospace" font-size="8" fill="#00d4cc" opacity="0.6">TIER</text>
      <text x="110" y="323" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#00d4cc">PRO</text>
      <rect x="240" y="290" width="100" height="40" rx="8" fill="#041a2a" stroke="#00d4cc" stroke-width="1" opacity="0.8"/>
      <text x="290" y="308" text-anchor="middle" font-family="monospace" font-size="8" fill="#00d4cc" opacity="0.6">PLATFORM</text>
      <text x="290" y="323" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#00d4cc">AYZEN</text>
      <text x="200" y="362" text-anchor="middle" font-family="monospace" font-size="8" fill="#223344" letter-spacing="2">${short}</text>
    </svg>`);

    case "enterprise": return svgToDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0a0414"/><stop offset="100%" stop-color="#130828"/></linearGradient>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#6d28d9"/></linearGradient>
      </defs>
      <rect width="400" height="400" rx="24" fill="url(#bg)"/>
      <rect x="0" y="0" width="400" height="120" rx="24" fill="url(#accent)" opacity="0.12"/>
      <rect x="2" y="2" width="396" height="396" rx="22" fill="none" stroke="#a855f7" stroke-width="2" opacity="0.6"/>
      <text x="200" y="90" text-anchor="middle" font-family="monospace" font-size="14" font-weight="bold" fill="#a855f7" letter-spacing="4">ENTERPRISE PASS</text>
      <rect x="40" y="110" width="320" height="1" fill="#a855f7" opacity="0.2"/>
      <text x="200" y="200" text-anchor="middle" font-family="monospace" font-size="11" fill="#ffffff" opacity="0.7">SUBSCRIPTION PASS</text>
      <text x="200" y="230" text-anchor="middle" font-family="monospace" font-size="11" fill="#a855f7" opacity="0.5">30-DAY ACCESS · TRADEABLE</text>
      <rect x="60" y="290" width="100" height="40" rx="8" fill="#150a28" stroke="#a855f7" stroke-width="1" opacity="0.8"/>
      <text x="110" y="308" text-anchor="middle" font-family="monospace" font-size="8" fill="#a855f7" opacity="0.6">TIER</text>
      <text x="110" y="323" text-anchor="middle" font-family="monospace" font-size="9" font-weight="bold" fill="#a855f7">ENTERPRISE</text>
      <rect x="240" y="290" width="100" height="40" rx="8" fill="#150a28" stroke="#a855f7" stroke-width="1" opacity="0.8"/>
      <text x="290" y="308" text-anchor="middle" font-family="monospace" font-size="8" fill="#a855f7" opacity="0.6">PLATFORM</text>
      <text x="290" y="323" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#a855f7">AYZEN</text>
      <text x="200" y="362" text-anchor="middle" font-family="monospace" font-size="8" fill="#2a1444" letter-spacing="2">${short}</text>
    </svg>`);

    case "lifetime_pro": return svgToDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#020a08"/><stop offset="100%" stop-color="#081a14"/></linearGradient>
        <linearGradient id="holo" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#00ffd0"/>
          <stop offset="25%" stop-color="#00ccff"/>
          <stop offset="50%" stop-color="#7c3aed"/>
          <stop offset="75%" stop-color="#00ffd0"/>
          <stop offset="100%" stop-color="#00ccff"/>
        </linearGradient>
        <linearGradient id="shimmer" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#00ffd0" stop-opacity="0.3"/><stop offset="50%" stop-color="#ffffff" stop-opacity="0.1"/><stop offset="100%" stop-color="#00ffd0" stop-opacity="0.3"/></linearGradient>
      </defs>
      <rect width="400" height="400" rx="24" fill="url(#bg)"/>
      <rect x="2" y="2" width="396" height="396" rx="22" fill="none" stroke="url(#holo)" stroke-width="3" opacity="0.9"/>
      <rect x="6" y="6" width="388" height="388" rx="18" fill="none" stroke="url(#holo)" stroke-width="0.5" opacity="0.3"/>
      <rect x="0" y="140" width="400" height="60" fill="url(#shimmer)" opacity="0.6"/>
      <text x="200" y="80" text-anchor="middle" font-family="monospace" font-size="11" fill="#00ffd0" letter-spacing="8" opacity="0.8">∞ LIFETIME PASS ∞</text>
      <rect x="40" y="100" width="320" height="1" fill="url(#holo)" opacity="0.4"/>
      <text x="200" y="170" text-anchor="middle" font-family="monospace" font-size="20" font-weight="bold" fill="url(#holo)">LIFETIME</text>
      <text x="200" y="200" text-anchor="middle" font-family="monospace" font-size="32" font-weight="bold" fill="url(#holo)">PRO</text>
      <text x="200" y="230" text-anchor="middle" font-family="monospace" font-size="11" fill="#00ffd0" opacity="0.5">NEVER EXPIRES · TRADEABLE</text>
      <rect x="40" y="260" width="320" height="1" fill="url(#holo)" opacity="0.4"/>
      <text x="200" y="295" text-anchor="middle" font-family="monospace" font-size="10" fill="#00ffd0" opacity="0.7">AYZEN PLATFORM · GENESIS PASS</text>
      <text x="200" y="340" text-anchor="middle" font-family="monospace" font-size="24" fill="url(#holo)" opacity="0.2">♾</text>
      <text x="200" y="370" text-anchor="middle" font-family="monospace" font-size="8" fill="#1a4a3a" letter-spacing="2">${short}</text>
    </svg>`);

    case "lifetime_enterprise": return svgToDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0a0206"/><stop offset="100%" stop-color="#180410"/></linearGradient>
        <linearGradient id="royal" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffd700"/>
          <stop offset="30%" stop-color="#ff6eb4"/>
          <stop offset="60%" stop-color="#a855f7"/>
          <stop offset="100%" stop-color="#ffd700"/>
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="24" fill="url(#bg)"/>
      <rect x="2" y="2" width="396" height="396" rx="22" fill="none" stroke="url(#royal)" stroke-width="3" opacity="0.9"/>
      <rect x="6" y="6" width="388" height="388" rx="18" fill="none" stroke="url(#royal)" stroke-width="0.5" opacity="0.3"/>
      <text x="200" y="80" text-anchor="middle" font-family="monospace" font-size="10" fill="#ffd700" letter-spacing="6" opacity="0.8">∞ LIFETIME PASS ∞</text>
      <rect x="40" y="100" width="320" height="1" fill="url(#royal)" opacity="0.4"/>
      <text x="200" y="170" text-anchor="middle" font-family="monospace" font-size="18" font-weight="bold" fill="url(#royal)">LIFETIME</text>
      <text x="200" y="210" text-anchor="middle" font-family="monospace" font-size="22" font-weight="bold" fill="url(#royal)">ENTERPRISE</text>
      <text x="200" y="240" text-anchor="middle" font-family="monospace" font-size="10" fill="#ffd700" opacity="0.5">NEVER EXPIRES · FULL ACCESS</text>
      <rect x="40" y="265" width="320" height="1" fill="url(#royal)" opacity="0.4"/>
      <text x="200" y="300" text-anchor="middle" font-family="monospace" font-size="10" fill="#ffd700" opacity="0.7">AYZEN PLATFORM · DIAMOND PASS</text>
      <text x="200" y="350" text-anchor="middle" font-family="monospace" font-size="28" fill="url(#royal)" opacity="0.15">◆</text>
      <text x="200" y="372" text-anchor="middle" font-family="monospace" font-size="8" fill="#3a1428" letter-spacing="2">${short}</text>
    </svg>`);

    default: return svgToDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
      <rect width="400" height="400" rx="24" fill="#040812"/>
      <rect x="2" y="2" width="396" height="396" rx="22" fill="none" stroke="#00d4cc" stroke-width="2" opacity="0.5"/>
      <text x="200" y="210" text-anchor="middle" font-family="monospace" font-size="16" fill="#00d4cc">AYZEN NFT</text>
      <text x="200" y="240" text-anchor="middle" font-family="monospace" font-size="10" fill="#334455">${short}</text>
    </svg>`);
  }
}

// ── Metadata ──────────────────────────────────────────────────────────────────

function generateNftMetadata(plan: string, userId: number, tokenId: string, opts: { username?: string; badgeName?: string } = {}) {
  const cat = planToCategory(plan);
  const names: Record<string, string> = {
    pro: "AYZEN Pro Pass",
    enterprise: "AYZEN Enterprise Pass",
    lifetime_pro: "AYZEN Lifetime Pro Pass",
    lifetime_enterprise: "AYZEN Lifetime Enterprise Pass",
    username: `AYZEN @${opts.username ?? "user"} Username NFT`,
    achievement_badge: `AYZEN ${opts.badgeName ?? "Pioneer"} Badge`,
  };
  return {
    name: names[plan] ?? `AYZEN ${plan} NFT`,
    description: `Tradeable AYZEN NFT — ${plan.replace(/_/g, " ")} category.`,
    plan,
    category: cat,
    token_id: tokenId,
    minted_for: userId,
    minted_at: new Date().toISOString(),
    username: opts.username,
    badge_name: opts.badgeName,
    attributes: [
      { trait_type: "Tier", value: plan.replace(/_/g, " ").toUpperCase() },
      { trait_type: "Category", value: cat.replace(/_/g, " ").toUpperCase() },
      { trait_type: "Platform", value: "AYZEN" },
    ],
  };
}

// ── Shared mint helper — used by manual /mint route AND auto-mint on subscription purchase ──

export async function mintNftForUser(opts: {
  userId: number;
  plan: string;
  badgeName?: string;
  username?: string;
  deductAzn?: boolean; // false when AZN was already charged by the caller (e.g. subscription purchase)
}): Promise<{ nft: any; aznSpent: number; expiresAt: Date }> {
  const { userId, plan, badgeName, deductAzn = true } = opts;

  const validPlans = Object.keys(PLAN_AZN_COST);
  if (!validPlans.includes(plan)) {
    throw new Error(`Invalid plan. Choose: ${validPlans.join(", ")}`);
  }

  const userRow = await pool.query("SELECT username FROM users WHERE id = $1", [userId]);
  const username = opts.username ?? userRow.rows[0]?.username ?? "user";

  const aznCost = deductAzn ? PLAN_AZN_COST[plan] : 0;
  const tokenId = generateTokenId();
  const imageUrl = generateNftImage(plan, { username, badgeName: badgeName ?? "Pioneer", tokenId });
  const metadata = generateNftMetadata(plan, userId, tokenId, { username, badgeName: badgeName ?? "Pioneer" });
  const durationDays = PLAN_DURATION_DAYS[plan] ?? 30;
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
  const nftType = planToNftType(plan);
  const nftCategory = planToCategory(plan);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (aznCost > 0) {
      const balResult = await client.query(
        "SELECT azn_balance FROM credits WHERE user_id = $1 FOR UPDATE",
        [userId]
      );
      const azn = parseFloat(balResult.rows[0]?.azn_balance ?? "0");
      if (azn < aznCost) {
        await client.query("ROLLBACK");
        throw new Error(`Insufficient AZN. Need ${aznCost} AZN, have ${azn.toFixed(2)}`);
      }
    }

    // Prevent duplicate username NFTs
    if (plan === "username") {
      const dup = await client.query(
        "SELECT id FROM nft_subscriptions WHERE owner_id = $1 AND plan = 'username' AND is_burned = FALSE",
        [userId]
      );
      if (dup.rows.length > 0) {
        await client.query("ROLLBACK");
        throw new Error("You already own a Username NFT");
      }
    }

    if (aznCost > 0) {
      await client.query(
        "UPDATE credits SET azn_balance = azn_balance - $1, updated_at = NOW() WHERE user_id = $2",
        [aznCost, userId]
      );
    }

    // Mint NFT
    const nftResult = await client.query(
      `INSERT INTO nft_subscriptions (
        token_id, owner_id, original_owner_id, plan, metadata, expires_at,
        is_listed, list_price, is_burned, nft_type, nft_category, image_url, badge_name
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, FALSE, NULL, FALSE, $7, $8, $9, $10) RETURNING *`,
      [tokenId, userId, userId, plan, JSON.stringify(metadata), expiresAt.toISOString(),
        nftType, nftCategory, imageUrl, badgeName ?? null]
    );
    const nft = nftResult.rows[0];

    // Activate subscription for subscription passes
    if (["pro", "enterprise", "lifetime_pro", "lifetime_enterprise"].includes(plan)) {
      await client.query(
        `INSERT INTO subscriptions (user_id, plan, status, expires_at)
         VALUES ($1, $2, 'active', $3)
         ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, status = 'active', expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
        [userId, plan, expiresAt.toISOString()]
      );
    }

    if (aznCost > 0) {
      await client.query(
        "INSERT INTO credit_transactions (user_id, type, method, azn_amount, status, notes) VALUES ($1, 'nft_mint', 'azn', $2, 'completed', $3)",
        [userId, aznCost, `Minted ${plan} NFT: ${tokenId}`]
      );
    }

    // Log to marketplace activity
    await client.query(
      `INSERT INTO marketplace_activity_log (event_type, actor_id, actor_username, target_id, target_type, title, details, amount_azn, status)
       VALUES ('nft_mint', $1, $2, $3, 'nft', $4, $5, $6, 'completed')`,
      [userId, username, nft.id, `Minted ${plan.replace(/_/g, " ")} NFT`, tokenId, aznCost]
    ).catch(() => {});

    await client.query("COMMIT");
    return { nft, aznSpent: aznCost, expiresAt };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── POST /nft-subscriptions/mint — kept for lifetime passes (one-off AZN purchase = mint) ──

router.post("/nft-subscriptions/mint", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { plan, badge_name } = req.body as { plan?: string; badge_name?: string };

  if (!plan) { res.status(400).json({ error: "plan is required" }); return; }

  try {
    const { nft, aznSpent, expiresAt } = await mintNftForUser({ userId, plan, badgeName: badge_name });
    res.status(201).json({ success: true, nft, aznSpent, expiresAt });
  } catch (err: any) {
    const status = /insufficient|already own/i.test(err?.message ?? "") ? 400 : 500;
    res.status(status).json({ error: err?.message ?? "Minting failed" });
  }
});

// ── GET /nft-subscriptions/my-nfts ───────────────────────────────────────────

router.get("/nft-subscriptions/my-nfts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const result = await db.execute(sql`
    SELECT ns.*, u.username AS original_owner_username
    FROM nft_subscriptions ns
    LEFT JOIN users u ON u.id = ns.original_owner_id
    WHERE ns.owner_id = ${userId} AND ns.is_burned = FALSE
    ORDER BY ns.minted_at DESC
  `);
  res.json(result.rows);
});

// ── GET /nft-subscriptions/marketplace ───────────────────────────────────────

router.get("/nft-subscriptions/marketplace", requireAuth, async (req, res): Promise<void> => {
  const { plan, nft_type, category } = req.query as Record<string, string>;
  try {
    let q = `
      SELECT ns.*, u.username AS seller_username, u.avatar_url AS seller_avatar
      FROM nft_subscriptions ns
      JOIN users u ON u.id = ns.owner_id
      WHERE ns.is_listed = TRUE AND ns.is_burned = FALSE
    `;
    const params: unknown[] = [];
    if (plan && plan !== "all") { params.push(plan); q += ` AND ns.plan = $${params.length}`; }
    if (nft_type) { params.push(nft_type); q += ` AND ns.nft_type = $${params.length}`; }
    if (category) { params.push(category); q += ` AND ns.nft_category = $${params.length}`; }
    q += " ORDER BY ns.list_price ASC, ns.minted_at DESC LIMIT 60";
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ── POST /nft-subscriptions/:id/list ─────────────────────────────────────────

// `nft_subscriptions` has one owner column (`owner_id`) — plain
// single-owner shape, same as everywhere else in this series. Matches
// the file's own `pool.query` + `$1/$2` style for these three routes.
// `POST /:id/buy` is deliberately NOT gated here — its `owner_id ===
// buyerId` check is an inverse "not your own listing" business rule on
// someone ELSE's resource, not "is this MY resource", the same class of
// check this series has left ungated in marketplace offers/listings buy
// flows throughout.
const NFT_SUBSCRIPTION_OWNER_SENTINEL_NONE = -1;
const nftSubscriptionResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (Number.isNaN(id)) return { type: "nft_subscription", id: req.params.id, ownerId: NFT_SUBSCRIPTION_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT owner_id FROM nft_subscriptions WHERE id=$1 LIMIT 1", [id]);
  return { type: "nft_subscription", id, ownerId: rows[0]?.owner_id ?? NFT_SUBSCRIPTION_OWNER_SENTINEL_NONE };
};
function requireNftSubscriptionOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, nftSubscriptionResource, { onDecision: pepDecisionObserver, onDeny });
}

router.post("/nft-subscriptions/:id/list", requireAuth, requireNftSubscriptionOwnership("nft_subscription.list", (_req, res) => { res.status(404).json({ error: "NFT not found, not yours, or already listed" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const nftId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { price, market_payment_method = "azn", market_payment_details = null } = req.body as {
    price?: number; market_payment_method?: string; market_payment_details?: string | null;
  };

  if (!price || price <= 0) { res.status(400).json({ error: "price must be > 0 AZN" }); return; }

  const result = await pool.query(
    "SELECT id FROM nft_subscriptions WHERE id = $1 AND owner_id = $2 AND is_burned = FALSE AND is_listed = FALSE",
    [nftId, userId]
  );
  if (result.rows.length === 0) { res.status(404).json({ error: "NFT not found, not yours, or already listed" }); return; }

  await pool.query(
    `UPDATE nft_subscriptions
     SET is_listed = TRUE, list_price = $1, market_payment_method = $2, market_payment_details = $3
     WHERE id = $4 AND owner_id = $5`,
    [price, market_payment_method, market_payment_details ?? null, nftId, userId]
  );

  const userRow = await pool.query("SELECT username FROM users WHERE id = $1", [userId]);
  await pool.query(
    `INSERT INTO marketplace_activity_log (event_type, actor_id, actor_username, target_id, target_type, title, amount_azn, status)
     VALUES ('nft_listed', $1, $2, $3, 'nft', 'NFT Listed for Sale', $4, 'active')`,
    [userId, userRow.rows[0]?.username ?? "user", nftId, price]
  ).catch(() => {});

  res.json({ success: true, listed: true, price, market_payment_method, market_payment_details });
});

// ── POST /nft-subscriptions/:id/delist ───────────────────────────────────────

router.post("/nft-subscriptions/:id/delist", requireAuth, requireNftSubscriptionOwnership("nft_subscription.delist", (_req, res) => { res.json({ success: true }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const nftId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await pool.query(
    "UPDATE nft_subscriptions SET is_listed = FALSE, list_price = NULL WHERE id = $1 AND owner_id = $2",
    [nftId, userId]
  );
  res.json({ success: true });
});

// ── POST /nft-subscriptions/:id/buy ──────────────────────────────────────────

router.post("/nft-subscriptions/:id/buy", requireAuth, async (req, res): Promise<void> => {
  const buyerId = req.user!.userId;
  const nftId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const nftResult = await client.query(
      "SELECT * FROM nft_subscriptions WHERE id = $1 AND is_listed = TRUE AND is_burned = FALSE FOR UPDATE",
      [nftId]
    );
    const nft = nftResult.rows[0];
    if (!nft) { await client.query("ROLLBACK"); res.status(404).json({ error: "NFT not listed or not found" }); return; }
    if (nft.owner_id === buyerId) { await client.query("ROLLBACK"); res.status(400).json({ error: "Cannot buy your own NFT" }); return; }

    const price = parseFloat(nft.list_price);
    const sellerId = nft.owner_id;
    const planKey = nft.plan as string;

    await client.query("INSERT INTO credits (user_id, azn_balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING", [buyerId]);
    const buyerBalRes = await client.query("SELECT azn_balance FROM credits WHERE user_id = $1 FOR UPDATE", [buyerId]);
    const buyerAzn = parseFloat(buyerBalRes.rows[0]?.azn_balance ?? "0");
    if (buyerAzn < price) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Insufficient AZN. Need ${price}, have ${buyerAzn.toFixed(2)}` }); return;
    }

    await client.query("UPDATE credits SET azn_balance = azn_balance - $1, updated_at = NOW() WHERE user_id = $2", [price, buyerId]);
    await client.query("INSERT INTO credits (user_id, azn_balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING", [sellerId]);
    await client.query("UPDATE credits SET azn_balance = azn_balance + $1, updated_at = NOW() WHERE user_id = $2", [price, sellerId]);

    const isLifetime = planKey.startsWith("lifetime");
    const newExpiry = new Date(Date.now() + (isLifetime ? 36500 : (PLAN_DURATION_DAYS[planKey] ?? 30)) * 24 * 60 * 60 * 1000);

    await client.query(
      `UPDATE nft_subscriptions SET owner_id = $1, is_listed = FALSE, list_price = NULL, expires_at = $2, transfer_count = transfer_count + 1 WHERE id = $3`,
      [buyerId, newExpiry.toISOString(), nftId]
    );

    if (["pro", "enterprise", "lifetime_pro", "lifetime_enterprise"].includes(planKey)) {
      const sellerOthers = await client.query(
        "SELECT id FROM nft_subscriptions WHERE owner_id = $1 AND plan = $2 AND is_burned = FALSE LIMIT 1",
        [sellerId, planKey]
      );
      if (sellerOthers.rows.length === 0) {
        await client.query("UPDATE subscriptions SET plan = 'free', status = 'active', updated_at = NOW() WHERE user_id = $1", [sellerId]);
      }
      await client.query(
        `INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES ($1, $2, 'active', $3)
         ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, status = 'active', expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
        [buyerId, planKey, newExpiry.toISOString()]
      );
    }

    // Log activity
    const buyerRow = await client.query("SELECT username FROM users WHERE id = $1", [buyerId]);
    await client.query(
      `INSERT INTO marketplace_activity_log (event_type, actor_id, actor_username, target_id, target_type, title, amount_azn, status)
       VALUES ('nft_sold', $1, $2, $3, 'nft', 'NFT Purchased', $4, 'completed')`,
      [buyerId, buyerRow.rows[0]?.username ?? "user", nftId, price]
    ).catch(() => {});

    await client.query("COMMIT");
    res.json({ success: true, plan: planKey, tokenId: nft.token_id, aznSpent: price, expiresAt: newExpiry });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: "Purchase failed", detail: err?.message });
  } finally {
    client.release();
  }
});

// ── GET /nft-subscriptions/stats ─────────────────────────────────────────────

router.get("/nft-subscriptions/stats", async (_req, res): Promise<void> => {
  try {
    const [total, listed, volume, byType] = await Promise.all([
      pool.query("SELECT COUNT(*) AS count FROM nft_subscriptions WHERE is_burned = FALSE"),
      pool.query("SELECT COUNT(*) AS count FROM nft_subscriptions WHERE is_listed = TRUE AND is_burned = FALSE"),
      pool.query("SELECT COALESCE(SUM(list_price), 0) AS vol FROM nft_subscriptions WHERE transfer_count > 0 AND is_burned = FALSE"),
      pool.query("SELECT nft_type, COUNT(*) as count FROM nft_subscriptions WHERE is_burned = FALSE GROUP BY nft_type"),
    ]);
    const typeMap: Record<string, number> = {};
    for (const row of byType.rows) { typeMap[row.nft_type ?? "subscription_pass"] = parseInt(row.count); }
    res.json({
      totalMinted: parseInt(total.rows[0]?.count ?? "0"),
      listed: parseInt(listed.rows[0]?.count ?? "0"),
      tradingVolume: parseFloat(volume.rows[0]?.vol ?? "0"),
      byType: typeMap,
    });
  } catch {
    res.json({ totalMinted: 0, listed: 0, tradingVolume: 0, byType: {} });
  }
});

// ── GET /nft-subscriptions/categories — dynamic categories ───────────────────
router.get("/nft-subscriptions/categories", async (_req, res): Promise<void> => {
  try {
    const r = await pool.query(
      "SELECT * FROM nft_market_categories WHERE is_active = TRUE ORDER BY id ASC"
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /nft-subscriptions/categories — admin: add category ─────────────────
router.post("/nft-subscriptions/categories", requireAuth, requireRoles("admin", "dev"), async (req, res): Promise<void> => {
  const { name, label, color = "text-primary", icon = "gem" } = req.body;
  if (!name || !label) { res.status(400).json({ error: "name and label required" }); return; }
  try {
    const r = await pool.query(
      "INSERT INTO nft_market_categories (name, label, color, icon, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [name.toLowerCase().replace(/\s+/g, "_"), label, color, icon, req.user!.userId]
    );
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /nft-subscriptions/categories/:id — admin: remove category ─────────
router.delete("/nft-subscriptions/categories/:id", requireAuth, requireRoles("admin", "dev"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    await pool.query("UPDATE nft_market_categories SET is_active = FALSE WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: GET /admin/nft-market-categories — every category, active + inactive ─
// Powers pages/admin/marketplace-categories.tsx (the public /categories route
// above only returns is_active rows, which hides disabled ones from the
// management table).
router.get("/admin/nft-market-categories", requireAuth, requireRoles("admin", "dev"), async (_req, res): Promise<void> => {
  try {
    const r = await pool.query("SELECT * FROM nft_market_categories ORDER BY id ASC");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: PATCH /admin/nft-market-categories/:id — edit label/color/icon/active ─
router.patch("/admin/nft-market-categories/:id", requireAuth, requireRoles("admin", "dev"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { label, color, icon, is_active } = req.body as {
    label?: string; color?: string; icon?: string; is_active?: boolean;
  };
  try {
    const r = await pool.query(
      `UPDATE nft_market_categories
       SET label = COALESCE($1, label), color = COALESCE($2, color), icon = COALESCE($3, icon),
           is_active = COALESCE($4, is_active)
       WHERE id = $5 RETURNING *`,
      [label ?? null, color ?? null, icon ?? null, is_active ?? null, id]
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Update list endpoint to store payment_method + payment_details ─────────────
// (handled by existing /nft-subscriptions/:id/list — we just pass the extra fields through)

// ── ADMIN: GET /admin/nft-subscriptions — all NFTs ──────────────────────────

router.get("/admin/nft-subscriptions", requireAuth, requireRoles("admin", "dev"), async (_req, res): Promise<void> => {
  try {
    const r = await pool.query(`
      SELECT ns.*, u.username as owner_username, ou.username as original_owner_username
      FROM nft_subscriptions ns
      LEFT JOIN users u ON u.id = ns.owner_id
      LEFT JOIN users ou ON ou.id = ns.original_owner_id
      WHERE ns.is_burned = FALSE
      ORDER BY ns.minted_at DESC LIMIT 200
    `);
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
