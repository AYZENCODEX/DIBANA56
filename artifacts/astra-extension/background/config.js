// background/config.js
// ─────────────────────────────────────────────────────────────────────────
// Astra talks to the same AYZEN Account session every *.ayzen.tech subdomain
// already shares (master plan §4, Option A — shared cookie domain). These
// two values are the only things that differ between prod and a local/dev
// deployment (e.g. a Replit preview domain before ayzen.tech DNS exists),
// so they're kept in chrome.storage.sync (small, synced across the user's
// browsers) instead of hardcoded, mirroring how the web app reads
// SYLO_HOSTS / AYZEN_COOKIE_DOMAIN from env rather than baking them in.

export const DEFAULTS = {
  // Root the API/session lives on. Vault reads go to `${apiBase}/vault`,
  // session check to `${apiBase}/auth/me`.
  apiBase: "https://ayzen.tech",
  // Cookie domain the AYZEN session cookie (`ayzen_session`) is scoped to.
  // Must match AYZEN_COOKIE_DOMAIN on the server. During local/dev testing
  // against a single host (no wildcard domain yet), set this to that exact
  // host instead (e.g. "sylo-preview.example.com").
  cookieDomain: "ayzen.tech",
};

export async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setConfig(partial) {
  await chrome.storage.sync.set(partial);
}
