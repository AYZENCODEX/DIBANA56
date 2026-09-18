import { Router, type Request, type Response } from "express";
import { db, walletsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { broadcastEvent } from "./events";
import { getUserFromToken, getTokenFromReq } from "../lib/auth-utils";
import { requireAuth, getRequestUser, pepDecisionObserver } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { ethers } from "ethers";
import { encryptPhrase, decryptPhrase } from "../lib/wallet-crypto";
import { resolveToken } from "../lib/tokens";
import { consumeRevealToken, hasNoEntityPin } from "./vault-security";
import { postWithdrawalToFinance } from "../lib/finance-wallet-bridge";

// Public RPC endpoints — no API key required. Swap for a paid/private RPC in production.
const RPC_URLS: Record<string, string> = {
  ETH: "https://cloudflare-eth.com",
  BASE: "https://mainnet.base.org",
  MATIC: "https://polygon-rpc.com",
  BSC: "https://bsc-dataseed.binance.org",
  ARB: "https://arb1.arbitrum.io/rpc",
  OP: "https://mainnet.optimism.io",
  PLASMA: "https://rpc.plasma.to",
};

function getProvider(chain: string): ethers.JsonRpcProvider {
  const url = RPC_URLS[chain.toUpperCase()] ?? RPC_URLS.ETH;
  return new ethers.JsonRpcProvider(url);
}

const router = Router();

function formatWallet(w: typeof walletsTable.$inferSelect) {
  return {
    ...w,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
    lastSyncedAt: w.lastSyncedAt?.toISOString() ?? null,
  };
}

// ─── Route Integration Roadmap — Season C, Phase C7 (mechanical sweep, batch 7) ─
// Same combined-where ownership shape flagged by Phase C5 for a future
// manual audit. Every route below already does its own
// `SELECT ... WHERE id=$1 AND userId=$2` before acting on `:id`, and every
// one returns the exact same `404 { error: "Wallet not found" }` on a miss
// — that scoping/response is unchanged (Rule: don't remove a working
// system). This adds the same SECOND, PDP-routed ownership check Phase
// B1/C1-C6 already add elsewhere.
//
// NOT touched in this phase: `POST /wallets/:id/phrase` and
// `GET /wallets/:id/phrase`. Both already carry their own step-up gate
// (the entity-PIN reveal-token flow, see the comment on the GET route
// below) — the same "assurance + ownership" shape the roadmap's own
// Season B reserves for Phase B2 (Vault), not this mechanical sweep.
// Reordering an ownership check ahead of an existing step-up check would
// change which failure a caller without a reveal token sees first; that's
// a judgment call for whoever picks up Phase B2, not a mechanical one.
const WALLET_OWNER_SENTINEL_NONE = -1;

const walletResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) return { type: "wallet", id: req.params.id, ownerId: WALLET_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: walletsTable.userId }).from(walletsTable)
    .where(eq(walletsTable.id, id)).limit(1);
  return { type: "wallet", id, ownerId: row?.userId ?? WALLET_OWNER_SENTINEL_NONE };
};

function requireWalletOwnership(action: string) {
  return requireOwnership(action, walletResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Wallet not found" });
    },
  });
}

// GET /wallets — list wallets for current user (or userId= for admin)
router.get("/wallets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { userId } = req.query as Record<string, string>;
  const targetId = (authUser.role === "admin" && userId)
    ? parseInt(userId, 10)
    : authUser.userId;

  const wallets = await db.select().from(walletsTable).where(eq(walletsTable.userId, targetId));
  res.json(wallets.map(formatWallet));
});

// POST /wallets — add a new wallet
// PHASE 5 (admin credit console request): adding a wallet is a metered
// action (ryft.wallet_create) — charge-on-success, after the row is
// actually inserted (a duplicate-address 409 above never touches the
// ledger).
router.post("/wallets", requireAuth, requireCreditBalance("ryft.wallet_create"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { address, chain, label, notes, chainId } = req.body as {
    address?: string; chain?: string; label?: string; notes?: string; chainId?: number;
  };
  if (!address) { res.status(400).json({ error: "address is required" }); return; }
  if (!isValidAddress(address, chain ?? "ETH")) {
    res.status(400).json({ error: "Invalid wallet address format" }); return;
  }

  // Check duplicate for this user
  const existing = await db.select({ id: walletsTable.id })
    .from(walletsTable)
    .where(and(eq(walletsTable.userId, authUser.userId), eq(walletsTable.address, address.toLowerCase())));
  if (existing.length > 0) {
    res.status(409).json({ error: "This wallet address is already added" }); return;
  }

  // If first wallet, make primary
  const count = await db.select({ id: walletsTable.id }).from(walletsTable).where(eq(walletsTable.userId, authUser.userId));
  const isPrimary = count.length === 0;

  const [wallet] = await db.insert(walletsTable).values({
    userId: authUser.userId,
    address: address.toLowerCase(),
    chain: (chain ?? "ETH").toUpperCase(),
    label: label?.trim() || `${(chain ?? "ETH").toUpperCase()} Wallet`,
    notes: notes?.trim() || null,
    chainId: chainId ?? getDefaultChainId(chain ?? "ETH"),
    isPrimary,
  }).returning();

  // Update user walletCount
  await db.update(usersTable)
    .set({ walletCount: count.length + 1 })
    .where(eq(usersTable.id, authUser.userId));

  broadcastEvent("wallets_updated", { action: "added", userId: authUser.userId, walletId: wallet.id });
  const charge = await chargeCredits(authUser.userId, "ryft.wallet_create");
  res.status(201).json({ ...formatWallet(wallet), _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
});

// PATCH /wallets/:id — update wallet label/notes/primary
router.patch("/wallets/:id", requireAuth, requireWalletOwnership("wallet.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [existing] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, id), eq(walletsTable.userId, authUser.userId)));
  if (!existing) { res.status(404).json({ error: "Wallet not found" }); return; }

  const updates: Partial<typeof walletsTable.$inferInsert> = {};
  if (req.body.label !== undefined) updates.label = req.body.label;
  if (req.body.notes !== undefined) updates.notes = req.body.notes;
  if (req.body.autoFinanceSync !== undefined) updates.autoFinanceSync = !!req.body.autoFinanceSync;
  if (req.body.isPrimary === true) {
    // Unset all other primaries first
    await db.update(walletsTable).set({ isPrimary: false }).where(eq(walletsTable.userId, authUser.userId));
    updates.isPrimary = true;
  }
  updates.updatedAt = new Date();

  const [updated] = await db.update(walletsTable).set(updates).where(eq(walletsTable.id, id)).returning();
  broadcastEvent("wallets_updated", { action: "updated", userId: authUser.userId, walletId: id });
  res.json(formatWallet(updated));
});

// DELETE /wallets/:id — remove wallet
router.delete("/wallets/:id", requireAuth, requireWalletOwnership("wallet.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [existing] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, id), eq(walletsTable.userId, authUser.userId)));
  if (!existing) { res.status(404).json({ error: "Wallet not found" }); return; }

  await db.delete(walletsTable).where(eq(walletsTable.id, id));

  // Update walletCount
  const remaining = await db.select({ id: walletsTable.id }).from(walletsTable).where(eq(walletsTable.userId, authUser.userId));
  await db.update(usersTable).set({ walletCount: remaining.length }).where(eq(usersTable.id, authUser.userId));

  // If deleted was primary, make first remaining primary
  if (existing.isPrimary && remaining.length > 0) {
    await db.update(walletsTable).set({ isPrimary: true }).where(eq(walletsTable.id, remaining[0].id));
  }

  broadcastEvent("wallets_updated", { action: "deleted", userId: authUser.userId, walletId: id });
  res.json({ success: true });
});

// POST /wallets/:id/sync — refresh on-chain data (mock for now, real integration via Cloudflare)
router.post("/wallets/:id/sync", requireAuth, requireWalletOwnership("wallet.sync"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, id), eq(walletsTable.userId, authUser.userId)));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }

  // Fetch real data from public APIs
  const chainData = await fetchChainData(wallet.address, wallet.chain);
  const updated = await db.update(walletsTable).set({
    balance: chainData.balance,
    balanceUsd: chainData.balanceUsd,
    tokenCount: chainData.tokenCount,
    txCount: chainData.txCount,
    lastSyncedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(walletsTable.id, id)).returning();

  broadcastEvent("wallets_updated", { action: "synced", userId: authUser.userId, walletId: id });
  res.json(formatWallet(updated[0]));
});

// POST /wallets/:id/phrase — save encrypted seed phrase
router.post("/wallets/:id/phrase", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, id), eq(walletsTable.userId, authUser.userId)));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }

  const { phrase } = req.body as { phrase?: string };
  if (!phrase?.trim()) { res.status(400).json({ error: "phrase is required" }); return; }

  const encrypted = encryptPhrase(phrase.trim());
  await db.update(walletsTable).set({ encryptedPhrase: encrypted, updatedAt: new Date() }).where(eq(walletsTable.id, id));
  res.json({ success: true });
});

// GET /wallets/:id/phrase — decrypt and return seed phrase
// Requires a fresh, single-use reveal token minted by a successful entity-PIN
// verify (POST /vault/security/verify, kind="entity") — see
// routes/vault-security.ts. Same fix as GET /vault/:id/seed in routes/vault.ts,
// applied here too: requireAuth alone (i.e. a merely valid/leaked session
// token) previously was enough to pull a plaintext mnemonic with no PIN
// check at all — the PIN gate only ever lived in the frontend UI (and,
// unlike the vault-entity seed page, this route didn't even have that).
// Users who haven't set an entity PIN keep the old "nothing to gate on"
// behavior, same rule as everywhere else this token is checked.
router.get("/wallets/:id/phrase", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const pinless = await hasNoEntityPin(authUser.userId);
  if (!pinless) {
    const token = (req.header("x-reveal-token") ?? req.query.revealToken) as string | undefined;
    if (!consumeRevealToken(authUser.userId, token)) {
      res.status(403).json({
        error: "Reveal token missing or expired",
        code: "REVEAL_TOKEN_REQUIRED",
        solution: "Verify your entity PIN again — the reveal token is single-use and expires quickly.",
      });
      return;
    }
  }

  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, id), eq(walletsTable.userId, authUser.userId)));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }
  if (!wallet.encryptedPhrase) { res.status(404).json({ error: "No phrase saved for this wallet" }); return; }

  try {
    const phrase = decryptPhrase(wallet.encryptedPhrase);
    res.json({ phrase });
  } catch {
    res.status(500).json({ error: "Failed to decrypt phrase" });
  }
});

// POST /wallets/:id/send  (alias: /wallets/:id/withdraw)
// Real withdrawal: decrypts the stored mnemonic just-in-time, signs, and
// broadcasts an on-chain transaction from the user's built-in wallet.
// Body: { to: string, amount: number, token?: string, tokenContract?: string, chain?: string,
//          speed?: "slow"|"medium"|"fast", gasPriceGwei?: number,
//          maxFeePerGasGwei?: number, maxPriorityFeePerGasGwei?: number }
// - `token`: a supported currency symbol (ETH/BNB/POL/XPL/ARB/USDT) — resolved
//   server-side via lib/tokens.ts into the right chain + contract. Preferred
//   over passing a raw contract address by hand.
// - `tokenContract` (advanced/legacy): send an ERC-20 from this exact contract.
// - Neither `token` nor `tokenContract`: sends the target chain's native coin.
// - `speed`: slow/medium/fast fee tier (see lib/gas-health.ts); omitted or
//   "medium" leaves fee selection to the signer/provider, same as before
//   this option existed.
// - `gasPriceGwei` / `maxFeePerGasGwei` / `maxPriorityFeePerGasGwei`: advanced
//   override — an explicit gwei value typed in by the user, which always
//   wins over `speed` when present.
async function handleWithdraw(req: any, res: any): Promise<void> {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, id), eq(walletsTable.userId, authUser.userId)));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }
  if (!wallet.encryptedPhrase) { res.status(400).json({ error: "This wallet has no key material stored — cannot sign a withdrawal" }); return; }

  const { to, amount, token, chain: chainOverride, speed, gasPriceGwei, maxFeePerGasGwei, maxPriorityFeePerGasGwei } = req.body as {
    to?: string; amount?: number; token?: string; chain?: string;
    speed?: "slow" | "medium" | "fast";
    gasPriceGwei?: number; maxFeePerGasGwei?: number; maxPriorityFeePerGasGwei?: number;
  };
  let tokenContract = (req.body as { tokenContract?: string }).tokenContract;
  if (!to?.trim() || !ethers.isAddress(to.trim())) { res.status(400).json({ error: "A valid destination address is required" }); return; }
  if (!amount || amount <= 0) { res.status(400).json({ error: "amount must be > 0" }); return; }

  // The built-in vault wallet's address is the same on every EVM chain it
  // watches (ETH/BSC/Polygon/Plasma/Arbitrum) — let the caller pick which
  // network to broadcast the withdrawal on instead of always using the
  // wallet row's stored chain.
  let sendChain = (chainOverride?.trim() || wallet.chain).toUpperCase();

  // Resolve a currency symbol (ETH/BNB/POL/XPL/ARB/USDT) into its chain +
  // contract, so callers don't need to know raw addresses. An explicit
  // `chain` override still wins for picking which of USDT's five chains.
  if (token?.trim() && !tokenContract) {
    const resolved = resolveToken(token.trim(), chainOverride);
    if (!resolved) { res.status(400).json({ error: `Unsupported currency: ${token}` }); return; }
    sendChain = resolved.chain;
    if (!resolved.isNative) tokenContract = resolved.contract!;
  }

  if (!RPC_URLS[sendChain]) { res.status(400).json({ error: `Unsupported chain: ${sendChain}` }); return; }

  // Fee tier / advanced gwei override — resolved once against the chain's
  // current fee data. {} when nothing was requested (or speed = "medium"),
  // which leaves fee selection to the signer exactly as before this option
  // existed.
  let feeOverrides: import("../lib/gas-health").GasTxOverrides = {};
  try {
    const { resolveGasOverrides } = await import("../lib/gas-health");
    feeOverrides = await resolveGasOverrides(sendChain as any, { speed, gasPriceGwei, maxFeePerGasGwei, maxPriorityFeePerGasGwei });
  } catch {
    // Fall through with no override — withdrawal still proceeds at the
    // signer's default fee rather than failing the whole request over a
    // fee-estimation hiccup.
  }

  let signer: ethers.HDNodeWallet;
  try {
    const mnemonic = decryptPhrase(wallet.encryptedPhrase);
    signer = ethers.Wallet.fromPhrase(mnemonic).connect(getProvider(sendChain)) as ethers.HDNodeWallet;
  } catch {
    res.status(500).json({ error: "Failed to unlock wallet key material" }); return;
  }

  try {
    let tx: ethers.TransactionResponse;
    if (tokenContract?.trim()) {
      if (!ethers.isAddress(tokenContract.trim())) { res.status(400).json({ error: "Invalid token contract address" }); return; }
      const erc20 = new ethers.Contract(
        tokenContract.trim(),
        ["function transfer(address to, uint256 amount) returns (bool)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"],
        signer
      );
      const decimals: number = await erc20.decimals();
      const value = ethers.parseUnits(String(amount), decimals);
      const onChainBal: bigint = await erc20.balanceOf(signer.address);
      if (onChainBal < value) { res.status(400).json({ error: "Insufficient token balance in this wallet" }); return; }
      tx = await erc20.transfer(to.trim(), value, feeOverrides);
    } else {
      const value = ethers.parseEther(String(amount));
      const nativeBal = await signer.provider!.getBalance(signer.address);
      const feeData = await signer.provider!.getFeeData();
      const effectiveGasPriceWei = feeOverrides.gasPrice ?? feeOverrides.maxFeePerGas ?? feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
      const estGas = 21000n * effectiveGasPriceWei;
      if (nativeBal < value + estGas) { res.status(400).json({ error: "Insufficient balance to cover amount + network fee" }); return; }
      tx = await signer.sendTransaction({ to: to.trim(), value, ...feeOverrides });
    }

    const gasPriceGweiUsed = feeOverrides.maxFeePerGas != null
      ? parseFloat(ethers.formatUnits(feeOverrides.maxFeePerGas, "gwei"))
      : feeOverrides.gasPrice != null
      ? parseFloat(ethers.formatUnits(feeOverrides.gasPrice, "gwei"))
      : null;

    broadcastEvent("wallet_send", { userId: authUser.userId, walletId: id, chain: sendChain, to, amount, tokenContract: tokenContract ?? null, txHash: tx.hash });

    // Wallet↔Finance bridge — best-effort, never blocks the response below.
    await postWithdrawalToFinance({
      userId: authUser.userId, walletId: id, chain: sendChain,
      symbol: token?.trim()?.toUpperCase() || sendChain, amount, to: to.trim(), txHash: tx.hash,
    });

    // Charge-on-success (services/credit-meter.ts, ryft.wallet_tx): only
    // after the transaction actually broadcast — an insufficient-balance
    // or signing failure above never costs the user credits.
    const charge = await chargeCredits(authUser.userId, "ryft.wallet_tx");
    res.json({ success: true, status: "broadcast", chain: sendChain, txHash: tx.hash, gasPriceGwei: gasPriceGweiUsed, _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
  } catch (err: any) {
    res.status(500).json({ error: err?.shortMessage ?? err?.message ?? "Failed to broadcast transaction" });
  }
}
// Ownership check comes AFTER `sensitiveWriteLimiter`, not before — keeping
// the pre-existing middleware order intact (Rule: additive, don't reorder
// what's already there) so rate-limit accounting is unaffected by this
// phase. requireCreditBalance (PHASE 5, ryft.wallet_tx) is appended last,
// same reasoning: pre-flight balance check only after every existing gate
// (auth, rate limit, ownership) has already passed.
router.post("/wallets/:id/send", requireAuth, sensitiveWriteLimiter, requireWalletOwnership("wallet.withdraw"), requireCreditBalance("ryft.wallet_tx"), handleWithdraw);
router.post("/wallets/:id/withdraw", requireAuth, sensitiveWriteLimiter, requireWalletOwnership("wallet.withdraw"), requireCreditBalance("ryft.wallet_tx"), handleWithdraw);

// GET /wallets/tokens — get AZN + USDT balances for current user
router.get("/wallets/tokens", async (req, res): Promise<void> => {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = authUser.userId;
  try {
    const creditsResult = await db.execute(
      sql`SELECT azn_balance, balance FROM credits WHERE user_id = ${userId}`
    );
    const credits = (creditsResult.rows[0] as Record<string, unknown>) ?? {};
    const usdtResult = await db.execute(
      sql`SELECT COALESCE(SUM(amount), 0) as usdt FROM builtin_wallet_tokens WHERE user_id = ${userId} AND symbol = 'USDT'`
    );
    const usdt = parseFloat(String((usdtResult.rows[0] as Record<string, unknown>)?.usdt ?? 0));
    res.json({
      azn: parseFloat(String(credits["azn_balance"] ?? 0)),
      credits: parseInt(String(credits["balance"] ?? 0), 10),
      usdt,
    });
  } catch { res.json({ azn: 0, credits: 0, usdt: 0 }); }
});

// POST /wallets/builtin/create — generate a REAL built-in AYZEN wallet for this user
// (EVM-compatible: same address works across ETH/BASE/MATIC/BSC/ARB/OP). The mnemonic
// is encrypted at rest (AES-256-GCM, see encryptPhrase) and stored on the wallets row,
// which is tied to this account via userId → users.username (unique). The plaintext
// mnemonic is returned exactly once, in this response, so the user can back it up —
// it is never returned again except via the explicit GET /wallets/:id/phrase reveal.
router.post("/wallets/builtin/create", async (req, res): Promise<void> => {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = authUser.userId;

  // One built-in wallet per user
  const hasBuiltin = (await db.execute(
    sql`SELECT id FROM wallets WHERE user_id = ${userId} AND label = ${"AYZEN Built-in Wallet"} LIMIT 1`
  )).rows.length > 0;
  if (hasBuiltin) {
    res.status(409).json({ error: "Built-in wallet already exists" }); return;
  }

  // Real EVM keypair — cryptographically random 12-word BIP-39 mnemonic → HD wallet.
  const generated = ethers.Wallet.createRandom();
  const address = generated.address.toLowerCase();
  const mnemonic = generated.mnemonic!.phrase;
  const encryptedPhrase = encryptPhrase(mnemonic);

  const count = await db.select({ id: walletsTable.id }).from(walletsTable).where(eq(walletsTable.userId, userId));
  const isPrimary = count.length === 0;

  const [wallet] = await db.insert(walletsTable).values({
    userId,
    address,
    chain: "ETH",
    label: "AYZEN Built-in Wallet",
    notes: "Real custodial EVM wallet generated by AYZEN. Deposit any EVM chain asset to this address; withdraw via /wallets/:id/withdraw.",
    chainId: 1,
    isPrimary,
    encryptedPhrase,
  }).returning();

  await db.update(usersTable).set({ walletCount: count.length + 1 }).where(eq(usersTable.id, userId));
  broadcastEvent("wallets_updated", { action: "added", userId, walletId: wallet.id });

  // mnemonic is included ONLY in this create response — the user must save it now.
  res.status(201).json({ ...formatWallet(wallet), isBuiltin: true, mnemonic });
});

// GET /wallets/ayzen-balance — all AYZEN token balances for current user
router.get("/wallets/ayzen-balance", async (req, res): Promise<void> => {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = authUser.userId;
  try {
    const cr = await db.execute(sql`SELECT azn_balance, balance, usdt_balance, bdt_balance, xp_balance FROM credits WHERE user_id = ${userId}`);
    const row = (cr.rows[0] as Record<string, unknown>) ?? {};
    res.json({
      azn: parseFloat(String(row.azn_balance ?? 0)),
      credits: parseInt(String(row.balance ?? 0), 10),
      usdt: parseFloat(String(row.usdt_balance ?? 0)),
      bdt: parseFloat(String(row.bdt_balance ?? 0)),
      xp: parseFloat(String(row.xp_balance ?? 0)),
    });
  } catch { res.json({ azn: 0, credits: 0, usdt: 0, bdt: 0, xp: 0 }); }
});

// GET /wallets/transfers — transfer history for current user
router.get("/wallets/transfers", async (req, res): Promise<void> => {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const userId = authUser.userId;
  try {
    const result = await db.execute(sql`
      SELECT wt.*, 
        fu.username as from_username, fu.email as from_email,
        tu.username as to_username, tu.email as to_email
      FROM wallet_transfers wt
      LEFT JOIN users fu ON fu.id = wt.from_user_id
      LEFT JOIN users tu ON tu.id = wt.to_user_id
      WHERE wt.from_user_id = ${userId} OR wt.to_user_id = ${userId}
      ORDER BY wt.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch { res.json([]); }
});

// POST /wallets/transfer — send tokens to another AYZEN user
router.post("/wallets/transfer", sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const fromUserId = authUser.userId;
  const { toUsername, currency, amount, note } = req.body;
  if (!toUsername || !currency || !amount || amount <= 0) {
    res.status(400).json({ error: "toUsername, currency, and amount > 0 are required" }); return;
  }
  const ALLOWED = ["AZN", "USDT", "BDT", "XP"];
  if (!ALLOWED.includes(String(currency).toUpperCase())) {
    res.status(400).json({ error: `Currency must be one of: ${ALLOWED.join(", ")}` }); return;
  }
  const cur = String(currency).toUpperCase();
  const amt = parseFloat(String(amount));
  // Find target user
  const targetResult = await db.execute(sql`SELECT id, username, email FROM users WHERE username = ${toUsername} OR email = ${toUsername} LIMIT 1`);
  if (targetResult.rows.length === 0) { res.status(404).json({ error: "User not found" }); return; }
  const toUser = targetResult.rows[0] as any;
  if (toUser.id === fromUserId) { res.status(400).json({ error: "Cannot transfer to yourself" }); return; }
  // Column map
  const colMap: Record<string, string> = { AZN: "azn_balance", USDT: "usdt_balance", BDT: "bdt_balance", XP: "xp_balance" };
  const col = colMap[cur];

  // Everything below runs on ONE dedicated connection inside a real
  // transaction (drizzle's node-postgres transaction() correctly acquires a
  // single client for the whole callback — unlike calling pool.query("BEGIN")
  // directly, which can scatter BEGIN/COMMIT across different pooled
  // connections and silently break atomicity under load).
  //
  // The deduction itself is a single atomic UPDATE ... WHERE col >= amt,
  // not a "read balance in JS, then write balance - amt" — so even two
  // concurrent transfers from the same sender can't both pass a stale
  // balance check and drive the balance negative; Postgres serializes the
  // two UPDATEs on that row and the second one's WHERE clause simply fails
  // to match once the first has committed its deduction.
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`INSERT INTO credits (user_id, ${col}) VALUES (${fromUserId}, 0) ON CONFLICT (user_id) DO NOTHING`));
      await tx.execute(sql.raw(`INSERT INTO credits (user_id, ${col}) VALUES (${toUser.id}, 0) ON CONFLICT (user_id) DO NOTHING`));

      const deduction = await tx.execute(sql.raw(
        `UPDATE credits SET ${col} = ${col} - ${amt} WHERE user_id = ${fromUserId} AND ${col} >= ${amt}`
      ));
      if (deduction.rowCount === 0) {
        // Either balance changed since the pre-check above, or was never
        // sufficient — bail out and roll back before touching the receiver.
        throw new Error("INSUFFICIENT_BALANCE");
      }

      await tx.execute(sql.raw(`UPDATE credits SET ${col} = ${col} + ${amt} WHERE user_id = ${toUser.id}`));
      await tx.execute(sql`INSERT INTO wallet_transfers (from_user_id, to_user_id, currency, amount, note) VALUES (${fromUserId}, ${toUser.id}, ${cur}, ${amt}, ${note ?? null})`);
      return { toUsername: toUser.username ?? toUser.email };
    });

    res.json({ success: true, currency: cur, amount: amt, to: result.toUsername });
  } catch (err: any) {
    if (err?.message === "INSUFFICIENT_BALANCE") {
      res.status(400).json({ error: `Insufficient ${cur} balance` });
      return;
    }
    res.status(500).json({ error: "Transfer failed", detail: err?.message });
  }
});

// GET /wallets/stats — aggregated stats for current user
router.get("/wallets/stats", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const wallets = await db.select().from(walletsTable).where(eq(walletsTable.userId, authUser.userId));
  const totalUsd = wallets.reduce((s, w) => s + (w.balanceUsd ?? 0), 0);
  const chains = [...new Set(wallets.map(w => w.chain))];
  res.json({
    count: wallets.length,
    totalUsd,
    chains,
    primary: wallets.find(w => w.isPrimary) ?? null,
  });
});

// GET /wallets/vault-chains — networks + currencies the vault wallet
// supports for real-time deposit detection and withdrawal. The built-in
// wallet uses one EVM address across all of them, so the frontend uses this
// to build one "network + currency" picker instead of hardcoding the list.
router.get("/wallets/vault-chains", async (_req, res): Promise<void> => {
  const { VAULT_CHAINS } = await import("../services/deposit-watcher");
  res.json(VAULT_CHAINS.map(c => ({
    chain: c.chain,
    nativeSymbol: c.nativeSymbol,
    chainId: c.chainId,
    confirmationsRequired: c.confirmationsRequired,
    // contract addresses are public on-chain data — safe to expose, and the
    // frontend needs them to build MetaMask ERC-20 transfers client-side.
    tokens: c.tokens.map(t => ({ symbol: t.symbol, decimals: t.decimals, contract: t.contract })),
  })));
});

// GET /wallets/gas-overview — gas (native-coin) health for the user's
// built-in AYZEN wallet, one chain at a time, with a real-time simulation:
// live gas price + how many more native sends / ERC-20 transfers (USDT,
// USDC, ARB, ...) the current balance can still cover before it runs dry.
// Powers the "Gas" tab on Wallet Hub → Overview.
router.get("/wallets/gas-overview", async (req, res): Promise<void> => {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.userId, authUser.userId), eq(walletsTable.label, "AYZEN Built-in Wallet")));
  if (!wallet) { res.status(404).json({ error: "No built-in wallet yet — create one first" }); return; }

  try {
    const { getGasOverview } = await import("../lib/gas-health");
    const { VAULT_CHAINS } = await import("../services/deposit-watcher");
    // Same one EVM address, checked on every chain the built-in wallet
    // actually watches for deposits/withdrawals (lib/tokens.ts-derived) —
    // not the broader 6-chain set entities use, since a chain this wallet
    // doesn't support has nothing meaningful to show here.
    const chains = VAULT_CHAINS.map((c) => c.chain) as any;
    const overview = await getGasOverview([wallet.address], chains);
    res.json({
      address: wallet.address,
      totalUsd: overview.totalUsd,
      risk: overview.worstRisk,
      chains: overview.snapshots,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Unable to load gas overview", detail: err?.message });
  }
});

// GET /wallets/gas-price?chain=ETH — live slow/medium/fast fee tiers for one
// chain (current network fee × a fixed multiplier per tier), plus the
// estimated native-coin + USD cost of a plain send at each tier. Powers the
// speed picker in the Transfer/Withdraw dialog; the "Advanced" gwei fields
// in that dialog are typed by the user directly and don't need this endpoint.
router.get("/wallets/gas-price", async (req, res): Promise<void> => {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }

  const chain = String((req.query.chain as string) || "ETH").toUpperCase();
  if (!RPC_URLS[chain]) { res.status(400).json({ error: `Unsupported chain: ${chain}` }); return; }

  try {
    const { getGasPriceEstimate } = await import("../lib/gas-health");
    const estimate = await getGasPriceEstimate(chain as any);
    res.json(estimate);
  } catch (err: any) {
    res.status(500).json({ error: "Unable to load gas price", detail: err?.message });
  }
});

// GET /wallets/deposits — recent real-time deposits across all of the user's
// wallets (pending + confirmed), newest first.
router.get("/wallets/deposits", async (req, res): Promise<void> => {
  const tokenStr = getTokenFromReq(req);
  const authUser = tokenStr ? await getUserFromToken(tokenStr) : null;
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const result = await db.execute(sql`
      SELECT * FROM chain_deposits WHERE user_id = ${authUser.userId} ORDER BY created_at DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch { res.json([]); }
});

// GET /wallets/:id/deposits — deposit history for one wallet
router.get("/wallets/:id/deposits", requireAuth, requireWalletOwnership("wallet.deposits.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [wallet] = await db.select().from(walletsTable)
    .where(and(eq(walletsTable.id, id), eq(walletsTable.userId, authUser.userId)));
  if (!wallet) { res.status(404).json({ error: "Wallet not found" }); return; }
  try {
    const result = await db.execute(sql`
      SELECT * FROM chain_deposits WHERE wallet_id = ${id} ORDER BY created_at DESC LIMIT 100
    `);
    res.json(result.rows);
  } catch { res.json([]); }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidAddress(address: string, chain: string): boolean {
  const ch = chain.toUpperCase();
  if (["ETH", "BSC", "MATIC", "ARB", "OP", "BASE", "AVAX", "FTM", "LINEA", "ZKSYNC", "SCROLL", "PLASMA"].includes(ch)) {
    return /^0x[0-9a-fA-F]{40}$/.test(address);
  }
  if (ch === "SOL") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (ch === "BTC") return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address);
  if (ch === "TRX") return /^T[0-9A-Za-z]{33}$/.test(address);
  // Default: allow any non-empty
  return address.trim().length > 5;
}

function getDefaultChainId(chain: string): number | null {
  const map: Record<string, number> = {
    ETH: 1, BSC: 56, MATIC: 137, ARB: 42161, OP: 10, BASE: 8453,
    AVAX: 43114, FTM: 250, LINEA: 59144, ZKSYNC: 324, SCROLL: 534352, PLASMA: 9745,
  };
  return map[chain.toUpperCase()] ?? null;
}

// Chain → coingecko id, for the RPC-fallback USD estimate below.
const COINGECKO_IDS: Record<string, string> = {
  ETH: "ethereum", ARB: "ethereum", OP: "ethereum", BASE: "ethereum",
  MATIC: "matic-network", BSC: "binancecoin", PLASMA: "plasma",
};

async function fetchChainData(address: string, chain: string): Promise<{
  balance: number; balanceUsd: number; tokenCount: number; txCount: number;
}> {
  const ch = chain.toUpperCase();
  try {
    // Etherscan-compatible endpoint for native balance, where one exists.
    const apiMap: Record<string, string> = {
      ETH: "https://api.etherscan.io/api",
      MATIC: "https://api.polygonscan.com/api",
      BSC: "https://api.bscscan.com/api",
      ARB: "https://api.arbiscan.io/api",
      OP: "https://api-optimistic.etherscan.io/api",
      BASE: "https://api.basescan.org/api",
    };
    const base = apiMap[ch];
    if (base) {
      const r = await fetch(`${base}?module=account&action=balance&address=${address}&tag=latest`);
      const d = await r.json() as { status: string; result: string };
      if (d.status === "1") {
        const balance = parseInt(d.result, 10) / 1e18;
        return { balance: parseFloat(balance.toFixed(6)), balanceUsd: parseFloat((balance * (await nativePriceUsd(ch))).toFixed(2)), tokenCount: 0, txCount: 0 };
      }
    }
  } catch { /* fall through to RPC read below */ }

  // No Etherscan-clone available for this chain (e.g. PLASMA) — read the
  // balance straight from the RPC node instead.
  try {
    const provider = getProvider(ch);
    const wei = await provider.getBalance(address);
    const balance = parseFloat(ethers.formatEther(wei));
    return { balance, balanceUsd: parseFloat((balance * (await nativePriceUsd(ch))).toFixed(2)), tokenCount: 0, txCount: 0 };
  } catch { /* fallback below */ }
  return { balance: 0, balanceUsd: 0, tokenCount: 0, txCount: 0 };
}

async function nativePriceUsd(chain: string): Promise<number> {
  const id = COINGECKO_IDS[chain.toUpperCase()];
  if (!id) return 0;
  try {
    const priceR = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    const priceD = await priceR.json() as Record<string, { usd?: number }>;
    return priceD?.[id]?.usd ?? 0;
  } catch { return 0; }
}

export default router;
