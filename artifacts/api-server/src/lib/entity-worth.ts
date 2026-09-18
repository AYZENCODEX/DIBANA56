/**
 * lib/entity-worth.ts (api-server)
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side mirror of artifacts/ayzen/src/lib/entity-worth.ts. Duplicated
 * rather than shared because the frontend and API server are separate
 * packages with no common "domain logic" workspace lib — kept in lockstep
 * intentionally; if you touch one, touch the other. Used by the Vault
 * Entity public receipt (routes/vault.ts) to compute worth/PnL without a
 * logged-in session's client-side calculation.
 */
type EntryAny = Record<string, any>;

export function computeEntityWorth(entry: EntryAny): number {
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

export function computeEntityProfit(entry: EntryAny): number {
  return computeEntityWorth(entry) - computeEntityBuyValue(entry);
}

export function computeEntityProfitPct(entry: EntryAny): number | null {
  const buyValue = computeEntityBuyValue(entry);
  if (buyValue <= 0) return null;
  return (computeEntityProfit(entry) / buyValue) * 100;
}

// Rough "age" string from a create date, e.g. "3mo", "1.2y" — mirrors
// calcAge() in pages/user/vault-local-detail.tsx so the receipt reads the
// same way the owner sees it in the app.
export function computeAge(dateVal: Date | string | null | undefined): string | null {
  if (!dateVal) return null;
  const d = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return "Today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}
