// Shared entity-worth calculator — used by vault.tsx (list/view) and vault-entity-dashboard.tsx.
// Total worth = sum of per-platform worth (Twitter/Discord/Telegram) + worth of any "other" platforms.
export type EntryAny = any;

export function computeEntityWorth(entry: EntryAny): number {
  // walletWorthUsd is auto-computed via live RPC balance pull (POST
  // /vault/:id/refresh-wallet-worth) — additive to the manual currentValue so
  // the wallet portion never needs to be typed in by hand.
  let total = (Number(entry?.currentValue) || 0) + (Number(entry?.walletWorthUsd) || 0);
  const nums = [entry?.twitterWorth, entry?.discordWorth, entry?.telegramWorth];
  for (const n of nums) {
    const v = parseFloat(n);
    if (!Number.isNaN(v)) total += v;
  }
  try {
    const others = entry?.otherAccounts ? JSON.parse(entry.otherAccounts) : [];
    if (Array.isArray(others)) {
      for (const o of others) {
        const v = parseFloat(o?.worth);
        if (!Number.isNaN(v)) total += v;
      }
    }
  } catch { /* ignore malformed json */ }
  return total;
}

// Total buy value = sum of per-platform buy value (Twitter/Discord/Telegram) + buy value of any "other" platforms.
// This is the cost spent acquiring the platform accounts — used together with computeEntityWorth (present value)
// to derive PnL (profit = worth - buyValue) on the vault PnL dashboard tabs.
export function computeEntityBuyValue(entry: EntryAny): number {
  let total = Number(entry?.currentBuyValue) || 0;
  const nums = [entry?.twitterBuyValue, entry?.discordBuyValue, entry?.telegramBuyValue];
  for (const n of nums) {
    const v = parseFloat(n);
    if (!Number.isNaN(v)) total += v;
  }
  try {
    const others = entry?.otherAccounts ? JSON.parse(entry.otherAccounts) : [];
    if (Array.isArray(others)) {
      for (const o of others) {
        const v = parseFloat(o?.buyValue);
        if (!Number.isNaN(v)) total += v;
      }
    }
  } catch { /* ignore malformed json */ }
  return total;
}

// Profit ($) = present value (worth) - buy value. Positive = gain, negative = loss.
export function computeEntityProfit(entry: EntryAny): number {
  return computeEntityWorth(entry) - computeEntityBuyValue(entry);
}

// Profit % relative to buy value. Returns null when buy value is 0 (undefined ROI).
export function computeEntityProfitPct(entry: EntryAny): number | null {
  const buyValue = computeEntityBuyValue(entry);
  if (buyValue <= 0) return null;
  return (computeEntityProfit(entry) / buyValue) * 100;
}

// Common "other" platforms — used to pick a sensible metric label (Connections vs Followers) automatically.
const OTHER_PLATFORM_METRIC: Record<string, string> = {
  github: "Connections", linkedin: "Connections",
  reddit: "Followers", instagram: "Followers", tiktok: "Followers", youtube: "Subscribers", facebook: "Followers",
};

export function metricLabelFor(platform: string): string {
  const key = (platform || "").trim().toLowerCase();
  return OTHER_PLATFORM_METRIC[key] ?? "Followers/Connections";
}
