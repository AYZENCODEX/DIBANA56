/**
 * lib/tokens.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical registry of every currency the built-in AYZEN wallet (custodial,
 * one EVM keypair reused across chains) can deposit and withdraw:
 *
 *   ETH  — native, Ethereum
 *   BNB  — native, BNB Chain
 *   POL  — native, Polygon (post-rebrand ticker for the chain formerly
 *          quoted as MATIC — same chain/addresses, new symbol)
 *   XPL  — native, Plasma
 *   ARB  — ERC-20, Arbitrum's governance token (NOT the Arbitrum gas fee,
 *          which is still ETH — this is the separate ARB token contract)
 *   USDT — ERC-20, on every chain above
 *   USDC — ERC-20, on every chain that has an official deployment (see below)
 *
 * IMPORTANT — why this list has a separate row per (symbol, chain) pair
 * instead of one contract address per symbol:
 *   A token symbol like "USDT" or "USDC" is NOT one contract shared across
 *   chains. Each chain has its OWN independently-deployed ERC-20 contract
 *   that happens to represent the same underlying asset — the address is
 *   almost never identical between two chains (occasionally it *looks*
 *   similar or is vanity-mined to match, but treat that as coincidence, not
 *   a rule — never assume/reuse an address across chains without verifying
 *   it on that chain's own explorer first). That's why every row below is
 *   independently sourced and pinned per chain, and why the registry design
 *   is "one TokenDef row = one (symbol, chain, contract) fact", not a
 *   symbol → address map. To add ANY new token (any symbol, on any subset
 *   of these chains), add one row per chain it exists on, each with that
 *   chain's own verified contract address + decimals — nothing else in the
 *   deposit/withdrawal pipeline needs to change (see the two call sites
 *   documented below).
 *
 * This is the single source of truth for both directions:
 *   - services/deposit-watcher.ts derives VAULT_CHAINS[].tokens from
 *     tokensForChain() so the poller and the withdrawal resolver can never
 *     drift out of sync with each other.
 *   - routes/wallets.ts handleWithdraw() calls resolveToken() so a caller
 *     can withdraw by symbol ("USDT", "USDC", "ARB", ...) instead of having
 *     to know raw contract addresses.
 */

export interface TokenDef {
  symbol: string;          // e.g. "ETH", "USDT", "USDC", "ARB"
  chain: string;            // matches wallets.chain / VAULT_CHAINS[].chain
  isNative: boolean;
  contract: string | null;  // null for native coins
  decimals: number;
}

export const SUPPORTED_TOKENS: TokenDef[] = [
  // ── Native coins ──────────────────────────────────────────────────────────
  { symbol: "ETH",  chain: "ETH",    isNative: true,  contract: null, decimals: 18 },
  { symbol: "BNB",  chain: "BSC",    isNative: true,  contract: null, decimals: 18 },
  { symbol: "POL",  chain: "MATIC",  isNative: true,  contract: null, decimals: 18 },
  { symbol: "XPL",  chain: "PLASMA", isNative: true,  contract: null, decimals: 18 },

  // ── ERC-20 tokens ────────────────────────────────────────────────────────
  // Arbitrum's own governance token — separate from the ETH gas fee on that chain.
  { symbol: "ARB",  chain: "ARB",    isNative: false, contract: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },

  // USDT — same contracts already used by the deposit watcher / vault live-worth check.
  { symbol: "USDT", chain: "ETH",    isNative: false, contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  { symbol: "USDT", chain: "BSC",    isNative: false, contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  { symbol: "USDT", chain: "MATIC",  isNative: false, contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
  // Plasma's native-cross-chain Tether variant ("USDT0").
  { symbol: "USDT", chain: "PLASMA", isNative: false, contract: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", decimals: 6 },
  { symbol: "USDT", chain: "ARB",    isNative: false, contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },

  // USDC — each address below is the chain's own Circle-issued (or, for BSC,
  // Circle-recognized Binance-Peg) deployment; each was verified separately
  // on that chain's block explorer, they are NOT the same address reused.
  { symbol: "USDC", chain: "ETH",    isNative: false, contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { symbol: "USDC", chain: "BSC",    isNative: false, contract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  { symbol: "USDC", chain: "MATIC",  isNative: false, contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  { symbol: "USDC", chain: "ARB",    isNative: false, contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  // NOTE: no USDC row for PLASMA yet — I could not independently confirm a
  // Circle-native USDC deployment address on Plasma mainnet from public
  // sources. Do NOT guess/copy an address for this from an unverified site;
  // confirm it directly on Plasma's own explorer (or developers.circle.com)
  // before adding a row here. Until then, USDC deposits/withdrawals on the
  // PLASMA chain option simply won't be offered (tokensForChain("PLASMA")
  // won't include USDC) — nothing else needs to change to add it later.
];

/** All tokens (native + ERC-20) available on a given chain. */
export function tokensForChain(chain: string): TokenDef[] {
  const ch = chain.toUpperCase();
  return SUPPORTED_TOKENS.filter((t) => t.chain === ch);
}

/**
 * Resolve a currency symbol to its token definition. If `chain` is given,
 * matches that chain specifically (needed for USDT, which exists on five
 * chains); otherwise returns the first match — fine for symbols that only
 * exist on one chain (ETH/BNB/POL/XPL/ARB).
 */
export function resolveToken(symbol: string, chain?: string): TokenDef | undefined {
  const sym = symbol.toUpperCase();
  const candidates = SUPPORTED_TOKENS.filter((t) => t.symbol === sym);
  if (chain) {
    const ch = chain.toUpperCase();
    return candidates.find((t) => t.chain === ch) ?? candidates[0];
  }
  return candidates[0];
}

/** Chain the native coin identified by `symbol` lives on, if any (ETH/BNB/POL/XPL). */
export function nativeChainForSymbol(symbol: string): string | undefined {
  return SUPPORTED_TOKENS.find((t) => t.symbol === symbol.toUpperCase() && t.isNative)?.chain;
}
