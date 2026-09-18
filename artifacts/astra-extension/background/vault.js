// background/vault.js
// ─────────────────────────────────────────────────────────────────────────
// Fetches the user's Sylo vault entries (GET /vault — same endpoint the web
// app's vault list page uses) and matches them against the hostname a
// content script reports, so Astra only ever offers autofill for the
// handful of fields Astra v1 is scoped to: platform logins (Twitter/X,
// Discord, Telegram) and the primary recovery-email login for known
// webmail providers.
//
// Deliberately NOT included, per the master plan's Astra security
// principle: seed phrases, 2FA codes, backup codes, wallet addresses. Those
// stay reveal-on-demand inside the Sylo app itself — this file never reads
// those fields off a vault entry at all, so there's nothing here to leak
// even in a bug.
//
// Cache lives in chrome.storage.session — in-memory only, wiped when the
// browser closes, never written to disk. That's a deliberate trade-off:
// decrypted credentials sit in memory for a short-lived cache window
// instead of being refetched on every keystroke, but never persist.

import { getConfig } from "./config.js";
import { getSessionToken } from "./session.js";

const CACHE_KEY = "astra_vault_cache_v1";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — short enough that a revoked/edited credential doesn't linger long, long enough to avoid refetching per-keystroke.

const EMAIL_PROVIDER_HOSTS = [
  "mail.google.com", "gmail.com",
  "outlook.live.com", "outlook.office.com", "outlook.office365.com",
  "mail.yahoo.com",
  "mail.proton.me", "account.proton.me",
  "icloud.com",
  "mail.aol.com",
];

// Ordered: first matching platform wins. Each entry declares which vault
// fields are the fillable username/password pair for that surface.
const MATCHERS = [
  {
    kind: "twitter",
    label: "Twitter / X",
    test: (host) => /(^|\.)x\.com$/.test(host) || /(^|\.)twitter\.com$/.test(host),
    usernameKey: "twitterUsername",
    passwordKey: "twitterPassword",
  },
  {
    kind: "discord",
    label: "Discord",
    test: (host) => /(^|\.)discord\.com$/.test(host),
    usernameKey: "discordUsername",
    passwordKey: "discordPassword",
  },
  {
    kind: "telegram",
    label: "Telegram",
    test: (host) => /(^|\.)web\.telegram\.org$/.test(host) || /(^|\.)telegram\.org$/.test(host),
    usernameKey: "telegramUsername",
    passwordKey: "telegramPassword",
  },
  {
    kind: "email",
    label: "Recovery email",
    test: (host) => EMAIL_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)),
    usernameKey: "email",
    passwordKey: "emailPassword",
  },
];

export function matcherForHostname(hostname) {
  return MATCHERS.find((m) => m.test(hostname)) ?? null;
}

async function readCache() {
  const store = await chrome.storage.session.get(CACHE_KEY);
  const cached = store[CACHE_KEY];
  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
  return cached.entries;
}

async function writeCache(entries) {
  await chrome.storage.session.set({ [CACHE_KEY]: { entries, fetchedAt: Date.now() } });
}

export async function clearVaultCache() {
  await chrome.storage.session.remove(CACHE_KEY);
}

/** Fetches (or returns cached) vault entries. Returns [] if signed out or the request fails. */
export async function getVaultEntries({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await readCache();
    if (cached) return cached;
  }

  const token = await getSessionToken();
  if (!token) return [];

  const { apiBase } = await getConfig();
  try {
    const res = await fetch(`${apiBase}/vault`, {
      method: "GET",
      credentials: "include",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const entries = await res.json();
    await writeCache(entries);
    return entries;
  } catch (err) {
    console.warn("[astra] vault fetch failed", err);
    return [];
  }
}

/**
 * Returns the lightweight match summary a content script is allowed to see
 * for a given hostname — entry id, project name, and platform username
 * (usernames aren't secret; passwords are withheld until fillCredential()).
 */
export async function getMatchesForHostname(hostname) {
  const matcher = matcherForHostname(hostname);
  if (!matcher) return { matcher: null, matches: [] };

  const entries = await getVaultEntries();
  const matches = entries
    .filter((e) => e[matcher.usernameKey] && e[matcher.passwordKey])
    .map((e) => ({
      entryId: e.id,
      projectName: e.projectName || "(untitled)",
      username: e[matcher.usernameKey],
    }));

  return { matcher: { kind: matcher.kind, label: matcher.label }, matches };
}

/** Returns the actual {username, password} pair for one entry — only called on explicit user fill-click. */
export async function fillCredential(entryId, hostname) {
  const matcher = matcherForHostname(hostname);
  if (!matcher) return null;

  const entries = await getVaultEntries();
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) return null;

  const username = entry[matcher.usernameKey];
  const password = entry[matcher.passwordKey];
  if (!username || !password) return null;

  return { username, password };
}
