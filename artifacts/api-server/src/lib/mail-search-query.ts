/**
 * lib/mail-search-query.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses Gmail-style search operators out of a raw mailbox search string —
 * from:/to:/cc:/subject:/has:attachment/is:unread|starred|draft/after:/
 * before:/folder: — leaving whatever's left as free text for the
 * full-text search_vector match in routes/ayzen-mailbox.ts's
 * GET /mailbox/search. Every operator is optional and combinable with any
 * other, and with free text — `from:boss subject:invoice has:attachment`
 * is a valid query with no free text at all, same as
 * `invoice from:boss has:attachment` combining both.
 */

// key:value or key:"quoted value" — values with spaces need quotes (e.g.
// subject:"Q3 report"), same convention Gmail search uses.
const OPERATOR_RE = /(\w+):("([^"]*)"|\S+)/g;

export interface ParsedMailSearch {
  freeText: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
  isStarred?: boolean;
  isDraft?: boolean;
  after?: Date;
  before?: Date;
  folder?: string;
}

// Accepts Gmail's YYYY/MM/DD as well as plain YYYY-MM-DD; anything else is
// silently ignored (the operator is dropped rather than erroring the whole
// search over one malformed date).
function parseOperatorDate(raw: string): Date | null {
  const normalized = raw.replace(/\//g, "-");
  const d = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseMailSearchQuery(raw: string): ParsedMailSearch {
  const result: ParsedMailSearch = { freeText: "" };
  const leftoverParts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  OPERATOR_RE.lastIndex = 0;
  while ((match = OPERATOR_RE.exec(raw))) {
    leftoverParts.push(raw.slice(lastIndex, match.index));
    lastIndex = OPERATOR_RE.lastIndex;

    const key = match[1]!.toLowerCase();
    // match[3] is the inside of a quoted value; match[2] is the raw token
    // (quoted-with-quotes or the bare \S+ match) when there's no quote group.
    const value = (match[3] ?? match[2]!).trim();
    if (!value) continue;

    switch (key) {
      case "from": result.from = value; break;
      case "to": result.to = value; break;
      case "cc": result.cc = value; break;
      case "subject": result.subject = value; break;
      case "has": if (value.toLowerCase() === "attachment") result.hasAttachment = true; break;
      case "is":
        if (value.toLowerCase() === "unread") result.isUnread = true;
        else if (value.toLowerCase() === "starred") result.isStarred = true;
        else if (value.toLowerCase() === "draft") result.isDraft = true;
        break;
      case "after": { const d = parseOperatorDate(value); if (d) result.after = d; break; }
      case "before": { const d = parseOperatorDate(value); if (d) result.before = d; break; }
      case "folder": result.folder = value.toLowerCase(); break;
      default:
        // Unrecognized "word:value" token (e.g. someone searching the
        // literal string "re:invoice") — keep it as free text rather than
        // silently discarding part of the user's query.
        leftoverParts.push(match[0]);
    }
  }
  leftoverParts.push(raw.slice(lastIndex));
  result.freeText = leftoverParts.join(" ").replace(/\s+/g, " ").trim();
  return result;
}
