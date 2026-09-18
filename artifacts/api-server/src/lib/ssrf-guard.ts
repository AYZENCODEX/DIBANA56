/**
 * lib/ssrf-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault Backup hardening, Round 5 — SSRF protection for the webhook delivery
 * destination (lib/vault-backup-delivery.ts / routes/vault-backup-schedule.ts).
 *
 * The problem: a vault backup schedule's `webhookUrl` is a URL an
 * authenticated user types in, and the SERVER — not the user's browser —
 * makes an outbound POST to it (carrying the encrypted backup blob) every
 * time that schedule runs. Nothing previously checked *where* that URL
 * pointed beyond "is it http(s)". A malicious or compromised account could
 * set it to an internal/private address — a cloud metadata endpoint
 * (169.254.169.254), an internal admin panel, a database's HTTP interface,
 * localhost, another container on the same network — and get the server
 * itself to make requests into places the account holder should never be
 * able to reach directly. This runs on an unattended cron schedule, so it's
 * not a one-off click either: it's a standing, repeating SSRF primitive
 * until the schedule is disabled.
 *
 * assertPublicHttpsUrl() is the guard: https-only, no embedded credentials,
 * hostname must not be a bare IP or resolve (via a real DNS lookup, not
 * just string-matching "localhost") to anything in a private/loopback/
 * link-local/reserved/multicast range — IPv4 and IPv6, including
 * IPv4-mapped IPv6 addresses (`::ffff:169.254.169.254`) which would
 * otherwise sail through an IPv4-only check.
 *
 * Two call sites, deliberately not one:
 *   1. routes/vault-backup-schedule.ts calls it when a schedule is saved,
 *      for immediate feedback ("that URL isn't allowed") instead of a
 *      silent failure on the next scheduled run.
 *   2. lib/vault-backup-delivery.ts calls it again immediately before every
 *      actual delivery attempt. DNS answers can change after a schedule is
 *      saved (a hostname that was public last week can be repointed at an
 *      internal address today), so the save-time check alone isn't
 *      sufficient — the delivery-time check is the one that actually
 *      matters and must never be skipped, even for a schedule saved
 *      before this guard existed.
 *
 * What this does NOT fully close: a sufficiently adversarial DNS setup
 * (near-zero TTL, answers alternating between a public and a private IP on
 * successive queries) could in principle return a different address to our
 * validation lookup than to fetch()'s own internal lookup microseconds
 * later — "DNS rebinding". Fully closing that requires pinning the exact
 * validated socket address for the actual request (custom low-level
 * dispatcher/lookup), which isn't done here to avoid adding a new runtime
 * dependency for this round. What IS done — re-validating right before
 * every send, rather than only at save time, plus refusing to follow
 * redirects (see deliverSnapshotByWebhook) so a webhook target can't
 * sidestep validation entirely by 302-ing the request somewhere private —
 * closes the realistic, low-effort version of this attack (a literal
 * internal address or hostname, static DNS, or a redirect-based bypass).
 * The narrow rebinding case is a documented residual risk, not a silent one.
 */
import dns from "dns/promises";
import net from "net";

function isDisallowedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — includes cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224-239) + reserved (240-255) + broadcast
  return false;
}

function isDisallowedIPv6(ipRaw: string): boolean {
  const ip = ipRaw.toLowerCase();
  if (ip === "::1" || ip === "::") return true; // loopback / unspecified
  // IPv4-mapped / IPv4-compatible — unwrap and check as IPv4, so
  // "::ffff:169.254.169.254" can't slip past an IPv6-shaped check.
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || ip.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isDisallowedIPv4(v4Mapped[1]);
  const firstGroup = ip.split(":")[0];
  const firstHextet = parseInt(firstGroup || "0", 16) || 0;
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true; // fe80::/10 link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7 unique local
  if (firstHextet >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isDisallowedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isDisallowedIPv4(ip);
  if (net.isIPv6(ip)) return isDisallowedIPv6(ip);
  return true; // not a recognizable IP literal — treat as unsafe
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

/**
 * Throws with a user-facing message if `rawUrl` isn't a safe, public
 * https:// destination. Resolves the hostname via real DNS (no reliance on
 * string pattern-matching alone) and rejects if ANY resolved address is
 * private/loopback/link-local/reserved. Callers should await this
 * immediately before use — see the module doc comment for why it must be
 * called again at actual delivery time, not just when a URL is saved.
 */
export async function assertPublicHttpsUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (u.protocol !== "https:") {
    throw new Error("Webhook URL must use https://");
  }
  if (u.username || u.password) {
    throw new Error("Webhook URL must not contain embedded credentials");
  }
  const hostname = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 URL brackets
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith(".localhost")) {
    throw new Error("Webhook URL points to a private/internal address, which isn't allowed");
  }
  if (net.isIP(hostname)) {
    if (isDisallowedIp(hostname)) {
      throw new Error("Webhook URL points to a private/internal address, which isn't allowed");
    }
    return;
  }
  let addresses: string[];
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new Error("Could not resolve the webhook URL's hostname");
  }
  if (addresses.length === 0) {
    throw new Error("Could not resolve the webhook URL's hostname");
  }
  for (const ip of addresses) {
    if (isDisallowedIp(ip)) {
      throw new Error("Webhook URL resolves to a private/internal address, which isn't allowed");
    }
  }
}
