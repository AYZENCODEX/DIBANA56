/**
 * routes/resend-webhook.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Public endpoint Resend calls for both inbound mail (`email.received`) and
 * outbound delivery-status events (`email.sent` / `email.delivered` /
 * `email.bounced` / ...) — one webhook URL configured on Resend, dispatched
 * by `event.type` below. Delivery Tracking (migration 050) is what the
 * latter group feeds: routes/ayzen-mailbox.ts's POST /send and
 * lib/mail-send-queue.ts already drive an outbound message's deliveryStatus
 * through 'queued' -> 'sending' -> 'accepted' on our own side; the two
 * stages after that — 'delivered' and 'bounced' — only exist because
 * Resend tells us, which is what these events are for.
 *
 * Bounce + Complaint Handling (Phase 1) builds on top of the same
 * bounced/complained events: beyond flipping deliveryStatus, a bounce or
 * complaint now also updates per-recipient reputation
 * (lib/mail-recipient-reputation.ts) and notifies the sending user. See
 * CHANGES_BOUNCE_COMPLAINT_PHASE1.md.
 *
 * IMPORTANT — this route needs the RAW request body to verify the Svix
 * signature, but app.ts applies express.json() globally to everything under
 * /api. See the app.ts snippet in SETUP.md for the small change that skips
 * JSON parsing for this one path and gives it express.raw() instead.
 */
import { Router } from "express";
import { db, usersTable, ayzenMailboxMessagesTable, ayzenMailboxAttachmentsTable, resendWebhookEventsTable, notificationsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getResendConfig, getInboundEmail, sendAsAyzenUser, verifyResendWebhookSignature } from "../lib/resend-mail";
import { resolveThreadId } from "../lib/mail-threading";
import { applyRulesToMessage } from "../lib/mail-rules";
import { evaluateInboundReputation, extractEmail } from "../lib/mail-spam";
import { recordBounce, recordComplaint, recordDelivery } from "../lib/mail-recipient-reputation";
import { recordBounce as recordHealthBounce, recordComplaint as recordHealthComplaint } from "../lib/mail-sending-health";
import { shouldNotifyIndividually } from "../lib/mail-notification-digest";
import { encryptField } from "../lib/vault-crypto";
import { logger } from "../lib/logger";
import { logBus } from "../lib/log-bus";

const router = Router();

// Resend's outbound lifecycle events we translate into deliveryStatus.
// 'email.delivery_delayed' and 'email.complained' intentionally aren't
// mapped to a deliveryStatus value — the pipeline this feature asked for
// is Queued -> Sending -> Accepted -> Delivered -> Bounced/Failed, and
// neither of those two is one of those states — but they're still handled
// below so they're not silently dropped. 'email.complained' specifically
// feeds Bounce + Complaint Handling (Phase 1) — see
// lib/mail-recipient-reputation.ts and migrations/052.
const DELIVERY_STATUS_BY_EVENT: Record<string, "accepted" | "delivered" | "bounced"> = {
  "email.sent": "accepted",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
};

// Only lets deliveryStatus move forward (or into a terminal state), so a
// webhook that arrives out of order — Resend doesn't guarantee delivery
// order across events — can't regress an already-'delivered' message back
// to 'accepted' just because its earlier 'email.sent' event was delayed in
// transit.
const STATUS_RANK: Record<string, number> = { queued: 0, sending: 1, accepted: 2, delivered: 3, bounced: 4, failed: 4 };

router.post("/webhooks/resend/inbound", async (req, res): Promise<void> => {
  // req.body is a Buffer here because of the express.raw() carve-out in
  // app.ts — do NOT let express.json() touch this route, or the raw bytes
  // needed for signature verification are gone by the time we see them.
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body);

  const cfg = await getResendConfig();
  if (!cfg) { res.status(503).json({ error: "Resend Email isn't configured" }); return; }

  const svixId = req.header("svix-id") ?? undefined;
  if (cfg.webhookSecret) {
    const valid = verifyResendWebhookSignature(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": req.header("svix-timestamp") ?? undefined,
      "svix-signature": req.header("svix-signature") ?? undefined,
    }, cfg.webhookSecret);
    if (!valid) {
      logger.warn("[resend-webhook] signature verification failed");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  } else {
    // Not fatal — lets you smoke-test before generating a signing secret —
    // but every production deployment should have one set.
    logger.warn("[resend-webhook] no webhookSecret configured — accepting unverified payload");
  }

  let event: any;
  try { event = JSON.parse(rawBody); } catch { res.status(400).json({ error: "Invalid JSON" }); return; }

  if (event.type in DELIVERY_STATUS_BY_EVENT || event.type === "email.delivery_delayed" || event.type === "email.complained") {
    await handleDeliveryEvent(event, svixId);
    res.status(200).json({ ok: true });
    return;
  }

  if (event.type !== "email.received") {
    // Anything else Resend might ever add — ack so it stops retrying.
    res.status(200).json({ ok: true, ignored: event.type });
    return;
  }

  const eventId: string | undefined = event.data?.email_id ?? event.id;
  if (eventId) {
    try {
      await db.insert(resendWebhookEventsTable).values({ eventId, eventType: event.type });
    } catch {
      // Unique violation = we've already processed this event id — Resend/Svix
      // redelivers on any non-2xx or timeout, so this is the normal path, not an error.
      res.status(200).json({ ok: true, deduped: true });
      return;
    }
  }

  try {
    const emailId: string = event.data?.email_id ?? event.data?.id;
    const full = await getInboundEmail(cfg, emailId);

    const toAddress = full.to[0]?.toLowerCase() ?? "";
    const username = toAddress.split("@")[0];
    const [user] = await db.select().from(usersTable).where(
      and(eq(usersTable.ayzenEmail, toAddress), eq(usersTable.ayzenEmailMode, "native")),
    );

    if (!user) {
      // No native-mode user claims this address — nothing more we can do
      // (a "forward" mode user's mail never reaches here; Cloudflare handles
      // those directly). Ack so Resend doesn't keep retrying.
      logger.warn({ toAddress, username }, "[resend-webhook] inbound mail for unknown/non-native ayzen address");
      res.status(200).json({ ok: true, unclaimed: true });
      return;
    }

    const threadId = await resolveThreadId(user.id, full.inReplyTo, full.references, full.messageId);

    // Sender reputation — see lib/mail-spam.ts. Checked before the message
    // is even stored so a blocked sender (or one that's crossed the report/
    // rate-limit thresholds) lands straight in Spam instead of Inbox. Never
    // rejects the mail outright — it's still accepted and stored, just
    // filed differently, same as every other spam classification here.
    const { folder: inboundFolder } = await evaluateInboundReputation(user.id, full.from);

    const [message] = await db.insert(ayzenMailboxMessagesTable).values({
      userId: user.id,
      direction: "inbound",
      folder: inboundFolder,
      resendEmailId: full.id,
      messageId: full.messageId ?? null,
      inReplyTo: full.inReplyTo ?? null,
      referencesHeader: full.references ?? null,
      threadId,
      fromAddr: full.from,
      toAddr: toAddress,
      ccAddr: full.cc?.join(", ") ?? null,
      subject: full.subject,
      textBody: encryptField(full.text ?? null),
      htmlBody: encryptField(full.html ?? null),
      hasAttachments: (full.attachments?.length ?? 0) > 0,
      receivedAt: full.createdAt ? new Date(full.createdAt) : new Date(),
    }).returning();

    if (full.attachments?.length) {
      await db.insert(ayzenMailboxAttachmentsTable).values(
        full.attachments.map((a) => ({
          messageId: message.id,
          filename: a.filename,
          contentType: a.contentType,
          sizeBytes: a.size,
          resendAttachmentId: a.id,
        })),
      );
    }

    // Rules and forward-relay both skip mail that landed straight in Spam —
    // same as Gmail/Outlook, a message the sender-reputation check already
    // filed as spam shouldn't also get auto-labeled/moved by a user's rule
    // or relayed out to a forward address.
    if (inboundFolder !== "spam") {
      // Rules — see lib/mail-rules.ts and migrations/042. Applied right after
      // the message (and its attachments) exist, so a rule that moves the
      // message out of Inbox or labels/stars it takes effect before the user
      // ever sees it land in Inbox. Never blocks storing the mail itself: a
      // rule-evaluation failure is logged and swallowed, not fatal to the
      // webhook, since the message is already safely stored at this point.
      try {
        const { appliedRuleIds } = await applyRulesToMessage(user.id, message);
        if (appliedRuleIds.length) {
          logger.info({ userId: user.id, messageId: message.id, appliedRuleIds }, "[resend-webhook] applied mailbox rules");
        }
      } catch (ruleErr: any) {
        logger.warn({ err: ruleErr?.message, userId: user.id, messageId: message.id }, "[resend-webhook] rule evaluation failed (message still stored)");
      }

      // Keep "routing" behavior alive on top of native storage: if the user
      // still has a forward-to address set, relay a copy the same way the old
      // Cloudflare rule would have.
      if (user.ayzenEmailForwardTo) {
        try {
          await sendAsAyzenUser(cfg, {
            fromUsername: username,
            to: user.ayzenEmailForwardTo,
            subject: `[Fwd] ${full.subject}`,
            html: full.html,
            text: full.text,
          });
          await db.update(ayzenMailboxMessagesTable).set({ forwardedTo: user.ayzenEmailForwardTo }).where(eq(ayzenMailboxMessagesTable.id, message.id));
        } catch (fwdErr: any) {
          logger.warn({ err: fwdErr?.message, userId: user.id }, "[resend-webhook] forward-copy relay failed (message still stored natively)");
        }
      }
    }

    res.status(200).json({ ok: true, stored: message.id, folder: inboundFolder });
  } catch (err: any) {
    logger.error({ err: err?.message ?? err }, "[resend-webhook] failed to process inbound email");
    // 500 so Resend retries — we haven't stored the message yet if this path failed.
    res.status(500).json({ error: "Failed to process inbound email" });
  }
});

/**
 * Delivery Tracking: applies one outbound lifecycle event
 * (email.sent/delivered/bounced/delivery_delayed/complained) to whichever
 * of our own messages it belongs to.
 *
 * Deduped on the `svix-id` header rather than `data.email_id` — unlike the
 * inbound-mail dedup above (one `email.received` per email, so its
 * email_id alone is a fine dedup key), the *same* outbound email_id fires
 * several different event types over its lifetime (sent, then delivered or
 * bounced), so email_id can't be the dedup key here or the second event
 * for the same email would look like a replay of the first and get
 * skipped. svix-id is unique per actual event delivery and stable across
 * Resend/Svix's own retries of that same event, which is exactly what we
 * want deduped.
 */
async function handleDeliveryEvent(event: any, svixId: string | undefined): Promise<void> {
  if (svixId) {
    try {
      await db.insert(resendWebhookEventsTable).values({ eventId: svixId, eventType: event.type });
    } catch {
      return; // already processed this exact event delivery
    }
  }

  const emailId: string | undefined = event.data?.email_id ?? event.data?.id;
  if (!emailId) return;

  const [message] = await db.select().from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.resendEmailId, emailId), eq(ayzenMailboxMessagesTable.direction, "outbound")));
  if (!message) {
    // Not one of ours (a different domain on the same Resend account), or
    // the event raced our own send code's resendEmailId write. Either way,
    // nothing more to do — ack and move on rather than erroring, since
    // there's no failure here Resend retrying would fix.
    logger.warn({ emailId, type: event.type }, "[resend-webhook] delivery event for unknown/unmatched outbound message");
    return;
  }

  if (event.type === "email.delivery_delayed") {
    logBus.warn(`Mail: delivery delayed for message #${message.id} ("${message.subject ?? "no subject"}")`);
    return;
  }
  if (event.type === "email.complained") {
    // Bounce + Complaint Handling (Phase 1) — a spam complaint doesn't
    // touch deliveryStatus (see the schema comment on complainedAt: the
    // message really was delivered, this is the recipient reporting it
    // afterward from their own inbox), but it's the single most serious
    // signal this webhook ever sees about a recipient, so it always: (1)
    // stamps the message, (2) blocks the address in recipient reputation.
    // (3) notifies the user, UNLESS Phase 4's digest has kicked in for a
    // high-volume burst — see shouldNotifyIndividually() below.
    await db.update(ayzenMailboxMessagesTable).set({ complainedAt: new Date() }).where(eq(ayzenMailboxMessagesTable.id, message.id));

    const recipientEmail = extractEmail(message.toAddr);
    const { justBlocked } = await recordComplaint(message.userId, recipientEmail);
    // Bounce + Complaint Handling (Phase 3) — account-wide counterpart to
    // the per-recipient recordComplaint() above.
    await recordHealthComplaint(message.userId);

    // Bounce + Complaint Handling (Phase 4) — checked (and its own
    // counters updated) every time regardless of outcome; only the
    // individual notification insert below is conditional on it.
    if (await shouldNotifyIndividually(message.userId, "complaint")) {
      await db.insert(notificationsTable).values({
        userId: message.userId,
        type: "mail",
        title: "Spam complaint received",
        message: `${recipientEmail} marked your message "${message.subject ?? "no subject"}" as spam. This address has been blocked from future sends.`,
        data: JSON.stringify({ messageId: message.id, recipientEmail }),
      });
    }
    if (justBlocked) {
      logBus.error(`Mail: ${recipientEmail} reported message #${message.id} as spam — address blocked`);
    }
    return;
  }

  const newStatus = DELIVERY_STATUS_BY_EVENT[event.type];
  if (!newStatus) return; // shouldn't reach here given the caller's filter, but stay defensive

  const currentRank = STATUS_RANK[message.deliveryStatus ?? "queued"] ?? 0;
  if (STATUS_RANK[newStatus]! < currentRank) {
    // Out-of-order delivery (e.g. a late 'email.sent' arriving after
    // 'email.delivered' already landed) — don't regress.
    return;
  }

  // Resend's exact bounce payload shape may vary by API version — hedge
  // across the field names it's used for this, rather than assume one.
  const bounceReason = event.type === "email.bounced"
    ? (event.data?.bounce?.message ?? event.data?.bounce?.type ?? event.data?.reason ?? null)
    : null;

  await db.update(ayzenMailboxMessagesTable).set({
    deliveryStatus: newStatus,
    deliveryStatusAt: new Date(),
    ...(bounceReason ? { bounceReason } : {}),
  }).where(eq(ayzenMailboxMessagesTable.id, message.id));

  if (newStatus === "bounced") {
    logBus.error(`Mail: message #${message.id} ("${message.subject ?? "no subject"}") bounced${bounceReason ? `: ${bounceReason}` : ""}`);

    // Bounce + Complaint Handling (Phase 1) — recipient reputation +
    // per-message notification. Notifying on every bounce (not just once
    // flagged) mirrors the complaint branch above: the message-level
    // "your email bounced" notice and the address-level "this address is
    // now flagged" notice are two different pieces of information, so both
    // fire, the second only once the threshold is actually crossed. Phase
    // 4: the message-level notice is what digests under high volume — the
    // address-level "flagged" notice below does not, since it already
    // only fires once per threshold crossing, not once per event.
    const recipientEmail = extractEmail(message.toAddr);
    const { justFlagged } = await recordBounce(message.userId, recipientEmail);
    // Bounce + Complaint Handling (Phase 3) — account-wide counterpart to
    // the per-recipient recordBounce() above.
    await recordHealthBounce(message.userId);

    if (await shouldNotifyIndividually(message.userId, "bounce")) {
      await db.insert(notificationsTable).values({
        userId: message.userId,
        type: "mail",
        title: "Message bounced",
        message: `Your message "${message.subject ?? "no subject"}" to ${recipientEmail} bounced${bounceReason ? `: ${bounceReason}` : "."}`,
        data: JSON.stringify({ messageId: message.id, recipientEmail, bounceReason }),
      });
    }
    if (justFlagged) {
      await db.insert(notificationsTable).values({
        userId: message.userId,
        type: "mail",
        title: "Recipient address flagged",
        message: `${recipientEmail} has bounced repeatedly and has been flagged as a problematic address.`,
        data: JSON.stringify({ recipientEmail }),
      });
      logBus.warn(`Mail: ${recipientEmail} flagged after repeated bounces`);
    }
  } else if (newStatus === "delivered") {
    logBus.system(`✅ Mail: message #${message.id} ("${message.subject ?? "no subject"}") delivered`);
    // Resets this recipient's consecutive-bounce streak — see the comment
    // on recordDelivery() for why a successful delivery clears the streak
    // but not an existing flag/block.
    await recordDelivery(message.userId, extractEmail(message.toAddr));
  }
}

export default router;
