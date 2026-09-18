/**
 * lib/imap-fetch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Root-cause fix for the Phase 9 IMAP regression.
 *
 * `imap-simple` (the library this project depends on) does NOT expose a
 * `fetchMessages()` method — it only exposes `search()`, `openBox()`, `end()`,
 * and a handful of flag/label helpers. The previous implementation called
 * `connection.fetchMessages(range, opts)`, which doesn't exist on the
 * `ImapSimple` instance, so every IMAP fetch threw
 * `TypeError: connection.fetchMessages is not a function` and mail sync
 * silently failed (masked by broad try/catch blocks that only incremented a
 * "failed" counter — see mail-sync.ts).
 *
 * This module restores real fetch capability using the APIs the underlying
 * `imap` (node-imap) connection actually supports:
 *  - `search(criteria, fetchOptions)`  — the officially supported way to pull
 *    a batch of messages via imap-simple, used here for "latest N headers".
 *  - the raw node-imap `Connection#fetch(uids, options)` (UID FETCH) for
 *    pulling one specific message by UID — the same technique imap-simple
 *    itself uses internally, wrapped in a Promise here since node-imap's
 *    fetch() is an EventEmitter, not a Promise.
 */
import Imap from "imap";

export interface ImapMessage {
  seqNo: number;
  attributes: any;
  parts: Array<{ which: string; size: number; body: any }>;
}

/** Wrap node-imap's raw fetch() (EventEmitter) in a Promise, matching imap-simple's message shape. */
function collectFetch(fetch: any): Promise<ImapMessage[]> {
  return new Promise((resolve, reject) => {
    const results: ImapMessage[] = [];
    fetch.on("message", (msg: any, seqNo: number) => {
      const parts: ImapMessage["parts"] = [];
      let attributes: any = null;
      msg.on("body", (stream: any, info: any) => {
        let body = "";
        stream.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        stream.once("end", () => {
          const part: any = { which: info.which, size: info.size, body };
          if (/^HEADER/.test(info.which)) part.body = Imap.parseHeader(part.body);
          parts.push(part);
        });
      });
      msg.once("attributes", (attrs: any) => { attributes = attrs; });
      msg.once("end", () => { results.push({ seqNo, attributes, parts }); });
    });
    fetch.once("error", (err: Error) => reject(err));
    fetch.once("end", () => resolve(results));
  });
}

/**
 * Fetch the latest `limit` messages' headers (and any other requested bodies)
 * from the currently-open mailbox, oldest-first (matches the old range-fetch
 * ordering the rest of mail-sync.ts expects before it .reverse()es the list).
 *
 * Uses search(['ALL']) because imap-simple has no direct "fetch by sequence
 * range" call. For large mailboxes this fetches every message's headers
 * server-side before we slice client-side — acceptable for header-only
 * fetches (small payload per message) but something to revisit if account
 * mailboxes get very large.
 */
export async function fetchLatestMessages(
  connection: any,
  limit: number,
  fetchOptions: any
): Promise<ImapMessage[]> {
  const all: any[] = await connection.search(["ALL"], fetchOptions);
  all.sort((a, b) => (a.seqNo ?? 0) - (b.seqNo ?? 0));
  return all.slice(Math.max(0, all.length - limit));
}

/** Fetch a single message by IMAP UID, using the raw node-imap connection (UID FETCH). */
export async function fetchMessageByUid(
  connection: any,
  uid: number,
  fetchOptions: any
): Promise<ImapMessage | null> {
  const rawImap = connection.imap;
  if (!rawImap) throw new Error("IMAP connection is not open");
  const fetch = rawImap.fetch(uid, fetchOptions);
  const results = await collectFetch(fetch);
  return results[0] ?? null;
}
