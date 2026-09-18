// background/session.js
// ─────────────────────────────────────────────────────────────────────────
// Reads the AYZEN Account session the same way every *.ayzen.tech subdomain
// does — via the shared `ayzen_session` cookie (lib/session-cookie.ts on the
// server). It's httpOnly, so a content script on an arbitrary page can never
// see it; only this background/service-worker context can, via the
// chrome.cookies API (host_permissions already limits this to *.ayzen.tech).
//
// We never forward the raw token to a content script. Content scripts only
// ever receive per-site *match summaries* and, on explicit user click, the
// two field values needed to fill a login form — never the session token
// itself. See content-script.js for the boundary.

import { getConfig } from "./config.js";

const SESSION_COOKIE_NAME = "ayzen_session";

/** Reads the raw session cookie value, or null if signed out / not found. */
export async function getSessionToken() {
  const { cookieDomain } = await getConfig();
  try {
    // getAll (rather than get) because the cookie's Domain attribute may be
    // the bare apex (".ayzen.tech") while different subdomains issued it —
    // getAll(domain:) matches by registrable domain regardless of which
    // exact host set it.
    const cookies = await chrome.cookies.getAll({ domain: cookieDomain, name: SESSION_COOKIE_NAME });
    const cookie = cookies.find((c) => c.value) ?? null;
    return cookie ? cookie.value : null;
  } catch (err) {
    console.warn("[astra] cookie read failed", err);
    return null;
  }
}

/**
 * Confirms the token is actually a live session (not just present-but-
 * expired) by hitting GET /auth/me, and returns the account's display info
 * for the popup's status indicator.
 */
export async function fetchAccountStatus() {
  const token = await getSessionToken();
  if (!token) return { signedIn: false, user: null };

  const { apiBase } = await getConfig();
  try {
    const res = await fetch(`${apiBase}/auth/me`, {
      method: "GET",
      credentials: "include",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { signedIn: false, user: null };
    const user = await res.json();
    return { signedIn: true, user };
  } catch (err) {
    console.warn("[astra] /auth/me check failed", err);
    return { signedIn: false, user: null };
  }
}
