/**
 * lib/resend-mail.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything Resend-specific for the native ayzen.tech mailbox:
 *   - reading the admin "Resend Email" plugin config (mirrors the pattern
 *     routes/email-routing.ts already uses for the Cloudflare Email plugin)
 *   - creating/verifying the ayzen.tech domain on Resend (Domains API)
 *   - pushing the DNS records Resend returns onto the existing Cloudflare
 *     zone, so "register on Resend" and "configure on Cloudflare" happen in
 *     one call instead of two manual dashboard trips
 *   - fetching a full inbound email + its attachments (Receiving API)
 *   - sending mail *as* a user's username@ayzen.tech address
 *   - verifying the Svix-format webhook signature Resend signs
 *     `email.received` events with
 *
 * Resend's Inbound feature (MX -> Resend, POST to our webhook on
 * email.received) is what actually gives ayzen.tech a native mailbox —
 * Cloudflare Email Routing only ever forwards, it doesn't store anything.
 * Cloudflare remains the DNS host for the zone either way.
 */
import crypto from "crypto";
import { db, pluginsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const RESEND_API = "https://api.resend.com";
const CF_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_DOMAIN = "ayzen.tech";

export interface ResendConfig {
  apiKey: string;
  webhookSecret: string | null;
  domain: string;
  domainId: string | null; // cached once we've created/found it on Resend
}

/** Reads Admin → Plugins → Resend Email config, same pattern as getCfConfig() in routes/email-routing.ts. */
export async function getResendConfig(): Promise<ResendConfig | null> {
  let apiKey: string | null = null;
  let webhookSecret: string | null = null;
  let domain = DEFAULT_DOMAIN;
  let domainId: string | null = null;

  try {
    const [row] = await db.select().from(pluginsTable).where(eq(pluginsTable.slug, "resend-email"));
    if (row?.config) {
      const cfg = JSON.parse(row.config) as Record<string, string>;
      if (cfg.apiKey?.trim()) apiKey = cfg.apiKey.trim();
      if (cfg.webhookSecret?.trim()) webhookSecret = cfg.webhookSecret.trim();
      if (cfg.domain?.trim()) domain = cfg.domain.trim().toLowerCase();
      if (cfg.domainId?.trim()) domainId = cfg.domainId.trim();
    }
  } catch (err) {
    logger.warn({ err }, "Failed to parse resend-email plugin config, falling back to env");
  }

  if (!apiKey) apiKey = process.env.RESEND_API_KEY || null;
  if (!webhookSecret) webhookSecret = process.env.RESEND_WEBHOOK_SECRET || null;
  if (!apiKey) return null;

  return { apiKey, webhookSecret, domain, domainId };
}

/** Persists domainId (and anything else) back onto the resend-email plugin config after setup. */
export async function saveResendConfig(patch: Partial<{ apiKey: string; webhookSecret: string; domain: string; domainId: string }>): Promise<void> {
  const [row] = await db.select().from(pluginsTable).where(eq(pluginsTable.slug, "resend-email"));
  const existing = row?.config ? JSON.parse(row.config) : {};
  const merged = { ...existing, ...patch };
  if (row) {
    await db.update(pluginsTable).set({ config: JSON.stringify(merged), updatedAt: new Date() }).where(eq(pluginsTable.slug, "resend-email"));
  } else {
    await db.insert(pluginsTable).values({ slug: "resend-email", name: "Resend Email", enabled: true, config: JSON.stringify(merged) });
  }
}

async function resendFetch(apiKey: string, path: string, opts: RequestInit = {}): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${RESEND_API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export interface ResendDnsRecord {
  record: string; // "MX" | "TXT" | "CNAME"
  name: string;
  value: string;
  priority?: number;
  type?: string;
  status?: string;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string; // "not_started" | "pending" | "verified" | "failed" | "temporary_failure"
  records: ResendDnsRecord[];
  region?: string;
}

/** Finds the domain on Resend if it already exists, else creates it. Resend's Domains API also enables Inbound automatically once the MX record it returns is added. */
export async function ensureResendDomain(cfg: ResendConfig): Promise<ResendDomain> {
  const { json: listJson } = await resendFetch(cfg.apiKey, "/domains");
  const existing = (listJson?.data ?? []).find((d: any) => d.name?.toLowerCase() === cfg.domain.toLowerCase());
  if (existing) {
    return await getResendDomain(cfg, existing.id);
  }

  const { ok, json: createJson } = await resendFetch(cfg.apiKey, "/domains", {
    method: "POST",
    body: JSON.stringify({ name: cfg.domain }),
  });
  if (!ok) {
    throw new Error(createJson?.message ?? `Resend rejected domain creation for ${cfg.domain}`);
  }
  await saveResendConfig({ domainId: createJson.id });
  return await getResendDomain(cfg, createJson.id);
}

export async function getResendDomain(cfg: ResendConfig, domainId: string): Promise<ResendDomain> {
  const { ok, json } = await resendFetch(cfg.apiKey, `/domains/${domainId}`);
  if (!ok) throw new Error(json?.message ?? "Could not fetch Resend domain");
  return { id: json.id, name: json.name, status: json.status, records: json.records ?? [], region: json.region };
}

export async function verifyResendDomain(cfg: ResendConfig, domainId: string): Promise<ResendDomain> {
  await resendFetch(cfg.apiKey, `/domains/${domainId}/verify`, { method: "POST" });
  return await getResendDomain(cfg, domainId);
}

// ─── Cloudflare DNS record push ──────────────────────────────────────────────
// Reuses the same "Cloudflare Email" plugin config routes/email-routing.ts
// reads from, since it's the same Cloudflare account/zone for ayzen.tech.
interface CfDnsCreds { apiKey: string; zoneId: string }

async function getCfDnsCreds(): Promise<CfDnsCreds | null> {
  const [row] = await db.select().from(pluginsTable).where(eq(pluginsTable.slug, "cloudflare-email"));
  if (!row?.config) return null;
  const cfg = JSON.parse(row.config) as Record<string, string>;
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) return null;
  let zoneId = cfg.zoneId?.trim() || null;
  const domain = cfg.domain?.trim() || DEFAULT_DOMAIN;
  if (!zoneId) {
    const res = await fetch(`${CF_API}/zones?name=${encodeURIComponent(domain)}&status=active`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const json = await res.json().catch(() => ({}));
    zoneId = json?.result?.[0]?.id ?? null;
  }
  if (!zoneId) return null;
  return { apiKey, zoneId };
}

async function cfDnsUpsert(creds: CfDnsCreds, rec: { type: string; name: string; content: string; priority?: number }): Promise<{ ok: boolean; error?: string }> {
  const headers = { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" };
  const listRes = await fetch(
    `${CF_API}/zones/${creds.zoneId}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`,
    { headers },
  );
  const listJson = await listRes.json().catch(() => ({}));
  // MX and TXT can both have multiple values at once — only overwrite an
  // existing record when its content matches the same logical record
  // (Resend re-issues the same DKIM/SPF/MX names on every setup call), and
  // otherwise add a new one alongside it rather than clobbering unrelated
  // records at the same name.
  const existing = (listJson?.result ?? []).find((r: any) => r.content === rec.content);
  const body = JSON.stringify({ type: rec.type, name: rec.name, content: rec.content, priority: rec.priority, ttl: 1 });

  const res = existing
    ? await fetch(`${CF_API}/zones/${creds.zoneId}/dns_records/${existing.id}`, { method: "PUT", headers, body })
    : await fetch(`${CF_API}/zones/${creds.zoneId}/dns_records`, { method: "POST", headers, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { ok: false, error: json?.errors?.map((e: any) => e.message).join("; ") ?? "Cloudflare DNS write failed" };
  }
  return { ok: true };
}

/** Pushes every DNS record Resend asked for onto the Cloudflare zone. Best-effort per record so a partial failure still reports which records need to be added by hand. */
export async function pushResendRecordsToCloudflare(records: ResendDnsRecord[]): Promise<{ pushed: number; failed: { record: ResendDnsRecord; error: string }[]; cloudflareConnected: boolean }> {
  const creds = await getCfDnsCreds();
  if (!creds) return { pushed: 0, failed: [], cloudflareConnected: false };

  let pushed = 0;
  const failed: { record: ResendDnsRecord; error: string }[] = [];
  for (const r of records) {
    const type = (r.type || r.record || "TXT").toUpperCase();
    const result = await cfDnsUpsert(creds, { type, name: r.name, content: r.value, priority: r.priority });
    if (result.ok) pushed++;
    else failed.push({ record: r, error: result.error ?? "unknown error" });
  }
  return { pushed, failed, cloudflareConnected: true };
}

// ─── Inbound: fetch full email + attachments ─────────────────────────────────
export interface ResendInboundEmail {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  createdAt?: string;
  attachments?: { id: string; filename: string; contentType: string; size: number; content?: string }[];
}

// `withContent` pulls the base64 `content` field the Receiving API returns
// per-attachment. Left off by default — the webhook only needs id/filename/
// contentType/size to write ayzen_mailbox_attachments metadata, and there's
// no reason to drag every attachment's bytes through that path.
export async function getInboundEmail(cfg: ResendConfig, emailId: string, opts: { withContent?: boolean } = {}): Promise<ResendInboundEmail> {
  const { ok, json } = await resendFetch(cfg.apiKey, `/emails/receiving/${emailId}`);
  if (!ok) throw new Error(json?.message ?? "Could not fetch inbound email from Resend");
  return {
    id: json.id,
    from: json.from,
    to: Array.isArray(json.to) ? json.to : [json.to].filter(Boolean),
    cc: json.cc,
    subject: json.subject ?? "(no subject)",
    text: json.text,
    html: json.html,
    messageId: json.message_id ?? json.headers?.["message-id"],
    inReplyTo: json.headers?.["in-reply-to"],
    references: json.headers?.["references"],
    createdAt: json.created_at,
    attachments: (json.attachments ?? []).map((a: any) => ({
      id: a.id, filename: a.filename, contentType: a.content_type, size: a.size,
      ...(opts.withContent ? { content: a.content as string | undefined } : {}),
    })),
  };
}

/**
 * Fetches one inbound attachment's raw bytes (base64) by re-pulling the
 * parent email with `withContent: true` and picking the matching attachment
 * out of it — there's no dedicated single-attachment endpoint on the
 * Receiving API, so this is the same "re-fetch the full email" pattern the
 * inbound webhook already uses in resend-webhook.ts.
 */
export async function getInboundAttachmentContent(
  cfg: ResendConfig,
  emailId: string,
  attachmentId: string,
): Promise<{ filename: string; contentType: string; content: string }> {
  const full = await getInboundEmail(cfg, emailId, { withContent: true });
  const att = full.attachments?.find((a) => a.id === attachmentId);
  if (!att) throw new Error("Attachment not found on this email");
  if (!att.content) throw new Error("Resend did not return attachment content");
  return { filename: att.filename, contentType: att.contentType, content: att.content };
}

// ─── Outbound: send as username@ayzen.tech ───────────────────────────────────
export async function sendAsAyzenUser(
  cfg: ResendConfig,
  opts: {
    fromUsername: string; to: string; cc?: string; bcc?: string; subject: string; html?: string; text?: string;
    inReplyTo?: string;
    // Space-separated ancestor Message-IDs, oldest first — RFC "References"
    // header. Sending this (in addition to In-Reply-To) is what lets the
    // *recipient's* mail client (Gmail, Outlook, ...) thread the message
    // correctly even several replies deep, not just our own mailbox.
    references?: string;
    // Resend's send API takes attachments as { filename, content } with
    // content as a base64 string — same shape the client uploads to us in.
    attachments?: { filename: string; content: string; contentType?: string }[];
  },
): Promise<{ id: string; messageId: string }> {
  const from = `${opts.fromUsername}@${cfg.domain}`;
  const headers: Record<string, string> = {};
  if (opts.inReplyTo) headers["In-Reply-To"] = opts.inReplyTo;
  if (opts.references) headers["References"] = opts.references;

  const { ok, json } = await resendFetch(cfg.apiKey, "/emails", {
    method: "POST",
    body: JSON.stringify({
      from, to: opts.to, cc: opts.cc || undefined, bcc: opts.bcc || undefined, subject: opts.subject, html: opts.html, text: opts.text,
      headers: Object.keys(headers).length ? headers : undefined,
      attachments: opts.attachments?.length
        ? opts.attachments.map((a) => ({ filename: a.filename, content: a.content }))
        : undefined,
    }),
  });
  if (!ok) throw new Error(json?.message ?? `Resend rejected the send from ${from}`);
  // Resend's send response only returns its own internal email id, not the
  // Message-ID header it puts on the outgoing email — but our own mailbox
  // needs *some* stable Message-ID for this message so that if the
  // recipient replies again, that reply's In-Reply-To/References can be
  // matched back to this row (see routes/ayzen-mailbox.ts threadId
  // resolution). `<{resend id}@{domain}>` is a reasonable, collision-free
  // synthetic id in the same shape real Message-IDs take.
  return { id: json.id, messageId: `<${json.id}@${cfg.domain}>` };
}

// ─── Webhook signature verification (Svix format) ────────────────────────────
// Resend signs webhooks the same way Svix does: base64 HMAC-SHA256 over
// `${svix-id}.${svix-timestamp}.${rawBody}`, keyed by the part of the
// whsec_... secret after the prefix, compared against one or more
// "v1,<sig>" entries in the svix-signature header, within a 5-minute window.
export function verifyResendWebhookSignature(
  rawBody: string,
  headers: { "svix-id"?: string; "svix-timestamp"?: string; "svix-signature"?: string },
  secret: string,
): boolean {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatureHeader = headers["svix-signature"];
  if (!id || !timestamp || !signatureHeader) return false;

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    return false; // outside the 5-minute tolerance window — reject stale/future replays
  }

  const secretBytes = Buffer.from(secret.split("_")[1] ?? secret, "base64");
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");

  const candidates = signatureHeader.split(" ").map((s) => s.split(",")[1]).filter(Boolean);
  return candidates.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false; // length mismatch etc. — not a match
    }
  });
}
