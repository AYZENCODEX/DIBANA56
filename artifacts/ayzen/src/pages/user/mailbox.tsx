import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  Mail, Inbox, Send, Loader2, RefreshCw, ChevronLeft, Star, Trash2,
  Paperclip, X, Download, PenSquare, Circle, MailOpen, Reply, ReplyAll, Forward, FileEdit,
  Archive, ArchiveRestore, Folder, FolderPlus, MoreHorizontal, Pencil,
  FolderInput, ChevronDown, ChevronRight, PenTool, Check, CloudUpload,
  Search, Tag, Tags, Zap, Bell, BellOff, CheckSquare, Square,
  Clock, ShieldAlert, ShieldOff, CalendarClock,
  Image as ImageIcon, FileText, FileVideo, FileAudio, FileArchive, FileSpreadsheet, File as FileIcon,
  RotateCcw, Eye, PackageOpen, UploadCloud, AlertCircle,
  ChevronUp, BarChart3, UserCircle2, UserPlus, XCircle, CheckCheck, Layers, Flag,
  LayoutTemplate, Save, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuLabel, DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { RichTextEditor, textToHtml, type RichTextEditorHandle } from "@/components/mail/rich-text-editor";
import { LabelChip, LabelDot, ColorSwatch, AYZEN_LABEL_COLORS, type AyzenLabelColor, type MailLabel } from "@/components/mail/label-badge";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

// System folders always shown, in display order — mirrors
// AYZEN_MAILBOX_SYSTEM_FOLDERS in lib/db/src/schema/ayzen-mailbox.ts.
const SYSTEM_FOLDERS = ["inbox", "snoozed", "sent", "scheduled", "outbox", "drafts", "spam", "archive", "trash"] as const;
type SystemFolderKey = (typeof SYSTEM_FOLDERS)[number];

// Folders you can't drop a message into via the generic Move-to menu — they
// need extra state the move routes don't set. "snoozed" needs a due-date
// (dedicated Snooze flow), "scheduled" needs a send time (dedicated
// Schedule flow via Compose, or Reschedule), and "outbox" is the Robust
// Send Queue's in-flight state — a message only ever lands there via
// POST /send, and only ever leaves it once the queue worker actually sends
// it — see NON_MOVE_TARGET_FOLDERS in routes/ayzen-mailbox.ts.
const NON_MOVE_TARGET_FOLDERS = new Set<SystemFolderKey>(["drafts", "snoozed", "scheduled", "outbox"]);

const FOLDER_ICONS: Record<SystemFolderKey, typeof Inbox> = {
  inbox: Inbox, snoozed: Clock, sent: Send, scheduled: CalendarClock, outbox: Loader2, drafts: FileEdit, spam: ShieldAlert, archive: Archive, trash: Trash2,
};
const FOLDER_LABELS: Record<SystemFolderKey, string> = {
  inbox: "Inbox", snoozed: "Snoozed", sent: "Sent", scheduled: "Scheduled", outbox: "Outbox", drafts: "Drafts", spam: "Spam", archive: "Archive", trash: "Trash",
};

// Delivery Tracking (migrations/050_ayzen_mailbox_delivery_tracking.sql) —
// Queued -> Sending -> Accepted -> Delivered -> Bounced/Failed. Shown as a
// small badge on outbound messages wherever their deliveryStatus is known;
// undefined/null deliveryStatus (inbound mail, or outbound sent before this
// existed) renders nothing.
const DELIVERY_STATUS_META: Record<
  NonNullable<MailboxMessage["deliveryStatus"]>,
  { label: string; icon: typeof Clock; className: string; spin?: boolean }
> = {
  queued: { label: "Queued", icon: Clock, className: "text-muted-foreground/50" },
  sending: { label: "Sending", icon: Loader2, className: "text-primary/70", spin: true },
  accepted: { label: "Accepted", icon: Check, className: "text-muted-foreground/50" },
  delivered: { label: "Delivered", icon: CheckCheck, className: "text-emerald-400/70" },
  bounced: { label: "Bounced", icon: XCircle, className: "text-red-400/70" },
  failed: { label: "Failed", icon: AlertCircle, className: "text-red-400/70" },
};

// Quick presets for the snooze picker, in the order shown. `at()` is
// evaluated when the menu opens (not at module load), so "later today" /
// "tomorrow" are always relative to the actual current moment.
const SNOOZE_PRESETS: { label: string; at: () => Date }[] = [
  { label: "Later today", at: () => { const d = new Date(); d.setHours(d.getHours() + 3, 0, 0, 0); return d; } },
  { label: "Tomorrow morning", at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
  { label: "This weekend", at: () => { const d = new Date(); const add = (6 - d.getDay() + 7) % 7 || 6; d.setDate(d.getDate() + add); d.setHours(9, 0, 0, 0); return d; } },
  { label: "Next week", at: () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return d; } },
];

// Which folder a message is currently in — either a system folder, or a
// custom one identified by id (folder === "custom" && folderId set).
type ActiveFolder = { folder: SystemFolderKey | "custom"; folderId: number | null; name?: string };

interface FolderCounts { key: string; label: string; count: number; unread: number }
interface CustomFolder { id: number; name: string; count: number; unread: number }

interface MailboxMessage {
  id: number;
  direction: "inbound" | "outbound";
  folder: SystemFolderKey | "custom";
  folderId: number | null;
  isDraft: boolean;
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string | null;
  hasAttachments: boolean;
  isRead: boolean;
  isStarred: boolean;
  // Only non-null while folder === "snoozed" — when it's due back in Inbox.
  snoozedUntil?: string | null;
  // Only non-null while folder === "scheduled" — when Scheduled Send will
  // actually fire this off.
  scheduledSendAt?: string | null;
  // Delivery Tracking — see migrations/050_ayzen_mailbox_delivery_tracking.sql.
  // Only meaningful for direction === "outbound"; null for inbound mail and
  // for outbound messages sent before this existed.
  deliveryStatus?: "queued" | "sending" | "accepted" | "delivered" | "bounced" | "failed" | null;
  deliveryStatusAt?: string | null;
  bounceReason?: string | null;
  // Bounce + Complaint Handling (Phase 1) — set once the recipient has
  // reported this message as spam via their own mail client. Distinct from
  // deliveryStatus === "bounced": a complained message was still delivered.
  complainedAt?: string | null;
  // Undo Send (Phase 2) — only non-null while folder === "outbox". Drives
  // OutboxUndoChip's persistent "Undo (Ns)" affordance below, which — unlike
  // Phase 1's toast-only version — survives a dismissed toast or a reload
  // since it's read straight off this same list data.
  undoExpiresAt?: string | null;
  labels: MailLabel[];
  forwardedTo?: string | null;
  // RFC Message-ID of this email (distinct from `id`, which is just our own
  // DB row number) — needed to thread a reply correctly.
  messageId?: string | null;
  // Raw References header this message carried — needed to build the
  // *next* reply's References chain (see buildReplyDraft below).
  references?: string | null;
  // Conversation key shared by every message in this thread — see
  // migrations/040_ayzen_mailbox_threading.sql.
  threadId: string;
  // Only present on list rows (GET /mailbox groups by thread): how many
  // messages in *this folder* belong to the conversation, and whether any
  // of them are unread.
  messageCount?: number;
  threadUnread?: boolean;
  receivedAt: string | null;
  createdAt: string;
}

interface MailboxAttachment {
  id: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

interface MailboxMessageDetail extends MailboxMessage {
  text: string | null;
  html: string | null;
  attachments: MailboxAttachment[];
  // Robust Send Queue Phase 2: set when this message sits in Drafts because
  // the send-queue worker gave up on it after MAX_SEND_ATTEMPTS (see
  // lib/mail-send-queue.ts) — null otherwise, including for drafts that
  // were just saved normally and never attempted a send.
  sendFailure?: string | null;
}

interface ThreadResponse {
  threadId: string;
  messages: MailboxMessageDetail[];
}

interface PendingAttachment {
  // Client-side only id (not the server's attachment id — this one doesn't
  // exist yet) used to track progress/errors/removal per chip while a file
  // is still being read or the draft hasn't been sent.
  id: string;
  filename: string;
  contentType: string;
  dataBase64: string;
  sizeBytes: number;
  status: "reading" | "ready" | "error";
  progress: number; // 0-100, meaningful while status === "reading"
  error?: string;
  // Local preview for image chips — an object: URL (freshly picked files)
  // or a data: URL (attachments carried over from a forward, which only
  // have base64 in hand, no live File). Only ever set for image/* types.
  previewUrl?: string;
}

let pendingAttachmentSeq = 0;
const nextAttachmentId = () => `pa-${Date.now()}-${pendingAttachmentSeq++}`;

// Normalizes an already-fetched attachment (e.g. forwarded from another
// message via fetchAttachmentsAsPending) into a ready-to-send
// PendingAttachment — same shape newly-picked files end up in once their
// FileReader finishes, just skipping straight to "ready".
function toReadyAttachment(a: { filename: string; contentType: string; dataBase64: string; sizeBytes: number }): PendingAttachment {
  return {
    id: nextAttachmentId(),
    filename: a.filename,
    contentType: a.contentType,
    dataBase64: a.dataBase64,
    sizeBytes: a.sizeBytes,
    status: "ready",
    progress: 100,
    previewUrl: isImageType(a.contentType) ? `data:${a.contentType};base64,${a.dataBase64}` : undefined,
  };
}

// ─── Compose Templates — shared type ────────────────────────────────────────
interface MailTemplate {
  id: number;
  name: string;
  subject: string;
  bodyHtml: string;
  updatedAt: string;
}

// ─── Labels & Rules & Filters — shared types ────────────────────────────────
interface LabelWithCount extends MailLabel { count: number }

const RULE_FIELDS = ["from", "to", "subject"] as const;
type RuleField = (typeof RULE_FIELDS)[number];
const RULE_MATCH_TYPES = ["contains", "equals"] as const;
type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];
const RULE_FIELD_LABELS: Record<RuleField, string> = { from: "From", to: "To", subject: "Subject" };
const RULE_MATCH_LABELS: Record<RuleMatchType, string> = { contains: "contains", equals: "is exactly" };

interface MailRule {
  id: number;
  name: string;
  enabled: boolean;
  field: RuleField;
  matchType: RuleMatchType;
  value: string;
  actionLabelId: number | null;
  actionFolder: string | null;
  actionFolderId: number | null;
  actionMarkRead: boolean;
  actionStar: boolean;
  position: number;
}

// Which quick filters are active — combined with the current folder (and,
// once a search is running, the search query) on every list fetch.
interface QuickFilters {
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  labelId: number | null;
}
const EMPTY_FILTERS: QuickFilters = { unread: false, starred: false, hasAttachments: false, labelId: null };
function filtersActive(f: QuickFilters): boolean {
  return f.unread || f.starred || f.hasAttachments || f.labelId != null;
}
function filterQueryString(f: QuickFilters): string {
  const parts: string[] = [];
  if (f.unread) parts.push("unread=1");
  if (f.starred) parts.push("starred=1");
  if (f.hasAttachments) parts.push("hasAttachments=1");
  if (f.labelId != null) parts.push(`labelId=${f.labelId}`);
  return parts.join("&");
}

// Parses one "Name <email>" (or bare "email") string into a display name +
// bare address — client-side mirror of lib/mail-address.ts's parseAddress,
// used to drive the Contact Intelligence popover from whatever's rendered
// in a From/To/Cc line. Only handles a single address (callers split on
// "," themselves first, same as the backend does).
function parseAddressDisplay(raw: string): { name: string | null; email: string } {
  const trimmed = raw.trim();
  const m = trimmed.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (m) {
    const name = m[1]!.trim();
    return { name: name || null, email: m[2]!.trim().toLowerCase() };
  }
  return { name: null, email: trimmed.toLowerCase() };
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "";
  try { return new Date(dateStr).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return dateStr; }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Per-attachment size cap — kept in sync with MAX_ATTACHMENT_BYTES in
// routes/ayzen-mailbox.ts so a file gets rejected client-side (with a
// retryable chip) before ever hitting the network.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const isImageType = (contentType: string) => contentType.startsWith("image/");
const isPdfType = (contentType: string) => contentType === "application/pdf";
const isPreviewable = (contentType: string) => isImageType(contentType) || isPdfType(contentType);

// Icon-by-mime-type for attachment chips — Attachment System 2.0. Falls
// through to a plain document icon for anything unrecognized.
function attachmentIcon(contentType: string) {
  if (isImageType(contentType)) return ImageIcon;
  if (isPdfType(contentType)) return FileText;
  if (contentType.startsWith("video/")) return FileVideo;
  if (contentType.startsWith("audio/")) return FileAudio;
  if (contentType.includes("zip") || contentType.includes("compressed") || contentType.includes("tar")) return FileArchive;
  if (contentType.includes("sheet") || contentType.includes("csv") || contentType.includes("excel")) return FileSpreadsheet;
  return FileIcon;
}

function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || div.innerText || "";
}

// Plain-text body of a message, preferring the text part and falling back
// to a stripped version of the HTML part — used both for the list-view
// snippet and for building reply/forward quotes.
function plainBody(m: { text?: string | null; html?: string | null }): string {
  if (m.text) return m.text;
  if (m.html) return stripHtml(m.html);
  return "";
}

function snippet(m: { text?: string | null; html?: string | null }, len = 80): string {
  const s = plainBody(m).replace(/\s+/g, " ").trim();
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

function formatFull(dateStr: string | null | undefined) {
  if (!dateStr) return "";
  try { return new Date(dateStr).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
  catch { return dateStr; }
}

// "On <date>, <sender> wrote:\n> quoted line\n> quoted line" — the
// conventional reply quote block every mail client prepends.
function buildReplyQuote(m: MailboxMessageDetail, replyTarget: string): string {
  const body = plainBody(m);
  const quoted = body.split("\n").map((line) => `> ${line}`).join("\n");
  return `\n\nOn ${formatFull(m.receivedAt ?? m.createdAt)}, ${replyTarget} wrote:\n${quoted}`;
}

// Standard "---------- Forwarded message ----------" block most clients use.
function buildForwardQuote(m: MailboxMessageDetail): string {
  const body = plainBody(m);
  return `\n\n---------- Forwarded message ----------\nFrom: ${m.from}\nDate: ${formatFull(m.receivedAt ?? m.createdAt)}\nSubject: ${m.subject ?? "(no subject)"}\nTo: ${m.to}${m.cc ? `\nCc: ${m.cc}` : ""}\n\n${body}`;
}

// The References header the *next* reply in this thread should carry:
// every ancestor id this message already had, plus this message's own id.
function nextReferences(m: MailboxMessageDetail): string | undefined {
  const chain = [m.references ?? "", m.messageId ?? ""].filter(Boolean).join(" ").trim();
  return chain || undefined;
}

async function authedFetch(token: string | null, path: string, init?: RequestInit) {
  return fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

// ─── Compose dialog (also handles drafts: create, autosave, edit, send) ────
function ComposeDialog({
  open, onOpenChange, fromAddress, defaultTo, defaultCc, defaultBcc, defaultSubject, defaultInReplyTo, defaultReferences,
  draftId: initialDraftId, defaultBody, defaultBodyIsHtml, defaultAttachments, signature, signatureEnabled,
  templates, onTemplatesChanged, onSent, onDraftSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  fromAddress: string;
  defaultTo?: string;
  defaultCc?: string;
  defaultBcc?: string;
  defaultSubject?: string;
  defaultInReplyTo?: string;
  defaultReferences?: string;
  draftId?: number | null;
  // Seed body content. Reply/forward quotes and legacy plain-text drafts
  // arrive as plain text (defaultBodyIsHtml unset/false) and get escaped +
  // newline-converted before hitting the rich editor; a draft that already
  // has an htmlBody is passed through as-is (defaultBodyIsHtml: true).
  defaultBody?: string;
  defaultBodyIsHtml?: boolean;
  // Pre-attached files — used when forwarding a message with attachments,
  // so "forward" carries them along the way a real mail client does.
  defaultAttachments?: PendingAttachment[];
  // Current signature (HTML) + whether it should auto-insert into brand
  // new compose/reply/forward bodies. Editing an existing draft never
  // auto-inserts — the draft already reflects whatever the user left it as.
  signature?: string;
  signatureEnabled?: boolean;
  // Compose Templates — saved canned-response subject/body pairs the user
  // can insert here, plus save-as-template for whatever's currently typed.
  // Owned by the parent (Mailbox) so the same list backs both this dialog's
  // picker and the standalone manage-templates dialog without two fetches.
  templates: MailTemplate[];
  onTemplatesChanged: () => void;
  // opts.silent: Undo Send (Phase 1) — when the send only just landed in
  // the outbox with its undo window still open, ComposeDialog already put
  // up its own actionable "Message sent — Undo" toast (see send() below);
  // the generic "Check the Sent tab" toast every onSent caller normally
  // fires would immediately replace it (the toast hook only ever shows one
  // toast at a time), which would make Undo disappear before anyone could
  // read it, let alone tap it. Callers should skip their own toast when
  // opts?.silent is true and let the undo toast run its course instead.
  onSent: (opts?: { silent?: boolean }) => void;
  onDraftSaved?: () => void;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<RichTextEditorHandle>(null);
  const [to, setTo] = useState(defaultTo ?? "");
  const [showCc, setShowCc] = useState(!!defaultCc);
  const [cc, setCc] = useState(defaultCc ?? "");
  const [showBcc, setShowBcc] = useState(!!defaultBcc);
  const [bcc, setBcc] = useState(defaultBcc ?? "");
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [bodyHtml, setBodyHtml] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [attachments, setAttachments] = useState<PendingAttachment[]>(defaultAttachments ?? []);
  // Raw File objects for chips still in flight, keyed by PendingAttachment.id
  // — kept around only so "retry" can re-read the exact same file rather
  // than asking the user to reselect it. Never touches React state.
  const rawFiles = useRef<Map<string, File>>(new Map());
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftId, setDraftId] = useState<number | null>(initialDraftId ?? null);
  // "idle" (nothing to show) -> "pending" (typed since last save, debounce
  // running) -> "saving" -> "saved" (fades back to idle after a beat).
  const [autosaveState, setAutosaveState] = useState<"idle" | "pending" | "saving" | "saved">("idle");
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Idempotent Send: one key per compose action, sent on every Send/Retry
  // click for this same email so a double-click or a retry after a lost
  // response doesn't create (and actually send) a second copy — see the
  // idempotencyKey handling in routes/ayzen-mailbox.ts's POST /send. Only
  // regenerated when the dialog (re)opens below, never per-render, so
  // retries within the same compose session keep reusing it.
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    if (open) {
      idempotencyKeyRef.current = crypto.randomUUID();
      const seedHtml = defaultBodyIsHtml ? (defaultBody ?? "") : textToHtml(defaultBody ?? "");
      // Auto-insert the signature into fresh content (new message, reply,
      // forward) — never into an already-existing draft, which either
      // already has one baked in or the user deliberately removed it.
      const withSignature = !initialDraftId && signatureEnabled && signature?.trim()
        ? `${signature}<br><br>${seedHtml}`
        : seedHtml;
      setTo(defaultTo ?? ""); setCc(defaultCc ?? ""); setShowCc(!!defaultCc);
      setBcc(defaultBcc ?? ""); setShowBcc(!!defaultBcc);
      setSubject(defaultSubject ?? ""); setBodyHtml(withSignature);
      setAttachments(defaultAttachments ?? []); setDraftId(initialDraftId ?? null);
      setAutosaveState("idle");
      setResetKey((k) => k + 1); // forces RichTextEditor's DOM to sync to the new seed
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultTo, defaultCc, defaultBcc, defaultSubject, defaultBody, defaultBodyIsHtml, initialDraftId]);

  const plainBodyText = () => stripHtml(bodyHtml).trim();
  const isBlank = !to.trim() && !subject.trim() && !plainBodyText();

  // Saves the current fields as a draft — creates one on first save, then
  // updates the same row on subsequent saves (autosave-on-close and the
  // periodic autosave both rely on this being idempotent and cheap).
  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (isBlank) return false;
    setSavingDraft(true);
    setAutosaveState("saving");
    try {
      const payload = {
        to: to.trim(), cc: cc.trim() || undefined, bcc: bcc.trim() || undefined, subject: subject.trim(),
        html: bodyHtml, text: stripHtml(bodyHtml), inReplyTo: defaultInReplyTo, references: defaultReferences,
      };
      const res = draftId
        ? await authedFetch(token, `/ayzen-email/mailbox/drafts/${draftId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
          })
        : await authedFetch(token, `/ayzen-email/mailbox/drafts`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
          });
      if (!res.ok) { setAutosaveState("idle"); return false; }
      const data = await res.json();
      if (!draftId) setDraftId(data.id);
      onDraftSaved?.();
      setAutosaveState("saved");
      setTimeout(() => setAutosaveState((s) => (s === "saved" ? "idle" : s)), 2000);
      return true;
    } catch {
      setAutosaveState("idle");
      return false;
    } finally {
      setSavingDraft(false);
    }
  }, [isBlank, to, cc, bcc, subject, bodyHtml, defaultInReplyTo, defaultReferences, draftId, token, onDraftSaved]);

  // Periodic autosave: debounce 1.5s after the last change to any field,
  // same pattern Gmail/Docs use — don't hammer the API on every keystroke,
  // but don't require the user to remember to hit "Save draft" either.
  useEffect(() => {
    if (!open || isBlank) return;
    setAutosaveState("pending");
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => { saveDraft(); }, 1500);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, to, cc, bcc, subject, bodyHtml]);

  // Reads one File with live progress, updating the matching chip in place.
  // Kept separate from addFiles so retryAttachment() can call it again on
  // the same File without re-running the picker/drop/paste plumbing.
  const readFile = useCallback((id: string, file: File) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachments((prev) => prev.map((a) => a.id === id
        ? { ...a, status: "error", progress: 0, error: `Over ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit` }
        : a));
      return;
    }
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const progress = Math.round((e.loaded / e.total) * 100);
      setAttachments((prev) => prev.map((a) => a.id === id ? { ...a, progress } : a));
    };
    reader.onload = () => {
      const dataBase64 = String(reader.result).split(",")[1] ?? "";
      setAttachments((prev) => prev.map((a) => a.id === id ? { ...a, dataBase64, status: "ready", progress: 100 } : a));
    };
    reader.onerror = () => {
      setAttachments((prev) => prev.map((a) => a.id === id
        ? { ...a, status: "error", progress: 0, error: "Could not read file" }
        : a));
    };
    reader.readAsDataURL(file);
  }, []);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    if (!list.length) return;
    for (const file of list) {
      const id = nextAttachmentId();
      rawFiles.current.set(id, file);
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setAttachments((prev) => [...prev, {
        id, filename: file.name, contentType: file.type || "application/octet-stream",
        dataBase64: "", sizeBytes: file.size, status: "reading", progress: 0, previewUrl,
      }]);
      readFile(id, file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [readFile]);

  const retryAttachment = useCallback((id: string) => {
    const file = rawFiles.current.get(id);
    if (!file) return; // forwarded attachments have no local File to retry — remove + reattach instead
    setAttachments((prev) => prev.map((a) => a.id === id ? { ...a, status: "reading", progress: 0, error: undefined } : a));
    readFile(id, file);
  }, [readFile]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id);
      if (found?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
    rawFiles.current.delete(id);
  }, []);

  // Drag & drop onto the whole compose surface. A counter (not a plain
  // boolean) is needed because dragenter/dragleave fire on every child
  // element as the pointer crosses them, not just once for the container.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      dragCounter.current += 1;
      setDragActive(true);
    }
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragActive(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  // Paste an image straight from the clipboard (screenshot, copied image,
  // etc.) as an attachment. Plain-text/HTML paste is left alone — this only
  // intercepts when the clipboard actually contains image data, so pasting
  // text into the message body still works exactly as before.
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageFiles = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (imageFiles.length) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  }, [addFiles]);

  const insertSignature = () => {
    if (!signature?.trim()) { toast({ title: "No signature set", description: "Add one from Signature in the mailbox header" }); return; }
    editorRef.current?.insertHTML(`<br><br>${signature}`);
  };

  // Compose Templates: applying one fills in the subject only if it's still
  // blank (so replying with a template doesn't clobber a subject the user
  // already has, e.g. from a reply/forward) and inserts the body at the
  // cursor, same affordance as "Insert signature" above rather than wiping
  // out whatever's already been typed.
  const [templatesManagerOpen, setTemplatesManagerOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const applyTemplate = (t: MailTemplate) => {
    if (!subject.trim() && t.subject.trim()) setSubject(t.subject);
    if (t.bodyHtml.trim()) editorRef.current?.insertHTML(t.bodyHtml);
    toast({ title: "Template inserted", description: t.name });
  };

  // Undo Send (Phase 1): puts up the "Message sent — Undo" toast with a
  // live countdown for `windowMs` ms (server-supplied via undoWindowMs on
  // the /send response, so MAIL_UNDO_SEND_WINDOW_MS changes on the backend
  // don't need a frontend redeploy). Tapping Undo before the countdown
  // hits zero calls PATCH /:id/undo-send, which pulls the message back to
  // Drafts as long as the Send Queue worker (lib/mail-send-queue.ts)
  // hasn't claimed it yet; a tap right at the buzzer can still lose that
  // race, in which case the server comes back 409 and the toast just says
  // so — the message has already gone out by then, same as it would if
  // there were no undo window at all.
  const showUndoSendToast = (messageId: number, windowMs: number, from: string) => {
    let secondsLeft = Math.max(1, Math.ceil(windowMs / 1000));
    const { id: toastId, update, dismiss } = toast({
      title: "Message sent",
      description: `Sending from ${from}… undo within ${secondsLeft}s`,
      action: (
        <ToastAction
          altText="Undo send"
          onClick={async () => {
            clearInterval(tick);
            dismiss();
            try {
              const res = await authedFetch(token, `/ayzen-email/mailbox/${messageId}/undo-send`, { method: "PATCH" });
              const data = await res.json().catch(() => ({}));
              if (res.ok) {
                onDraftSaved?.();
                toast({ title: "Send cancelled", description: "Moved back to Drafts" });
              } else {
                toast({ variant: "destructive", title: "Couldn't undo", description: data?.error ?? "Already sent" });
              }
            } catch {
              toast({ variant: "destructive", title: "Couldn't undo", description: "Network error" });
            }
          }}
        >
          Undo
        </ToastAction>
      ),
    });
    const tick = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) { clearInterval(tick); dismiss(); return; }
      update({ id: toastId, description: `Sending from ${from}… undo within ${secondsLeft}s` } as any);
    }, 1000);
  };

  // scheduledAt: pass a future Date to queue this via Scheduled Send
  // instead of sending immediately — same /send route, just an extra
  // field (see routes/ayzen-mailbox.ts).
  // confirmFlagged: Bounce + Complaint Handling (Phase 2) — set on the
  // resend triggered by the "Send anyway?" toast action below, once the
  // user has actually confirmed sending to a recipient that's bounced
  // repeatedly. Never set on the first attempt.
  const send = async (scheduledAt?: Date, confirmFlagged = false) => {
    const text = stripHtml(bodyHtml);
    if (!to.trim() || !subject.trim() || !text.trim()) {
      toast({ variant: "destructive", title: "Missing fields", description: "To, subject and message are required" });
      return;
    }
    if (attachments.some((a) => a.status === "reading")) {
      toast({ variant: "destructive", title: "Still attaching files", description: "Wait for attachments to finish reading, or remove them" });
      return;
    }
    if (attachments.some((a) => a.status === "error")) {
      toast({ variant: "destructive", title: "Fix failed attachments first", description: "Retry or remove the attachments marked with an error" });
      return;
    }
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    setSending(true);
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: to.trim(),
          cc: cc.trim() || undefined,
          bcc: bcc.trim() || undefined,
          subject: subject.trim(),
          html: bodyHtml,
          text,
          inReplyTo: defaultInReplyTo,
          references: defaultReferences,
          draftId: draftId ?? undefined,
          scheduledSendAt: scheduledAt ? scheduledAt.toISOString() : undefined,
          idempotencyKey: idempotencyKeyRef.current,
          confirmFlaggedRecipients: confirmFlagged || undefined,
          attachments: attachments
            .filter((a) => a.status === "ready")
            .map((a) => ({ filename: a.filename, contentType: a.contentType, dataBase64: a.dataBase64 })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Bounce + Complaint Handling (Phase 2) — the two send-time gates
        // routes/ayzen-mailbox.ts's POST /send can respond with, handled
        // here instead of falling into the generic destructive-toast catch
        // below since each needs its own next step rather than just "try
        // again".
        if (data.code === "SENDING_PAUSED") {
          toast({
            variant: "destructive",
            title: "Sending is paused",
            description: data.error ?? "Review Sending Health in Settings, then resume from there.",
          });
          return;
        }
        if (data.code === "RECIPIENT_BLOCKED") {
          toast({
            variant: "destructive",
            title: "Can't send — recipient blocked",
            description: data.error ?? "This address was blocked after a spam complaint.",
          });
          return;
        }
        if (data.code === "RECIPIENT_FLAGGED" && !confirmFlagged) {
          toast({
            title: "Recipient has bounced repeatedly",
            description: data.error ?? "Send anyway?",
            action: (
              <ToastAction altText="Send anyway" onClick={() => send(scheduledAt, true)}>
                Send anyway
              </ToastAction>
            ),
          });
          return;
        }
        throw new Error(data.error ?? "Send failed");
      }
      if (data.scheduled) {
        toast({ title: "Scheduled", description: `Will send from ${fromAddress} on ${formatFull(data.scheduledSendAt)}` });
        onOpenChange(false);
        onSent();
      } else if (data.queued && data.undoWindowMs && data.id != null) {
        // Undo Send (Phase 1): the message is durably queued but the
        // Send Queue worker (lib/mail-send-queue.ts) won't actually claim
        // it until undoExpiresAt — server-derived so MAIL_UNDO_SEND_WINDOW_MS
        // changes don't need a frontend redeploy. onSent() is called with
        // { silent: true } so its usual "Check the Sent tab" toast doesn't
        // instantly clobber this one (only one toast shows at a time).
        showUndoSendToast(data.id, data.undoWindowMs, fromAddress);
        onOpenChange(false);
        onSent({ silent: true });
      } else if (data.queued) {
        // Fallback for a queued response that (for whatever reason) didn't
        // come with undo info — e.g. an older server behind a proxy cache.
        toast({ title: "Queued", description: `Sending from ${fromAddress}…` });
        onOpenChange(false);
        onSent();
      } else {
        toast({ title: "Sent", description: `Message sent from ${fromAddress}` });
        onOpenChange(false);
        onSent();
      }
    } catch (err: any) {
      toast({ variant: "destructive", title: scheduledAt ? "Could not schedule" : "Could not send", description: err?.message ?? "Network error" });
    } finally {
      setSending(false);
    }
  };

  // Cancel / close (X or backdrop): silently keep whatever's been typed as a
  // draft rather than throwing it away, same as Gmail's compose box.
  const handleOpenChange = (v: boolean) => {
    if (!v && !sending) {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      saveDraft().then((saved) => { if (saved) onDraftSaved?.(); });
    }
    onOpenChange(v);
  };

  const AutosaveIndicator = () => {
    if (autosaveState === "saving") return <span className="font-mono text-[9px] text-muted-foreground/40 flex items-center gap-1"><Loader2 className="w-2.5 h-2.5 animate-spin" /> Saving…</span>;
    if (autosaveState === "saved") return <span className="font-mono text-[9px] text-emerald-400/70 flex items-center gap-1"><Check className="w-2.5 h-2.5" /> Draft saved</span>;
    if (autosaveState === "pending") return <span className="font-mono text-[9px] text-muted-foreground/30 flex items-center gap-1"><CloudUpload className="w-2.5 h-2.5" /> Unsaved</span>;
    return null;
  };

  const attachmentsBusy = attachments.some((a) => a.status === "reading");
  const attachmentsHaveError = attachments.some((a) => a.status === "error");

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-lg"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
      >
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
            <PenSquare className="w-4 h-4 text-primary" /> {draftId ? "Edit Draft" : "New Message"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 relative">
          {dragActive && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 border-2 border-dashed border-primary rounded-lg pointer-events-none">
              <div className="flex flex-col items-center gap-1.5 text-primary">
                <UploadCloud className="w-6 h-6" />
                <span className="font-mono text-xs uppercase tracking-wider">Drop to attach</span>
              </div>
            </div>
          )}
          <p className="font-mono text-[10px] text-muted-foreground/50">From <span className="text-primary">{fromAddress}</span></p>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">To</Label>
              <div className="flex items-center gap-2">
                {!showCc && (
                  <button onClick={() => setShowCc(true)} className="font-mono text-[10px] text-muted-foreground/40 hover:text-primary">+ Cc</button>
                )}
                {!showBcc && (
                  <button onClick={() => setShowBcc(true)} className="font-mono text-[10px] text-muted-foreground/40 hover:text-primary">+ Bcc</button>
                )}
              </div>
            </div>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="someone@example.com" className="font-mono text-xs" />
          </div>
          {showCc && (
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Cc</Label>
              <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="someone@example.com" className="font-mono text-xs" />
            </div>
          )}
          {showBcc && (
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Bcc</Label>
              <Input value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="someone@example.com" className="font-mono text-xs" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Message</Label>
            <RichTextEditor
              ref={editorRef}
              html={bodyHtml}
              resetKey={resetKey}
              onChange={setBodyHtml}
              placeholder="Write your message… (you can paste an image, or drag files anywhere in this window)"
            />
          </div>

          {attachments.length > 0 && (
            <div className="space-y-1.5">
              {attachments.map((a) => {
                const Icon = attachmentIcon(a.contentType);
                return (
                  <div key={a.id} className="flex items-center gap-2.5 bg-muted/10 border border-border/20 rounded px-2.5 py-1.5">
                    {a.previewUrl ? (
                      <img src={a.previewUrl} alt="" className="w-7 h-7 rounded object-cover flex-shrink-0 border border-border/30" />
                    ) : (
                      <Icon className={cn("w-3.5 h-3.5 flex-shrink-0", a.status === "error" ? "text-red-400" : "text-muted-foreground/50")} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] flex-1 truncate">{a.filename}</span>
                        <span className="font-mono text-[9px] text-muted-foreground/40 flex-shrink-0">{formatBytes(a.sizeBytes)}</span>
                      </div>
                      {a.status === "reading" && (
                        <div className="h-1 mt-1 bg-muted/20 rounded-full overflow-hidden">
                          <div className="h-full bg-primary transition-all duration-150" style={{ width: `${a.progress}%` }} />
                        </div>
                      )}
                      {a.status === "error" && (
                        <p className="font-mono text-[9px] text-red-400 mt-0.5 flex items-center gap-1">
                          <AlertCircle className="w-2.5 h-2.5" /> {a.error ?? "Upload failed"}
                        </p>
                      )}
                    </div>
                    {a.status === "error" && rawFiles.current.has(a.id) && (
                      <button onClick={() => retryAttachment(a.id)} title="Retry" className="text-muted-foreground/40 hover:text-primary flex-shrink-0">
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    )}
                    <button onClick={() => removeAttachment(a.id)} title="Remove" className="text-muted-foreground/40 hover:text-red-400 flex-shrink-0">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="font-mono text-[10px] gap-1.5">
              <Paperclip className="w-3 h-3" />
              Attach files
            </Button>
            <Button variant="outline" size="sm" onClick={insertSignature} className="font-mono text-[10px] gap-1.5">
              <PenTool className="w-3 h-3" />
              Insert signature
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="font-mono text-[10px] gap-1.5">
                  <LayoutTemplate className="w-3 h-3" />
                  Templates
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="font-mono text-xs w-56">
                {templates.length === 0 ? (
                  <div className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground/40">No templates yet</div>
                ) : (
                  <>
                    <DropdownMenuLabel className="font-mono text-[10px] uppercase text-muted-foreground/50">Insert</DropdownMenuLabel>
                    {templates.map((t) => (
                      <DropdownMenuItem key={t.id} onClick={() => applyTemplate(t)} className="gap-2 text-xs truncate">
                        <LayoutTemplate className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/50" /> <span className="truncate">{t.name}</span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem
                  onClick={() => setSaveTemplateOpen(true)}
                  disabled={!subject.trim() && !plainBodyText()}
                  className="gap-2 text-xs"
                >
                  <Save className="w-3.5 h-3.5" /> Save as template
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTemplatesManagerOpen(true)} className="gap-2 text-xs">
                  <Pencil className="w-3.5 h-3.5" /> Manage templates
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="font-mono text-[9px] text-muted-foreground/30">or drag & drop, or paste an image</span>
          </div>
        </div>
        <DialogFooter className="flex items-center justify-between sm:justify-between gap-2">
          <div className="flex items-center gap-2 mr-auto">
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => { const saved = await saveDraft(); if (saved) toast({ title: "Draft saved" }); }}
              disabled={savingDraft || isBlank}
              className="font-mono text-[10px] gap-1.5"
            >
              {savingDraft ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileEdit className="w-3 h-3" />}
              Save draft
            </Button>
            <AutosaveIndicator />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => handleOpenChange(false)} className="font-mono text-xs">Cancel</Button>
            <div className="flex items-center rounded-md overflow-hidden">
              <Button
                onClick={() => send()}
                disabled={sending || attachmentsBusy || attachmentsHaveError}
                className="font-mono text-xs gap-1.5 rounded-r-none"
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {sending ? "Sending…" : attachmentsBusy ? "Attaching…" : "Send now"}
              </Button>
              <ScheduleSendMenu
                onSchedule={(at) => send(at)}
                trigger={
                  <Button
                    disabled={sending || attachmentsBusy || attachmentsHaveError}
                    className="font-mono text-xs px-1.5 rounded-l-none border-l border-primary-foreground/20"
                    title="Schedule send"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </Button>
                }
              />
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <SaveTemplateDialog
      open={saveTemplateOpen}
      onOpenChange={setSaveTemplateOpen}
      token={token}
      subject={subject}
      bodyHtml={bodyHtml}
      onSaved={onTemplatesChanged}
    />
    <TemplatesManagerDialog
      open={templatesManagerOpen}
      onOpenChange={setTemplatesManagerOpen}
      token={token}
      templates={templates}
      onChanged={onTemplatesChanged}
    />
    </>
  );
}

// ─── Save current compose as a new template ─────────────────────────────────
// Small standalone prompt (name only — subject/body come from whatever the
// compose box currently holds) rather than folding into TemplatesManagerDialog,
// since it's launched mid-compose and shouldn't require navigating a list.
function SaveTemplateDialog({
  open, onOpenChange, token, subject, bodyHtml, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  token: string | null;
  subject: string;
  bodyHtml: string;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setName(""); }, [open]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, subject, bodyHtml }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save template");
      onSaved();
      onOpenChange(false);
      toast({ title: "Template saved", description: trimmed });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not save template", description: err?.message ?? "Network error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
            <Save className="w-4 h-4 text-primary" /> Save as Template
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Template name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder="e.g. Invoice follow-up"
            className="font-mono text-xs"
            autoFocus
            maxLength={60}
          />
          <p className="font-mono text-[9px] text-muted-foreground/40">Saves the current subject and message body — you can edit either later from Manage templates.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="font-mono text-xs">Cancel</Button>
          <Button onClick={save} disabled={saving || !name.trim()} className="font-mono text-xs gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Manage templates dialog ────────────────────────────────────────────────
// List existing templates (rename/edit/delete) plus a "New template" form —
// single dialog, same shape as RulesDialog below, since the expected count
// per user is small (a handful of canned responses, not hundreds).
function TemplatesManagerDialog({
  open, onOpenChange, token, templates, onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  token: string | null;
  templates: MailTemplate[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<MailTemplate | "new" | null>(null);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MailTemplate | null>(null);
  const editorRef = useRef<RichTextEditorHandle>(null);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => { if (!open) setEditing(null); }, [open]);

  const startEdit = (t: MailTemplate | "new") => {
    setEditing(t);
    setName(t === "new" ? "" : t.name);
    setSubject(t === "new" ? "" : t.subject);
    setBody(t === "new" ? "" : t.bodyHtml);
    setResetKey((k) => k + 1);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || !editing) return;
    setSaving(true);
    try {
      const isNew = editing === "new";
      const res = await authedFetch(
        token,
        isNew ? `/ayzen-email/mailbox/templates` : `/ayzen-email/mailbox/templates/${editing.id}`,
        { method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: trimmed, subject, bodyHtml: body }) },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save template");
      onChanged();
      setEditing(null);
      toast({ title: isNew ? "Template created" : "Template saved" });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not save template", description: err?.message ?? "Network error" });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/templates/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error ?? "Could not delete template"); }
      onChanged();
      if (editing !== "new" && editing?.id === deleteTarget.id) setEditing(null);
      toast({ title: "Template deleted" });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not delete template", description: err?.message ?? "Network error" });
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
              <LayoutTemplate className="w-4 h-4 text-primary" /> Manage Templates
            </DialogTitle>
          </DialogHeader>

          {editing ? (
            <div className="space-y-3">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Template name"
                className="font-mono text-xs"
                autoFocus
                maxLength={60}
              />
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject (optional — leave blank to not touch the compose subject)"
                className="font-mono text-xs"
              />
              <RichTextEditor
                ref={editorRef}
                html={body}
                resetKey={resetKey}
                onChange={setBody}
                placeholder="Template body…"
              />
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" onClick={() => setEditing(null)} className="font-mono text-xs">Back</Button>
                <div className="flex items-center gap-2">
                  {editing !== "new" && (
                    <Button variant="ghost" onClick={() => setDeleteTarget(editing)} className="font-mono text-xs text-red-400/80 gap-1.5">
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </Button>
                  )}
                  <Button onClick={save} disabled={saving || !name.trim()} className="font-mono text-xs gap-1.5">
                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Save
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {templates.length === 0 ? (
                <p className="font-mono text-[10px] text-muted-foreground/40 py-2">
                  No templates yet. Save one from the compose box's Templates menu, or create one here.
                </p>
              ) : (
                <div className="space-y-1.5 max-h-80 overflow-y-auto">
                  {templates.map((t) => (
                    <div key={t.id} className="flex items-center gap-2 bg-muted/10 border border-border/20 rounded px-2.5 py-1.5">
                      <LayoutTemplate className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-xs truncate">{t.name}</p>
                        {t.subject && <p className="font-mono text-[9px] text-muted-foreground/40 truncate">{t.subject}</p>}
                      </div>
                      <button onClick={() => startEdit(t)} title="Edit" className="text-muted-foreground/40 hover:text-primary flex-shrink-0">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setDeleteTarget(t)} title="Delete" className="text-muted-foreground/40 hover:text-red-400 flex-shrink-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Button variant="outline" size="sm" onClick={() => startEdit("new")} className="font-mono text-xs gap-1.5 w-full">
                <Plus className="w-3.5 h-3.5" /> New template
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm">Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs">This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="font-mono text-xs bg-red-500/90 hover:bg-red-500 text-white">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Move-to-folder menu ────────────────────────────────────────────────────
function MoveToMenu({
  current, systemFolders, customFolders, onMove, trigger,
}: {
  current: ActiveFolder;
  systemFolders: FolderCounts[];
  customFolders: CustomFolder[];
  onMove: (folder: SystemFolderKey | "custom", folderId: number | null) => void;
  trigger: React.ReactNode;
}) {
  const isCurrent = (folder: string, folderId: number | null) =>
    current.folder === folder && (folder !== "custom" || current.folderId === folderId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="font-mono text-xs">
        <DropdownMenuLabel className="font-mono text-[10px] uppercase text-muted-foreground/50">Move to</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {systemFolders.filter((f) => !NON_MOVE_TARGET_FOLDERS.has(f.key as SystemFolderKey)).map((f) => {
          const Icon = FOLDER_ICONS[f.key as SystemFolderKey];
          return (
            <DropdownMenuItem key={f.key} disabled={isCurrent(f.key, null)} onClick={() => onMove(f.key as SystemFolderKey, null)} className="gap-2 text-xs">
              <Icon className="w-3.5 h-3.5" /> {f.label}
            </DropdownMenuItem>
          );
        })}
        {customFolders.length > 0 && <DropdownMenuSeparator />}
        {customFolders.map((f) => (
          <DropdownMenuItem key={f.id} disabled={isCurrent("custom", f.id)} onClick={() => onMove("custom", f.id)} className="gap-2 text-xs">
            <Folder className="w-3.5 h-3.5" /> {f.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Snooze menu (presets + custom date/time) ───────────────────────────────
// Shared by the per-row quick action, the thread-detail header, and the bulk
// action bar. `onSnooze` receives a real Date already validated to be in the
// future — callers just need to send it to the snooze route/bulk action.
function SnoozeMenu({ onSnooze, trigger }: { onSnooze: (until: Date) => void; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const pick = (at: Date) => { onSnooze(at); setOpen(false); };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="font-mono text-xs">
          <DropdownMenuLabel className="font-mono text-[10px] uppercase text-muted-foreground/50">Snooze until</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {SNOOZE_PRESETS.map((p) => (
            <DropdownMenuItem key={p.label} onClick={() => pick(p.at())} className="gap-2 text-xs">
              <Clock className="w-3.5 h-3.5" /> {p.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setCustomValue(""); setCustomOpen(true); setOpen(false); }} className="gap-2 text-xs">
            <CalendarClock className="w-3.5 h-3.5" /> Pick date &amp; time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-primary" /> Snooze until
            </DialogTitle>
          </DialogHeader>
          <Input
            type="datetime-local"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            className="font-mono text-xs"
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCustomOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button
              disabled={!customValue}
              onClick={() => {
                const d = new Date(customValue);
                if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) { onSnooze(d); setCustomOpen(false); }
              }}
              className="font-mono text-xs"
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Schedule Send menu (Tomorrow morning / evening / custom date+time) ────
// Same shape as SnoozeMenu above — onSchedule receives a real Date already
// validated to be in the future.
const SCHEDULE_PRESETS: { label: string; at: () => Date }[] = [
  { label: "Tomorrow morning", at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
  { label: "Tomorrow evening", at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); return d; } },
];

function ScheduleSendMenu({ onSchedule, trigger }: { onSchedule: (at: Date) => void; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const pick = (at: Date) => { onSchedule(at); setOpen(false); };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="font-mono text-xs">
          <DropdownMenuLabel className="font-mono text-[10px] uppercase text-muted-foreground/50">Schedule send</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {SCHEDULE_PRESETS.map((p) => (
            <DropdownMenuItem key={p.label} onClick={() => pick(p.at())} className="gap-2 text-xs">
              <CalendarClock className="w-3.5 h-3.5" /> {p.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setCustomValue(""); setCustomOpen(true); setOpen(false); }} className="gap-2 text-xs">
            <Clock className="w-3.5 h-3.5" /> Pick date &amp; time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-primary" /> Schedule send
            </DialogTitle>
          </DialogHeader>
          <Input
            type="datetime-local"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            className="font-mono text-xs"
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCustomOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button
              disabled={!customValue}
              onClick={() => {
                const d = new Date(customValue);
                if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) { onSchedule(d); setCustomOpen(false); }
              }}
              className="font-mono text-xs"
            >
              Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Contact Intelligence popover ──────────────────────────────────────────
// Everything the mailbox itself knows about one address — fetched lazily
// the moment the popover opens, not eagerly for every address on screen.
interface ContactInfo {
  email: string; name: string | null; emailCount: number; attachmentCount: number;
  lastInteraction: string | null; isContact: boolean;
}

function ContactPopover({ address, onReply, onViewConversation }: {
  address: string;
  // Reply/View conversation are only meaningful when the popover is opened
  // from a message actually on screen — omit them (e.g. from a plain
  // recipient list) and those buttons just don't render.
  onReply?: () => void;
  onViewConversation?: () => void;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ContactInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const parsed = parseAddressDisplay(address);

  const load = useCallback(() => {
    if (!parsed.email) return;
    setLoading(true);
    authedFetch(token, `/ayzen-email/mailbox/contacts/${encodeURIComponent(parsed.email)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => setInfo(data))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [token, parsed.email]);

  const addContact = async () => {
    setSavingContact(true);
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/contacts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: parsed.email, name: info?.name ?? parsed.name ?? undefined }),
      });
      if (!res.ok) throw new Error("Could not save contact");
      toast({ title: "Contact saved" });
      setInfo((prev) => prev ? { ...prev, isContact: true } : prev);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not save contact", description: err?.message ?? "Network error" });
    } finally {
      setSavingContact(false);
    }
  };

  if (!parsed.email) return <span className="text-foreground/80">{address}</span>;

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v && !info) load(); }}>
      <PopoverTrigger asChild>
        <button className="text-foreground/80 hover:text-primary underline decoration-dotted underline-offset-2 text-left" title="Contact info">
          {address}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 font-mono text-xs" align="start">
        {loading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-primary" /></div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                <UserCircle2 className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold truncate">{info?.name || parsed.name || parsed.email}</p>
                <p className="text-[10px] text-muted-foreground/50 truncate">{parsed.email}</p>
              </div>
            </div>
            {info && (info.emailCount > 0 ? (
              <div className="space-y-1 border-t border-border/20 pt-2.5">
                {info.lastInteraction && (
                  <p className="text-[10px] text-muted-foreground/50">Last interaction <span className="text-foreground/70">{formatDate(info.lastInteraction)}</span></p>
                )}
                <p className="text-[10px] text-muted-foreground/50">{info.emailCount} email{info.emailCount === 1 ? "" : "s"}</p>
                {info.attachmentCount > 0 && (
                  <p className="text-[10px] text-muted-foreground/50">{info.attachmentCount} attachment{info.attachmentCount === 1 ? "" : "s"}</p>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground/40 border-t border-border/20 pt-2.5">No mail exchanged with this address yet</p>
            ))}
            <div className="flex items-center gap-1.5 flex-wrap pt-1">
              {onReply && (
                <Button size="sm" variant="outline" onClick={() => { setOpen(false); onReply(); }} className="font-mono text-[10px] gap-1 h-7">
                  <Reply className="w-3 h-3" /> Reply
                </Button>
              )}
              {onViewConversation && (
                <Button size="sm" variant="outline" onClick={() => { setOpen(false); onViewConversation(); }} className="font-mono text-[10px] gap-1 h-7">
                  <Mail className="w-3 h-3" /> View conversation
                </Button>
              )}
              <Button
                size="sm" variant="outline" onClick={addContact} disabled={savingContact || info?.isContact}
                className="font-mono text-[10px] gap-1 h-7"
              >
                {savingContact ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                {info?.isContact ? "Saved" : "Add contact"}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Label picker menu (toggle labels on a single message) ─────────────────
function LabelPickerMenu({
  labels, selectedIds, onToggle, trigger,
}: {
  labels: LabelWithCount[];
  selectedIds: number[];
  onToggle: (labelId: number) => void;
  trigger: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="font-mono text-xs">
        <DropdownMenuLabel className="font-mono text-[10px] uppercase text-muted-foreground/50">Labels</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {labels.length === 0 ? (
          <div className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground/40">No labels yet</div>
        ) : (
          labels.map((l) => (
            <DropdownMenuCheckboxItem
              key={l.id}
              checked={selectedIds.includes(l.id)}
              onCheckedChange={() => onToggle(l.id)}
              onSelect={(e) => e.preventDefault()}
              className="gap-2 text-xs"
            >
              <LabelDot color={l.color} /> {l.name}
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Message detail ─────────────────────────────────────────────────────────
// What ComposeDialog needs to open pre-filled for a reply/reply-all/forward
// off a specific message in the thread.
interface DraftSeed {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: PendingAttachment[];
}

function ThreadDetail({
  id, onBack, onChanged, onOptimisticRemoveThread, fromAddress, activeFolder, systemFolders, customFolders, signature, signatureEnabled,
  templates, onTemplatesChanged, labels, onToggleLabel,
}: {
  id: number;
  onBack: () => void;
  onChanged: () => void;
  // Whole Conversation Actions Phase 3 (optimistic UI): lets this component
  // tell the parent list "this conversation is leaving the current folder"
  // the instant a whole-conversation Archive/Move/Delete is triggered,
  // rather than after the request round-trips. See trashOrDeleteForever /
  // move below for where this actually fires.
  onOptimisticRemoveThread: (threadId: string) => void;
  fromAddress: string;
  activeFolder: ActiveFolder;
  systemFolders: FolderCounts[];
  customFolders: CustomFolder[];
  signature?: string;
  signatureEnabled?: boolean;
  templates: MailTemplate[];
  onTemplatesChanged: () => void;
  labels: LabelWithCount[];
  onToggleLabel: (messageId: number, labelId: number, previousIds: number[]) => void;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [messages, setMessages] = useState<MailboxMessageDetail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirmForever, setConfirmForever] = useState(false);
  const [draftSeed, setDraftSeed] = useState<DraftSeed | null>(null);
  const [preparingForward, setPreparingForward] = useState<number | null>(null);
  // Whole Conversation Actions Phase 2: lets someone override the
  // Phase 1 default (Star/Mark read-unread/Archive/Move/Delete apply to
  // every message in the conversation) back down to just the message they
  // opened — for the rare case a 12-message thread needs one specific
  // reply archived on its own rather than the whole thing. Resets to the
  // whole-conversation default every time a different thread is opened
  // (see the id/token effect below), so it's never silently "sticky" onto
  // a conversation the user didn't mean to scope down.
  const [wholeConversation, setWholeConversation] = useState(true);

  useEffect(() => {
    setLoading(true);
    setMessages(null);
    setWholeConversation(true);
    // The opened row's own message tells us which conversation (threadId)
    // it belongs to; the thread route then returns every message in it.
    authedFetch(token, `/ayzen-email/mailbox/${id}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return null;
        return authedFetch(token, `/ayzen-email/mailbox/thread/${encodeURIComponent(data.threadId)}?anchor=${id}`)
          .then((r) => r.ok ? r.json() as Promise<ThreadResponse> : null);
      })
      .then((thread) => {
        if (!thread) { setMessages(null); return; }
        setMessages(thread.messages);
        setExpandedId(thread.messages[thread.messages.length - 1]?.id ?? null);
        onChanged();
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token]);

  // Snooze / Reschedule / Cancel send / Spam report / Labels stay anchored
  // to the specific message that was actually opened from the list — each
  // only makes sense for one message's own state (its folder, its own
  // scheduledSendAt, its own label set), not a whole conversation's.
  const anchor = messages?.find((m) => m.id === id) ?? messages?.[messages.length - 1] ?? null;

  // ─── Whole Conversation Actions ───────────────────────────────────────
  // Star / Archive / Move / Delete / Mark read-unread act on every message
  // currently in this conversation by default (every id in `messages` —
  // the thread route excludes Trash rows unless this is itself a trashed
  // conversation being opened from Trash, see the `anchor` query param on
  // GET /mailbox/thread/:threadId), not just the one message that happened
  // to be opened from the list. `wholeConversation` (state above) lets
  // that be scoped back down to just the anchor message — see
  // CHANGES_CONVERSATION_ACTIONS.md and CHANGES_CONVERSATION_ACTIONS_PHASE2.md
  // for the full rationale.
  //
  // Reuses PATCH /ayzen-email/mailbox/bulk, the same endpoint the list's
  // multi-select bulk bar already drives (see runBulkAction below in the
  // parent), just with this thread's own message ids standing in for a
  // user-picked selection — no new backend route needed.
  //
  // `scopedIds`/`scopedMessages` are what Star/Mark read-unread/Archive/
  // Move/Delete actually operate on: every message in the thread by
  // default, or just the anchor when `wholeConversation` has been toggled
  // off (see the state declaration above).
  const scopedMessages = wholeConversation ? (messages ?? []) : (anchor ? [anchor] : []);
  const scopedIds = scopedMessages.map((m) => m.id);

  const runThreadAction = async (body: Record<string, unknown>, successTitle: string): Promise<boolean> => {
    if (!scopedIds.length) return false;
    const res = await authedFetch(token, `/ayzen-email/mailbox/bulk`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: scopedIds, ...body }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast({ variant: "destructive", title: "Action failed", description: data?.error ?? "Network error" });
      // Something may already have been optimistically removed from the
      // parent list before this resolved (see trashOrDeleteForever/move
      // below) — resync against the server rather than leaving that stale.
      onChanged();
      return false;
    }
    toast({ title: successTitle });
    onChanged();
    return true;
  };

  // Gmail-style "any starred = filled star" — clicking stars every message
  // in scope if none currently carry a star, or clears the star from all
  // of them if any do. With `wholeConversation` off this collapses to
  // exactly the anchor message's own state, i.e. the original Phase-0
  // single-message toggle.
  const anyStarred = scopedMessages.some((m) => m.isStarred);
  const toggleStar = async () => {
    const nextStarred = !anyStarred;
    const ok = await runThreadAction(
      { action: nextStarred ? "star" : "unstar" },
      nextStarred
        ? (wholeConversation ? "Starred conversation" : "Starred message")
        : (wholeConversation ? "Removed star from conversation" : "Removed star from message"),
    );
    if (ok) {
      const scoped = new Set(scopedIds);
      setMessages((prev) => prev?.map((m) => scoped.has(m.id) ? { ...m, isStarred: nextStarred } : m) ?? prev);
    }
  };

  // Same idea for read state — any unread inbound message in scope reads
  // as "unread" overall, matching how the list's own threadUnread rollup
  // already works (see GET /mailbox above).
  const anyUnread = scopedMessages.some((m) => !m.isRead && m.direction === "inbound");
  const markThreadRead = async (read: boolean) => {
    const ok = await runThreadAction(
      { action: read ? "markRead" : "markUnread" },
      read
        ? (wholeConversation ? "Marked conversation as read" : "Marked message as read")
        : (wholeConversation ? "Marked conversation as unread" : "Marked message as unread"),
    );
    if (ok) {
      const scoped = new Set(scopedIds);
      setMessages((prev) => prev?.map((m) => scoped.has(m.id) ? { ...m, isRead: read } : m) ?? prev);
    }
  };

  // "Move" here is genuinely whole-conversation by default (Archive button
  // + the Move menu, both explicitly in scope) — every message in the
  // thread moves together, unless scoped down to just the anchor above.
  //
  // Optimistic in the whole-conversation case: the conversation is
  // guaranteed to be leaving the currently active folder either way (it's
  // moving somewhere else entirely), so there's no ambiguity to wait on —
  // drop the row from the parent's list and navigate back immediately,
  // let the actual request finish in the background. The "this message
  // only" case stays non-optimistic: a single message leaving the
  // conversation doesn't necessarily mean the conversation's own row
  // should disappear from the current folder (other messages in it may
  // still be sitting right there), so that one genuinely needs the
  // response before deciding what the list should show.
  const move = async (folder: SystemFolderKey | "custom", folderId: number | null) => {
    const label = folder === "custom" ? customFolders.find((f) => f.id === folderId)?.name : FOLDER_LABELS[folder];
    const dest = label ?? folder;
    if (wholeConversation) {
      const threadId = messages?.[0]?.threadId;
      if (threadId) onOptimisticRemoveThread(threadId);
      onBack();
      await runThreadAction({ action: "move", folder, folderId }, `Moved conversation to ${dest}`);
      return;
    }
    const ok = await runThreadAction({ action: "move", folder, folderId }, `Moved message to ${dest}`);
    if (ok) onBack();
  };

  // Report spam / Not spam / Restore stay anchor-scoped (single message),
  // same as Snooze/Reschedule above — not part of this feature's explicit
  // scope, and each has folder-conditional logic that doesn't generalize
  // to "every message in the thread" cleanly: bulk-moving a whole
  // conversation to Spam would also drag along the user's own outbound
  // replies in it, which was never Gmail/Outlook's model for "report spam"
  // either — that only ever targets the one message that triggered it.
  const moveAnchor = async (folder: SystemFolderKey | "custom", folderId: number | null) => {
    if (!anchor) return;
    const res = await authedFetch(token, `/ayzen-email/mailbox/${anchor.id}/move`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder, folderId }),
    });
    if (res.ok) {
      const label = folder === "custom" ? customFolders.find((f) => f.id === folderId)?.name : FOLDER_LABELS[folder];
      toast({ title: `Moved to ${label ?? folder}` });
      onChanged();
      onBack();
    }
  };

  const snooze = async (until: Date) => {
    if (!anchor) return;
    const res = await authedFetch(token, `/ayzen-email/mailbox/${anchor.id}/snooze`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ until: until.toISOString() }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      toast({ title: `Snoozed until ${formatFull(until.toISOString())}` });
      onChanged();
      onBack();
    } else {
      toast({ variant: "destructive", title: "Could not snooze", description: data?.error ?? "Network error" });
    }
  };

  const unsnooze = async () => {
    if (!anchor) return;
    const res = await authedFetch(token, `/ayzen-email/mailbox/${anchor.id}/unsnooze`, { method: "PATCH" });
    if (res.ok) { toast({ title: "Moved back to Inbox" }); onChanged(); onBack(); }
  };

  const reschedule = async (at: Date) => {
    if (!anchor) return;
    const res = await authedFetch(token, `/ayzen-email/mailbox/${anchor.id}/reschedule`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheduledSendAt: at.toISOString() }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      toast({ title: `Rescheduled for ${formatFull(at.toISOString())}` });
      onChanged();
      onBack();
    } else {
      toast({ variant: "destructive", title: "Could not reschedule", description: data?.error ?? "Network error" });
    }
  };

  const cancelSchedule = async () => {
    if (!anchor) return;
    const res = await authedFetch(token, `/ayzen-email/mailbox/${anchor.id}/cancel-schedule`, { method: "PATCH" });
    if (res.ok) { toast({ title: "Send cancelled", description: "Moved back to Drafts" }); onChanged(); onBack(); }
  };

  // Same optimistic-update pattern as toggleStar above: PATCH the message's
  // full desired label set, then patch local state rather than refetching
  // the whole thread. onToggleLabel (from the parent) just refreshes the
  // Labels rail's per-label counts — it doesn't touch this component's
  // own `messages` state.
  const toggleLabel = async (messageId: number, labelId: number) => {
    const m = messages?.find((msg) => msg.id === messageId);
    if (!m) return;
    const current = m.labels.map((l) => l.id);
    const nextIds = current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId];
    const res = await authedFetch(token, `/ayzen-email/mailbox/${messageId}/labels`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labelIds: nextIds }),
    });
    if (res.ok) {
      const nextLabels = labels.filter((l) => nextIds.includes(l.id));
      setMessages((prev) => prev?.map((msg) => msg.id === messageId ? { ...msg, labels: nextLabels } : msg) ?? prev);
      onToggleLabel(messageId, labelId, current);
    }
  };

  // Whole-conversation (or, scoped down, single-message) delete. Same
  // two-stage rule PATCH /bulk's "delete" action already enforces per-id
  // (see routes/ayzen-mailbox.ts) — only messages already sitting in Trash
  // actually get destroyed; anything else in scope just moves to Trash
  // instead. The confirm dialog only fires when *every* message currently
  // in scope is already trashed, i.e. this click can only mean "delete
  // forever" — checked across whatever's in scope, whole thread or just
  // the anchor.
  //
  // Same optimistic-vs-not split as move() above: whole-conversation Trash
  // is unambiguous (the row is leaving this folder no matter what), so
  // drop it immediately and let the request finish in the background;
  // "this message only" waits for the response, same reasoning as move().
  const allTrashed = scopedMessages.length > 0 && scopedMessages.every((m) => m.folder === "trash");
  const scopeLabel = wholeConversation ? "conversation" : "message";
  const trashOrDeleteForever = async () => {
    if (allTrashed) { setConfirmForever(true); return; }
    if (wholeConversation) {
      const threadId = messages?.[0]?.threadId;
      if (threadId) onOptimisticRemoveThread(threadId);
      onBack();
      await runThreadAction({ action: "trash" }, "Conversation moved to Trash");
      return;
    }
    const ok = await runThreadAction({ action: "trash" }, "Message moved to Trash");
    if (ok) onBack();
  };

  const deleteForever = async () => {
    setConfirmForever(false);
    if (wholeConversation) {
      const threadId = messages?.[0]?.threadId;
      if (threadId) onOptimisticRemoveThread(threadId);
      onBack();
      await runThreadAction({ action: "delete" }, "Conversation deleted permanently");
      return;
    }
    const ok = await runThreadAction({ action: "delete" }, "Message deleted permanently");
    if (ok) onBack();
  };

  const downloadAttachment = async (msgId: number, att: MailboxAttachment) => {
    const key = `${msgId}:${att.id}`;
    setDownloadingKey(key);
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/${msgId}/attachments/${att.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Download failed");
      const blob = await (await fetch(`data:${data.contentType};base64,${data.dataBase64}`)).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = data.filename || att.filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not download", description: err?.message ?? "Network error" });
    } finally {
      setDownloadingKey(null);
    }
  };

  // Download every attachment on a message as one .zip — hits the
  // dedicated backend route (routes/ayzen-mailbox.ts, lib/zip-writer.ts)
  // rather than zipping client-side, so large/multiple attachments never
  // have to round-trip through the browser twice.
  const downloadAllAttachments = async (msgId: number) => {
    setDownloadingKey(`${msgId}:all`);
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/${msgId}/attachments/download-all`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `mail-${msgId}-attachments.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not download all", description: err?.message ?? "Network error" });
    } finally {
      setDownloadingKey(null);
    }
  };

  // Fetches every attachment's bytes so forward can carry them along —
  // same download endpoint the attachment list already uses, just kept in
  // memory as base64 instead of triggering a file save.
  const fetchAttachmentsAsPending = async (m: MailboxMessageDetail): Promise<PendingAttachment[]> => {
    const out: PendingAttachment[] = [];
    for (const att of m.attachments) {
      const res = await authedFetch(token, `/ayzen-email/mailbox/${m.id}/attachments/${att.id}`);
      const data = await res.json();
      if (res.ok) out.push(toReadyAttachment({
        filename: data.filename || att.filename, contentType: data.contentType || att.contentType,
        dataBase64: data.dataBase64, sizeBytes: att.sizeBytes,
      }));
    }
    return out;
  };

  // ─── Inline image thumbnails + PDF/image lightbox preview ────────────────
  // Image attachments render as small inline thumbnails once a message is
  // expanded (fetched lazily, cached by "msgId:attId" so re-expanding the
  // same message doesn't refetch). Clicking a thumbnail — or the Preview
  // button on a PDF chip — opens the same lightbox dialog full-size.
  const [inlinePreviews, setInlinePreviews] = useState<Map<string, string>>(new Map());
  const inlineFetching = useRef<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<{ filename: string; contentType: string; dataUrl: string } | null>(null);
  const [previewLoadingKey, setPreviewLoadingKey] = useState<string | null>(null);

  const fetchPreviewDataUrl = async (msgId: number, att: MailboxAttachment): Promise<string | null> => {
    const key = `${msgId}:${att.id}`;
    if (inlinePreviews.has(key)) return inlinePreviews.get(key)!;
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/${msgId}/attachments/${att.id}`);
      const data = await res.json();
      if (!res.ok) return null;
      const dataUrl = `data:${data.contentType};base64,${data.dataBase64}`;
      setInlinePreviews((prev) => new Map(prev).set(key, dataUrl));
      return dataUrl;
    } catch {
      return null;
    }
  };

  // Auto-load thumbnails for every image attachment on the currently
  // expanded message — the same lazy fetch openPreview() uses, just fired
  // automatically instead of waiting for a click, since a small inline
  // thumbnail is the whole point of "inline images".
  useEffect(() => {
    if (expandedId == null || !messages) return;
    const m = messages.find((msg) => msg.id === expandedId);
    if (!m) return;
    for (const att of m.attachments) {
      if (!isImageType(att.contentType)) continue;
      const key = `${m.id}:${att.id}`;
      if (inlinePreviews.has(key) || inlineFetching.current.has(key)) continue;
      inlineFetching.current.add(key);
      fetchPreviewDataUrl(m.id, att).finally(() => inlineFetching.current.delete(key));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId, messages]);

  const openPreview = async (msgId: number, att: MailboxAttachment) => {
    const key = `${msgId}:${att.id}`;
    setPreviewLoadingKey(key);
    const dataUrl = await fetchPreviewDataUrl(msgId, att);
    setPreviewLoadingKey(null);
    if (!dataUrl) { toast({ variant: "destructive", title: "Could not load preview" }); return; }
    setLightbox({ filename: att.filename, contentType: att.contentType, dataUrl });
  };

  const replyTargetOf = (m: MailboxMessageDetail) => (m.direction === "outbound" ? m.to : m.from);


  const startReply = (m: MailboxMessageDetail, all: boolean) => {
    const target = replyTargetOf(m);
    // Reply-all folds in everyone else on the message (original recipients
    // + cc) minus our own address, so we don't loop mail back to ourselves.
    const ccList = all
      ? Array.from(new Set(
          [m.to, m.cc].filter(Boolean).flatMap((s) => s!.split(",")).map((s) => s.trim())
            .filter((addr) => addr && addr.toLowerCase() !== target.toLowerCase() && addr.toLowerCase() !== fromAddress.toLowerCase()),
        )).join(", ")
      : undefined;
    setDraftSeed({
      to: target,
      cc: ccList || undefined,
      subject: m.subject?.toLowerCase().startsWith("re:") ? m.subject : `Re: ${m.subject ?? ""}`,
      body: buildReplyQuote(m, target),
      inReplyTo: m.messageId ?? undefined,
      references: nextReferences(m),
    });
  };

  const startForward = async (m: MailboxMessageDetail) => {
    setPreparingForward(m.id);
    try {
      const fwdAttachments = m.hasAttachments ? await fetchAttachmentsAsPending(m) : [];
      setDraftSeed({
        to: "",
        subject: m.subject?.toLowerCase().startsWith("fwd:") ? m.subject : `Fwd: ${m.subject ?? ""}`,
        body: buildForwardQuote(m),
        attachments: fwdAttachments,
        // No In-Reply-To/References — forwarding starts a fresh conversation
        // with a new recipient, same as Gmail/Outlook.
      });
    } finally {
      setPreparingForward(null);
    }
  };

  const inTrash = anchor?.folder === "trash";
  const inSnoozed = anchor?.folder === "snoozed";
  const inSpam = anchor?.folder === "spam";
  const inScheduled = anchor?.folder === "scheduled";

  return (
    <div className="space-y-4 page-enter">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="font-mono text-xs gap-1.5 -ml-2">
          <ChevronLeft className="w-3.5 h-3.5" /> Back
        </Button>
        {anchor && inScheduled ? (
          <div className="flex items-center gap-2">
            {anchor.scheduledSendAt && (
              <span className="font-mono text-[10px] text-primary/80 flex items-center gap-1">
                <CalendarClock className="w-3 h-3" /> Sends {formatFull(anchor.scheduledSendAt)}
              </span>
            )}
            <ScheduleSendMenu
              onSchedule={reschedule}
              trigger={
                <Button variant="outline" size="sm" className="font-mono text-[10px] gap-1.5">
                  <CalendarClock className="w-3 h-3" /> Reschedule
                </Button>
              }
            />
            <Button variant="outline" size="sm" onClick={cancelSchedule} className="font-mono text-[10px] gap-1.5">
              <XCircle className="w-3 h-3" /> Cancel send
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title={allTrashed ? `Delete ${scopeLabel} forever` : `Move ${scopeLabel} to Trash`} onClick={trashOrDeleteForever}>
              <Trash2 className="w-4 h-4 text-red-400/70" />
            </Button>
          </div>
        ) : anchor && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" title={anyStarred ? `Unstar ${scopeLabel}` : `Star ${scopeLabel}`} onClick={toggleStar}>
              <Star className={cn("w-4 h-4", anyStarred ? "text-yellow-400 fill-yellow-400" : "text-muted-foreground/40")} />
            </Button>
            <Button
              variant="ghost" size="icon" className="h-8 w-8"
              title={anyUnread ? `Mark ${scopeLabel} as read` : `Mark ${scopeLabel} as unread`}
              onClick={() => markThreadRead(anyUnread)}
            >
              {anyUnread ? <MailOpen className="w-4 h-4 text-muted-foreground/60" /> : <Circle className="w-4 h-4 fill-primary/40 text-primary" />}
            </Button>
            {inSnoozed ? (
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Unsnooze" onClick={unsnooze}>
                <BellOff className="w-4 h-4 text-muted-foreground/60" />
              </Button>
            ) : anchor.folder === "inbox" ? (
              <SnoozeMenu
                onSnooze={snooze}
                trigger={
                  <Button variant="ghost" size="icon" className="h-8 w-8" title="Snooze">
                    <Clock className="w-4 h-4 text-muted-foreground/60" />
                  </Button>
                }
              />
            ) : null}
            {inSpam ? (
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Not spam" onClick={() => moveAnchor("inbox", null)}>
                <ShieldOff className="w-4 h-4 text-emerald-400/80" />
              </Button>
            ) : !inTrash && anchor.direction === "inbound" && (
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Report spam" onClick={() => moveAnchor("spam", null)}>
                <ShieldAlert className="w-4 h-4 text-muted-foreground/60" />
              </Button>
            )}
            {inTrash ? (
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Restore" onClick={() => moveAnchor(anchor.direction === "outbound" ? "sent" : "inbox", null)}>
                <ArchiveRestore className="w-4 h-4 text-emerald-400/80" />
              </Button>
            ) : (
              <Button variant="ghost" size="icon" className="h-8 w-8" title={`Archive ${scopeLabel}`} onClick={() => move("archive", null)}>
                <Archive className="w-4 h-4 text-muted-foreground/60" />
              </Button>
            )}
            <LabelPickerMenu
              labels={labels}
              selectedIds={anchor.labels.map((l) => l.id)}
              onToggle={(labelId) => toggleLabel(anchor.id, labelId)}
              trigger={
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Labels">
                  <Tags className="w-4 h-4 text-muted-foreground/60" />
                </Button>
              }
            />
            <MoveToMenu
              current={activeFolder}
              systemFolders={systemFolders}
              customFolders={customFolders}
              onMove={move}
              trigger={
                <Button variant="ghost" size="icon" className="h-8 w-8" title={`Move ${scopeLabel} to folder`}>
                  <FolderInput className="w-4 h-4 text-muted-foreground/60" />
                </Button>
              }
            />
            <Button variant="ghost" size="icon" className="h-8 w-8" title={allTrashed ? `Delete ${scopeLabel} forever` : `Move ${scopeLabel} to Trash`} onClick={trashOrDeleteForever}>
              <Trash2 className="w-4 h-4 text-red-400/70" />
            </Button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : !messages?.length ? (
        <div className="text-center py-16">
          <Mail className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="font-mono text-xs text-muted-foreground/50">Message not found</p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1 flex-wrap">
            <h2 className="font-mono text-sm font-bold">{messages[0].subject || "(no subject)"}</h2>
            {anchor?.labels.map((l) => <LabelChip key={l.id} label={l} size="sm" />)}
          </div>
          {messages.length > 1 && (
            <div className="flex items-center justify-between gap-2 px-1 flex-wrap">
              <p className="font-mono text-[10px] text-muted-foreground/40">{messages.length} messages in this conversation</p>
              {/* Whole Conversation Actions Phase 2: lets Star/Mark
                  read-unread/Archive/Move/Delete above be scoped down to
                  just the opened message instead of the default
                  whole-thread behavior. Only shown for multi-message
                  threads — a single-message conversation has no
                  distinction to offer. */}
              <button
                onClick={() => setWholeConversation((v) => !v)}
                title={wholeConversation ? "Actions apply to the whole conversation — click to scope to this message only" : "Actions apply to this message only — click to apply to the whole conversation"}
                className="font-mono text-[10px] text-muted-foreground/50 hover:text-primary transition-colors flex items-center gap-1"
              >
                {wholeConversation ? <Layers className="w-3 h-3" /> : <Mail className="w-3 h-3" />}
                {wholeConversation ? "Whole conversation" : "This message only"}
              </button>
            </div>
          )}
          {messages.map((m) => {
            const expanded = expandedId === m.id;
            return (
              <div key={m.id} className="bg-card border border-card-border rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedId(expanded ? null : m.id)}
                  className="w-full flex items-start gap-2 px-4 py-3 text-left hover:bg-muted/5 transition-colors"
                >
                  {expanded ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/40 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/40 flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-xs font-bold truncate">{m.direction === "outbound" ? `To: ${m.to}` : m.from}</span>
                      {m.isStarred && <Star className="w-3 h-3 text-yellow-400 fill-yellow-400 flex-shrink-0" />}
                      {m.direction === "outbound" && m.deliveryStatus && (() => {
                        const meta = DELIVERY_STATUS_META[m.deliveryStatus];
                        const Icon = meta.icon;
                        return (
                          <span title={m.bounceReason ?? undefined} className={cn("inline-flex items-center gap-1 font-mono text-[9px] flex-shrink-0", meta.className)}>
                            <Icon className={cn("w-2.5 h-2.5", meta.spin && "animate-spin")} /> {meta.label}
                          </span>
                        );
                      })()}
                      {/* Bounce + Complaint Handling (Phase 1) — shown
                          alongside (not instead of) the delivery-status
                          badge above, since a complained message was still
                          delivered. */}
                      {m.direction === "outbound" && m.complainedAt && (
                        <span title="Recipient marked this as spam" className="inline-flex items-center gap-1 font-mono text-[9px] flex-shrink-0 text-amber-400/80">
                          <Flag className="w-2.5 h-2.5" /> Spam report
                        </span>
                      )}
                      <span className="font-mono text-[9px] text-muted-foreground/30 flex-shrink-0 ml-auto">{formatDate(m.receivedAt ?? m.createdAt)}</span>
                    </div>
                    {!expanded && (
                      <p className="font-mono text-[10px] text-muted-foreground/40 truncate mt-0.5">{snippet(m)}</p>
                    )}
                  </div>
                </button>

                {expanded && (
                  <div className="px-4 pb-4 space-y-3">
                    {/* Robust Send Queue Phase 2: this message sits in Drafts
                        because the send-queue worker gave up on it after
                        repeated failures (see lib/mail-send-queue.ts) — same
                        role the scheduled-send abandon message plays, so the
                        user knows *why* it silently reappeared here instead
                        of assuming a normal saved draft. */}
                    {m.folder === "drafts" && m.sendFailure && (
                      <div className="flex items-start gap-2 text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-mono text-[10px] font-bold">Couldn't send this message</p>
                          <p className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">{m.sendFailure}</p>
                        </div>
                      </div>
                    )}

                    {/* Delivery Tracking: Resend's own email.bounced event —
                        distinct from the send-queue give-up box above, since
                        this means Resend *did* accept the send but the
                        recipient's mail server rejected it afterward. */}
                    {m.deliveryStatus === "bounced" && (
                      <div className="flex items-start gap-2 text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
                        <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-mono text-[10px] font-bold">Message bounced</p>
                          {m.bounceReason && <p className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">{m.bounceReason}</p>}
                        </div>
                      </div>
                    )}

                    {/* Bounce + Complaint Handling (Phase 1): Resend's own
                        email.complained event — the recipient reported this
                        message as spam from their own mail client. Distinct
                        from the bounce box above (this message *was*
                        delivered), and always shown regardless of
                        deliveryStatus. */}
                    {m.complainedAt && (
                      <div className="flex items-start gap-2 text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
                        <Flag className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-mono text-[10px] font-bold">Marked as spam by recipient</p>
                          <p className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">
                            {m.to} reported this message as spam. This address has been blocked from future sends.
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="font-mono text-[11px] text-muted-foreground/60 space-y-0.5">
                      <div>From <ContactPopover address={m.from} onReply={() => startReply(m, false)} /></div>
                      <div>To <ContactPopover address={m.to} /></div>
                      {m.cc && <div>Cc <ContactPopover address={m.cc} /></div>}
                      {m.bcc && <div>Bcc <ContactPopover address={m.bcc} /></div>}
                      {m.forwardedTo && <div className="text-[10px] text-muted-foreground/40">↳ relayed to {m.forwardedTo}</div>}
                    </div>

                    <div className="border-t border-border/40 pt-3">
                      {m.html ? (
                        <div className="text-xs leading-relaxed [&_a]:text-primary" dangerouslySetInnerHTML={{ __html: m.html }} />
                      ) : (
                        <pre className="font-mono text-xs whitespace-pre-wrap break-words text-foreground/90 leading-relaxed">
                          {m.text || "(empty message)"}
                        </pre>
                      )}
                    </div>

                    {m.attachments.length > 0 && (
                      <div className="border-t border-border/40 pt-3 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/50">
                            Attachments ({m.attachments.length})
                          </p>
                          {m.attachments.length > 1 && (
                            <button
                              onClick={() => downloadAllAttachments(m.id)}
                              disabled={downloadingKey === `${m.id}:all`}
                              className="font-mono text-[9px] uppercase tracking-wide text-primary/80 hover:text-primary flex items-center gap-1"
                            >
                              {downloadingKey === `${m.id}:all`
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : <PackageOpen className="w-3 h-3" />}
                              Download all
                            </button>
                          )}
                        </div>

                        {/* Inline images — auto-loaded thumbnails for any
                            image/* attachment (see the useEffect above),
                            tap to open full-size in the lightbox. */}
                        {m.attachments.some((att) => isImageType(att.contentType)) && (
                          <div className="flex flex-wrap gap-2">
                            {m.attachments.filter((att) => isImageType(att.contentType)).map((att) => {
                              const key = `${m.id}:${att.id}`;
                              const src = inlinePreviews.get(key);
                              return (
                                <button
                                  key={att.id}
                                  onClick={() => openPreview(m.id, att)}
                                  className="w-20 h-20 rounded border border-border/30 overflow-hidden bg-muted/10 flex items-center justify-center flex-shrink-0"
                                  title={att.filename}
                                >
                                  {src
                                    ? <img src={src} alt={att.filename} className="w-full h-full object-cover" />
                                    : <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40" />}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {m.attachments.map((att) => {
                          const key = `${m.id}:${att.id}`;
                          const Icon = attachmentIcon(att.contentType);
                          const canPreview = isPreviewable(att.contentType);
                          return (
                            <div
                              key={att.id}
                              className="w-full flex items-center gap-2.5 bg-muted/10 border border-border/20 rounded px-3 py-2"
                            >
                              <Icon className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
                              <span className="font-mono text-[11px] flex-1 truncate">{att.filename}</span>
                              <span className="font-mono text-[9px] text-muted-foreground/40 flex-shrink-0">{formatBytes(att.sizeBytes)}</span>
                              {canPreview && (
                                <button
                                  onClick={() => openPreview(m.id, att)}
                                  disabled={previewLoadingKey === key}
                                  title="Preview"
                                  className="text-muted-foreground/40 hover:text-primary flex-shrink-0"
                                >
                                  {previewLoadingKey === key
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <Eye className="w-3.5 h-3.5" />}
                                </button>
                              )}
                              <button
                                onClick={() => downloadAttachment(m.id, att)}
                                disabled={downloadingKey === key}
                                title="Download"
                                className="text-muted-foreground/40 hover:text-primary flex-shrink-0"
                              >
                                {downloadingKey === key
                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : <Download className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="border-t border-border/40 pt-3 flex items-center gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => startReply(m, false)} className="font-mono text-[10px] gap-1.5">
                        <Reply className="w-3 h-3" /> Reply
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => startReply(m, true)} className="font-mono text-[10px] gap-1.5">
                        <ReplyAll className="w-3 h-3" /> Reply All
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => startForward(m)} disabled={preparingForward === m.id} className="font-mono text-[10px] gap-1.5">
                        {preparingForward === m.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Forward className="w-3 h-3" />}
                        Forward
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {draftSeed && (
        <ComposeDialog
          open={!!draftSeed}
          onOpenChange={(v) => { if (!v) setDraftSeed(null); }}
          fromAddress={fromAddress}
          defaultTo={draftSeed.to}
          defaultCc={draftSeed.cc}
          defaultSubject={draftSeed.subject}
          defaultBody={draftSeed.body}
          defaultInReplyTo={draftSeed.inReplyTo}
          defaultReferences={draftSeed.references}
          defaultAttachments={draftSeed.attachments}
          signature={signature}
          signatureEnabled={signatureEnabled}
          templates={templates}
          onTemplatesChanged={onTemplatesChanged}
          onSent={(opts) => { setDraftSeed(null); onChanged(); if (!opts?.silent) toast({ title: "Check the Sent tab" }); }}
          onDraftSaved={() => {}}
        />
      )}

      <AlertDialog open={confirmForever} onOpenChange={setConfirmForever}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm">{wholeConversation ? "Delete conversation forever?" : "Delete message forever?"}</AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs">
              {wholeConversation
                ? "Every message in this conversation will be permanently deleted and can't be recovered."
                : "This message will be permanently deleted and can't be recovered."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteForever} className="font-mono text-xs bg-red-500/90 hover:bg-red-500">Delete forever</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Image / PDF lightbox — shared by the inline-image thumbnails and
          every attachment chip's Preview button. */}
      <Dialog open={!!lightbox} onOpenChange={(v) => { if (!v) setLightbox(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-xs truncate pr-6">{lightbox?.filename}</DialogTitle>
          </DialogHeader>
          {lightbox && (
            isImageType(lightbox.contentType) ? (
              <img src={lightbox.dataUrl} alt={lightbox.filename} className="max-h-[75vh] w-full object-contain rounded" />
            ) : (
              <iframe src={lightbox.dataUrl} title={lightbox.filename} className="w-full h-[75vh] rounded border border-border/30 bg-white" />
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Folder rail ────────────────────────────────────────────────────────────
// Undo Send (Phase 2): persistent "Undo (Ns)" chip for an Outbox row, as
// opposed to Phase 1's toast-only affordance (ComposeDialog's
// showUndoSendToast above) which disappears the moment it's dismissed or
// the tab reloads. Reads undoExpiresAt straight off the message the Outbox
// list already fetched — no separate endpoint — and ticks its own local
// countdown off it rather than trusting a windowMs prop, so it stays
// correct even if this chip mounts partway through the window (e.g. the
// list was already open when another tab/device sent the message).
function OutboxUndoChip({ messageId, undoExpiresAt, token, onUndone }: {
  messageId: number;
  undoExpiresAt: string;
  token: string;
  onUndone: () => void;
}) {
  const { toast } = useToast();
  const [secondsLeft, setSecondsLeft] = useState(() => Math.max(0, Math.ceil((new Date(undoExpiresAt).getTime() - Date.now()) / 1000)));
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    const tick = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((new Date(undoExpiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(tick);
  }, [undoExpiresAt]);

  if (secondsLeft <= 0) return null;

  const handleUndo = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (undoing) return;
    setUndoing(true);
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/${messageId}/undo-send`, { method: "PATCH" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast({ title: "Send cancelled", description: "Moved back to Drafts" });
        onUndone();
      } else {
        toast({ variant: "destructive", title: "Couldn't undo", description: data?.error ?? "Already sent" });
      }
    } catch {
      toast({ variant: "destructive", title: "Couldn't undo", description: "Network error" });
    }
    setUndoing(false);
  };

  return (
    <button
      onClick={handleUndo}
      disabled={undoing}
      className="inline-flex items-center gap-1 font-mono text-[9px] text-primary flex-shrink-0 px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 hover:bg-primary/20 transition-colors disabled:opacity-50"
    >
      {undoing ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RotateCcw className="w-2.5 h-2.5" />}
      Undo ({secondsLeft}s)
    </button>
  );
}

function FolderChip({
  active, icon: Icon, label, unread, onClick, menu,
}: {
  active: boolean;
  icon: typeof Inbox;
  label: string;
  unread?: number;
  onClick: () => void;
  menu?: React.ReactNode;
}) {
  return (
    <div className={cn(
      "flex items-center gap-1 rounded-md transition-colors flex-shrink-0",
      active ? "bg-primary/15 text-primary" : "text-muted-foreground/50 hover:text-muted-foreground/80",
    )}>
      <button onClick={onClick} className="font-mono text-[10px] uppercase tracking-wide pl-3 pr-1.5 py-1.5 flex items-center gap-1.5">
        <Icon className="w-3 h-3" /> {label}
        {!!unread && <Badge className="text-[8px] px-1 py-0 bg-red-500/15 border-red-500/30 text-red-400 ml-0.5">{unread}</Badge>}
      </button>
      {menu}
    </div>
  );
}

// ─── Quick-filter chip (Unread / Starred / Has attachment) ─────────────────
function FilterChip({
  active, icon: Icon, label, onClick,
}: {
  active: boolean;
  icon: typeof Inbox;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide rounded-full border px-2.5 py-1 transition-colors",
        active ? "border-primary/50 bg-primary/10 text-primary" : "border-border/20 text-muted-foreground/50 hover:text-foreground/80 hover:border-border/40",
      )}
    >
      <Icon className={cn("w-2.5 h-2.5", active && label === "Starred" && "fill-primary")} /> {label}
    </button>
  );
}

// ─── Main mailbox page ──────────────────────────────────────────────────────
export default function Mailbox() {
  const params = useParams<{ id?: string }>();
  const [, navigate] = useLocation();
  const { token } = useAuth();
  const { toast } = useToast();

  const [ayzenEmail, setAyzenEmail] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveFolder>({ folder: "inbox", folderId: null });
  const [systemFolders, setSystemFolders] = useState<FolderCounts[]>(
    SYSTEM_FOLDERS.map((key) => ({ key, label: FOLDER_LABELS[key], count: 0, unread: 0 })),
  );
  const [customFolders, setCustomFolders] = useState<CustomFolder[]>([]);
  const [messages, setMessages] = useState<MailboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [editingDraft, setEditingDraft] = useState<MailboxMessageDetail | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameFolder, setRenameFolder] = useState<CustomFolder | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteFolder, setDeleteFolder] = useState<CustomFolder | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [mailboxSignature, setMailboxSignature] = useState("");
  const [mailboxSignatureEnabled, setMailboxSignatureEnabled] = useState(true);
  const [signatureDialogOpen, setSignatureDialogOpen] = useState(false);
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [templatesManagerOpen, setTemplatesManagerOpen] = useState(false);

  // ─── Labels, filters, search, rules ─────────────────────────────────────
  const [labels, setLabels] = useState<LabelWithCount[]>([]);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [editingLabel, setEditingLabel] = useState<LabelWithCount | null>(null);
  const [deleteLabelTarget, setDeleteLabelTarget] = useState<LabelWithCount | null>(null);
  const [filters, setFilters] = useState<QuickFilters>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState(""); // debounced value actually sent
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rules, setRules] = useState<MailRule[]>([]);
  const [rulesDialogOpen, setRulesDialogOpen] = useState(false);
  const [attachmentSearchOpen, setAttachmentSearchOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);

  // ─── Bulk selection ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkLabelMenuOpen, setBulkLabelMenuOpen] = useState(false);
  const [bulkMoveMenuOpen, setBulkMoveMenuOpen] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  // ─── Unread notifications ────────────────────────────────────────────────
  // "notifyEnabled" is the user's own opt-in (persisted across sessions —
  // this is real deployed app code, not a claude.ai artifact, so
  // localStorage is fine here) and is separate from the browser's actual
  // Notification permission, which the user grants separately when they
  // flip this on.
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [inboxUnread, setInboxUnread] = useState(0);
  const knownUnreadIds = useRef<Set<number>>(new Set());
  const notifyInitialized = useRef(false);

  useEffect(() => {
    try { setNotifyEnabled(localStorage.getItem("ayzen-mailbox-notify") === "1"); } catch { /* private browsing etc. */ }
  }, []);

  const toggleNotifications = async () => {
    if (notifyEnabled) {
      setNotifyEnabled(false);
      try { localStorage.setItem("ayzen-mailbox-notify", "0"); } catch { /* ignore */ }
      return;
    }
    if (typeof Notification === "undefined") {
      toast({ variant: "destructive", title: "Notifications aren't supported in this browser" });
      return;
    }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") {
      toast({ variant: "destructive", title: "Notifications blocked", description: "Enable them in your browser's site settings to turn this on." });
      return;
    }
    setNotifyEnabled(true);
    try { localStorage.setItem("ayzen-mailbox-notify", "1"); } catch { /* ignore */ }
  };

  const fetchStatus = useCallback(() => {
    authedFetch(token, `/ayzen-email/status`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        setAyzenEmail(data?.ayzenEmail ?? null); setMode(data?.mode ?? null);
        setMailboxSignature(data?.mailboxSignature ?? "");
        setMailboxSignatureEnabled(data?.mailboxSignatureEnabled ?? true);
      })
      .catch(() => {});
  }, [token]);

  const fetchFolders = useCallback(() => {
    authedFetch(token, `/ayzen-email/mailbox/folders`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        setSystemFolders(data.system ?? []);
        setCustomFolders(data.custom ?? []);
      })
      .catch(() => {});
  }, [token]);

  const fetchLabels = useCallback(() => {
    authedFetch(token, `/ayzen-email/mailbox/labels`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setLabels(data.labels ?? []); })
      .catch(() => {});
  }, [token]);

  const fetchRules = useCallback(() => {
    authedFetch(token, `/ayzen-email/mailbox/rules`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setRules(data.rules ?? []); })
      .catch(() => {});
  }, [token]);

  const fetchTemplates = useCallback(() => {
    authedFetch(token, `/ayzen-email/mailbox/templates`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setTemplates(data.templates ?? []); })
      .catch(() => {});
  }, [token]);

  // Debounce the search box the same way compose autosave does (300ms is
  // enough to not fire on every keystroke without feeling laggy) —
  // `searchQuery` (not `searchInput`) is what actually drives the fetch.
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [searchInput]);

  const fetchMessages = useCallback(() => {
    setLoading(true);
    const fq = filterQueryString(filters);
    const folderQs = active.folder === "custom" ? `folder=custom&folderId=${active.folderId}` : `folder=${active.folder}`;
    const path = searchQuery
      // Search still respects the selected folder (so "search within
      // Archive" works) — backend defaults to "everywhere except Trash"
      // only when no folder param is sent at all.
      ? `/ayzen-email/mailbox/search?q=${encodeURIComponent(searchQuery)}&${folderQs}${fq ? `&${fq}` : ""}`
      : `/ayzen-email/mailbox?${folderQs}${fq ? `&${fq}` : ""}`;
    authedFetch(token, path)
      .then((r) => r.ok ? r.json() : { messages: [] })
      .then((data) => setMessages(data.messages ?? []))
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, [active, token, filters, searchQuery]);

  const refreshAll = useCallback(() => { fetchMessages(); fetchFolders(); fetchLabels(); }, [fetchMessages, fetchFolders, fetchLabels]);

  useEffect(() => { fetchStatus(); fetchFolders(); fetchLabels(); fetchRules(); fetchTemplates(); }, [fetchStatus, fetchFolders, fetchLabels, fetchRules, fetchTemplates]);
  useEffect(() => { if (!params.id) fetchMessages(); }, [fetchMessages, params.id]);

  // Poll Inbox's unread state every 25s so the tab title badge and the
  // desktop-notification trigger both work even if the user never touches
  // Refresh. 25s is a compromise: fast enough for "new mail" to feel live,
  // slow enough not to hammer the API from every open tab.
  useEffect(() => {
    if (!ayzenEmail || mode !== "native") return;
    let cancelled = false;
    const poll = () => {
      authedFetch(token, `/ayzen-email/mailbox/unread-summary`)
        .then((r) => r.ok ? r.json() : null)
        .then((data: { unreadCount: number; latest: { id: number; from: string; subject: string | null; threadId: number } | null } | null) => {
          if (!data || cancelled) return;
          setInboxUnread(data.unreadCount);

          // Skip firing on the very first poll after mount/login — that's
          // "catching up on existing unread", not "new mail just arrived".
          if (!notifyInitialized.current) {
            notifyInitialized.current = true;
            if (data.latest) knownUnreadIds.current.add(data.latest.id);
            return;
          }
          if (data.latest && !knownUnreadIds.current.has(data.latest.id)) {
            knownUnreadIds.current.add(data.latest.id);
            const title = data.latest.subject || "(no subject)";
            const body = `From ${data.latest.from}`;
            if (notifyEnabled) {
              if (typeof Notification !== "undefined" && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
                const n = new Notification(title, { body, tag: `ayzen-mail-${data.latest.id}` });
                n.onclick = () => { window.focus(); navigate(`/mailbox/${data.latest!.id}`); };
              } else {
                toast({ title: `New mail: ${title}`, description: body });
              }
            }
          }
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 25_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token, ayzenEmail, mode, notifyEnabled, navigate, toast]);

  // Tab-title badge — cheap and works regardless of whether notifications
  // are turned on, so it's not gated behind notifyEnabled.
  useEffect(() => {
    const base = "Mailbox — AYZEN";
    document.title = inboxUnread > 0 ? `(${inboxUnread > 99 ? "99+" : inboxUnread}) ${base}` : base;
    return () => { document.title = base; };
  }, [inboxUnread]);

  // Selection shouldn't survive switching folders/search/filters — a stale
  // selection silently applying a bulk action to messages you can no longer
  // see would be surprising.
  useEffect(() => { setSelectedIds(new Set()); }, [active, filters, searchQuery]);

  const openMessage = (m: MailboxMessage) => {
    if (m.isDraft) {
      setLoading(true);
      authedFetch(token, `/ayzen-email/mailbox/${m.id}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => { if (data) setEditingDraft(data); })
        .finally(() => setLoading(false));
      return;
    }
    navigate(`/mailbox/${m.id}`);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const res = await authedFetch(token, `/ayzen-email/mailbox/folders`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { toast({ variant: "destructive", title: "Could not create folder", description: data.error }); return; }
    setNewFolderOpen(false); setNewFolderName("");
    fetchFolders();
    setActive({ folder: "custom", folderId: data.id, name: data.name });
  };

  const submitRename = async () => {
    if (!renameFolder) return;
    const name = renameValue.trim();
    if (!name) return;
    const res = await authedFetch(token, `/ayzen-email/mailbox/folders/${renameFolder.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { toast({ variant: "destructive", title: "Could not rename", description: data.error }); return; }
    setRenameFolder(null);
    fetchFolders();
    if (active.folder === "custom" && active.folderId === renameFolder.id) setActive({ ...active, name });
  };

  const confirmDeleteFolder = async () => {
    if (!deleteFolder) return;
    await authedFetch(token, `/ayzen-email/mailbox/folders/${deleteFolder.id}`, { method: "DELETE" });
    toast({ title: `Folder "${deleteFolder.name}" deleted`, description: "Its messages moved to Archive." });
    if (active.folder === "custom" && active.folderId === deleteFolder.id) setActive({ folder: "archive", folderId: null });
    setDeleteFolder(null);
    fetchFolders();
  };

  const confirmEmptyTrash = async () => {
    setEmptyTrashOpen(false);
    const res = await authedFetch(token, `/ayzen-email/mailbox/trash/empty`, { method: "DELETE" });
    const data = await res.json();
    toast({ title: `Trash emptied`, description: `${data.deletedCount ?? 0} message(s) permanently deleted` });
    refreshAll();
  };

  // Toggle a single label on a message from the list row's label menu —
  // fetches the message's current labels first (list rows already carry
  // them, so this is really just building the next desired set) and PATCHes
  // the full set, matching the backend's "replace whole set" contract.
  const toggleLabelOnMessage = async (m: MailboxMessage, labelId: number) => {
    const current = m.labels.map((l) => l.id);
    const next = current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId];
    await authedFetch(token, `/ayzen-email/mailbox/${m.id}/labels`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labelIds: next }),
    });
    refreshAll();
  };

  // Quick-reaction toggles for the list rows — optimistic update on the row
  // itself (no full refetch needed for the toggle to feel instant), with a
  // background refreshAll() to keep the folder rail's unread badges in
  // sync. Whole Conversation Actions Phase 2: these now hit the
  // thread-scoped quick-action route (every message in the conversation,
  // not just the representative row the list happens to be showing) —
  // same "star/read apply to the whole thread" behavior ThreadDetail's own
  // toolbar got in Phase 1, just reachable straight from the list without
  // opening the conversation first. The row itself is still the only
  // thing optimistically updated here, since it's the only row the list
  // renders per conversation.
  const toggleStarOnMessage = async (m: MailboxMessage) => {
    const nextStarred = !m.isStarred;
    setMessages((prev) => prev.map((row) => row.id === m.id ? { ...row, isStarred: nextStarred } : row));
    const res = await authedFetch(token, `/ayzen-email/mailbox/thread/${encodeURIComponent(m.threadId)}/quick-action`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: nextStarred ? "star" : "unstar" }),
    });
    if (!res.ok) setMessages((prev) => prev.map((row) => row.id === m.id ? { ...row, isStarred: m.isStarred } : row));
    else fetchFolders();
  };

  const toggleReadOnMessage = async (m: MailboxMessage) => {
    const targetRead = !m.isRead;
    setMessages((prev) => prev.map((row) => row.id === m.id ? { ...row, isRead: targetRead, threadUnread: !targetRead } : row));
    const res = await authedFetch(token, `/ayzen-email/mailbox/thread/${encodeURIComponent(m.threadId)}/quick-action`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: targetRead ? "markRead" : "markUnread" }),
    });
    if (!res.ok) setMessages((prev) => prev.map((row) => row.id === m.id ? { ...row, isRead: m.isRead, threadUnread: !m.isRead } : row));
    else fetchFolders();
  };

  // Whole Conversation Actions Phase 3 (optimistic UI): drops a
  // conversation's row out of the currently displayed list immediately —
  // called by ThreadDetail the instant a whole-conversation Archive/Move/
  // Delete is triggered, before that request has actually resolved. The
  // list is still refetched in the background via onChanged() regardless
  // (both on success, to pick up any other server-side side effects, and
  // on failure, to put the row back if the optimism turned out to be
  // wrong) — this only removes the visible round-trip delay for the
  // common case where the action succeeds.
  const optimisticallyRemoveThread = (threadId: string) => {
    setMessages((prev) => prev.filter((row) => row.threadId !== threadId));
  };

  const snoozeMessage = async (m: MailboxMessage, until: Date) => {
    const res = await authedFetch(token, `/ayzen-email/mailbox/${m.id}/snooze`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ until: until.toISOString() }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) { toast({ title: `Snoozed until ${formatFull(until.toISOString())}` }); refreshAll(); }
    else toast({ variant: "destructive", title: "Could not snooze", description: data?.error ?? "Network error" });
  };

  const unsnoozeMessage = async (m: MailboxMessage) => {
    const res = await authedFetch(token, `/ayzen-email/mailbox/${m.id}/unsnooze`, { method: "PATCH" });
    if (res.ok) { toast({ title: "Moved back to Inbox" }); refreshAll(); }
  };

  const cancelScheduleMessage = async (m: MailboxMessage) => {
    const res = await authedFetch(token, `/ayzen-email/mailbox/${m.id}/cancel-schedule`, { method: "PATCH" });
    if (res.ok) { toast({ title: "Send cancelled", description: "Moved back to Drafts" }); refreshAll(); }
  };

  const toggleFilter = (key: keyof QuickFilters) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] } as QuickFilters));
  };

  const toggleLabelFilter = (labelId: number) => {
    setFilters((prev) => ({ ...prev, labelId: prev.labelId === labelId ? null : labelId }));
  };

  // ─── Bulk selection & actions ────────────────────────────────────────────
  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const allSelected = messages.length > 0 && messages.every((m) => selectedIds.has(m.id));
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(messages.map((m) => m.id)));
  };

  const runBulkAction = async (body: Record<string, unknown>) => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    const res = await authedFetch(token, `/ayzen-email/mailbox/bulk`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, ...body }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      toast({ variant: "destructive", title: "Bulk action failed", description: data?.error ?? "Network error" });
      return;
    }
    toast({ title: `${data.affected ?? ids.length} message(s) updated` });
    setSelectedIds(new Set());
    refreshAll();
  };

  if (params.id) {
    return (
      <div className="max-w-2xl">
        <ThreadDetail
          id={parseInt(params.id, 10)}
          onBack={() => navigate("/mailbox")}
          onChanged={refreshAll}
          onOptimisticRemoveThread={optimisticallyRemoveThread}
          fromAddress={ayzenEmail ?? ""}
          activeFolder={active}
          systemFolders={systemFolders}
          customFolders={customFolders}
          signature={mailboxSignature}
          signatureEnabled={mailboxSignatureEnabled}
          templates={templates}
          onTemplatesChanged={fetchTemplates}
          labels={labels}
          onToggleLabel={() => fetchLabels()}
        />
      </div>
    );
  }

  const activeLabel = active.folder === "custom" ? (active.name ?? "Folder") : FOLDER_LABELS[active.folder as SystemFolderKey];
  const activeIsCustom = active.folder === "custom";

  return (
    <div className="space-y-4 page-enter max-w-2xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold font-mono tracking-tighter flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Mail className="w-4 h-4 text-primary" />
            </div>
            Mailbox
            {inboxUnread > 0 && (
              <Badge className="text-[9px] px-1.5 py-0 bg-red-500/15 border-red-500/30 text-red-400">
                {inboxUnread > 99 ? "99+" : inboxUnread} unread
              </Badge>
            )}
          </h1>
          <p className="font-mono text-[10px] text-muted-foreground/50 mt-1 pl-0.5">
            {ayzenEmail ?? "…"}{mode === "native" && <span className="text-emerald-400/80 ml-1.5">· native</span>}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={refreshAll} disabled={loading} className="font-mono text-xs gap-1.5">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </Button>
          <Button
            size="sm" variant="outline" onClick={toggleNotifications} disabled={!ayzenEmail || mode !== "native"}
            title={notifyEnabled ? "Notifications on — click to turn off" : "Turn on new-mail notifications"}
            className={cn("font-mono text-xs gap-1.5", notifyEnabled && "border-primary/40 text-primary")}
          >
            {notifyEnabled ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRulesDialogOpen(true)} disabled={!ayzenEmail || mode !== "native"} className="font-mono text-xs gap-1.5">
            <Zap className="w-3.5 h-3.5" /> Rules
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAttachmentSearchOpen(true)} disabled={!ayzenEmail || mode !== "native"} className="font-mono text-xs gap-1.5">
            <Paperclip className="w-3.5 h-3.5" /> Attachments
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAnalyticsOpen(true)} disabled={!ayzenEmail || mode !== "native"} className="font-mono text-xs gap-1.5">
            <BarChart3 className="w-3.5 h-3.5" /> Analytics
          </Button>
          <Button size="sm" variant="outline" onClick={() => setSignatureDialogOpen(true)} disabled={!ayzenEmail || mode !== "native"} className="font-mono text-xs gap-1.5">
            <PenTool className="w-3.5 h-3.5" /> Signature
          </Button>
          <Button size="sm" variant="outline" onClick={() => setTemplatesManagerOpen(true)} disabled={!ayzenEmail || mode !== "native"} className="font-mono text-xs gap-1.5">
            <LayoutTemplate className="w-3.5 h-3.5" /> Templates
          </Button>
          <Button size="sm" onClick={() => setComposing(true)} disabled={!ayzenEmail || mode !== "native"} className="font-mono text-xs gap-1.5">
            <PenSquare className="w-3.5 h-3.5" /> Compose
          </Button>
        </div>
      </div>

      {mode !== "native" && (
        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg px-3.5 py-2.5">
          <p className="font-mono text-[10px] text-yellow-400/90">
            You're on forward mode — mail only forwards, nothing is stored here. Switch to native mode from the
            <button onClick={() => navigate("/ayzen-email")} className="text-primary underline mx-1">AYZEN Email</button>
            page to get a real inbox.
          </p>
        </div>
      )}

      {/* Search — hitting Enter or typing searches subject/from/to/cc/bcc
          across every folder (except Trash) unless a folder is selected via
          the rail below; the rail selection is ignored while search is on,
          same as Gmail switching into "All Mail" search results. */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-muted-foreground/40 absolute left-3 top-1/2 -translate-y-1/2" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search mail…"
          disabled={!ayzenEmail || mode !== "native"}
          className="font-mono text-xs pl-9 pr-8"
        />
        {searchInput && (
          <button onClick={() => setSearchInput("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground/80">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Quick filters — combine with the folder/search above. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <FilterChip active={filters.unread} icon={Circle} label="Unread" onClick={() => toggleFilter("unread")} />
        <FilterChip active={filters.starred} icon={Star} label="Starred" onClick={() => toggleFilter("starred")} />
        <FilterChip active={filters.hasAttachments} icon={Paperclip} label="Has attachment" onClick={() => toggleFilter("hasAttachments")} />
        {filtersActive(filters) && (
          <button onClick={() => setFilters(EMPTY_FILTERS)} className="font-mono text-[9px] text-muted-foreground/40 hover:text-primary underline">
            Clear filters
          </button>
        )}
      </div>

      {/* Labels rail — colored chips, click to filter the list to that
          label (same click-to-toggle pattern as the quick filters above).
          A message's own labels render inline on its row further down. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {labels.map((l) => (
          <button
            key={l.id}
            onClick={() => toggleLabelFilter(l.id)}
            className={cn(
              "group inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide rounded-full border px-2 py-1 transition-colors",
              filters.labelId === l.id ? "border-primary/50 bg-primary/10 text-primary" : "border-border/20 text-muted-foreground/50 hover:text-foreground/80 hover:border-border/40",
            )}
          >
            <LabelDot color={l.color} />
            {l.name}
            <span className="text-muted-foreground/30">{l.count}</span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); setEditingLabel(l); setLabelDialogOpen(true); }}
              className="opacity-0 group-hover:opacity-100 hover:text-primary ml-0.5"
            >
              <Pencil className="w-2.5 h-2.5" />
            </span>
          </button>
        ))}
        <button
          onClick={() => { setEditingLabel(null); setLabelDialogOpen(true); }}
          title="New label"
          className="flex-shrink-0 font-mono text-[9px] px-2 py-1 rounded-full border border-dashed border-border/30 text-muted-foreground/40 hover:text-primary hover:border-primary/40 transition-colors flex items-center gap-1"
        >
          <Tag className="w-2.5 h-2.5" /> New label
        </button>
      </div>

      <div className="flex items-center gap-1.5 bg-card border border-card-border rounded-lg p-1 overflow-x-auto">
        {systemFolders.map((f) => {
          const Icon = FOLDER_ICONS[f.key as SystemFolderKey];
          return (
            <FolderChip
              key={f.key}
              active={active.folder === f.key}
              icon={Icon}
              label={f.label}
              unread={f.unread}
              onClick={() => setActive({ folder: f.key as SystemFolderKey, folderId: null })}
            />
          );
        })}
        {customFolders.map((f) => (
          <FolderChip
            key={f.id}
            active={active.folder === "custom" && active.folderId === f.id}
            icon={Folder}
            label={f.name}
            unread={f.unread}
            onClick={() => setActive({ folder: "custom", folderId: f.id, name: f.name })}
            menu={
              active.folder === "custom" && active.folderId === f.id ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="pr-1.5 text-muted-foreground/50 hover:text-muted-foreground/80"><MoreHorizontal className="w-3 h-3" /></button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="font-mono text-xs">
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => { setRenameFolder(f); setRenameValue(f.name); }}>
                      <Pencil className="w-3.5 h-3.5" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2 text-xs text-red-400" onClick={() => setDeleteFolder(f)}>
                      <Trash2 className="w-3.5 h-3.5" /> Delete folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined
            }
          />
        ))}
        <button
          onClick={() => setNewFolderOpen(true)}
          title="New folder"
          className="flex-shrink-0 font-mono text-[10px] px-2.5 py-1.5 rounded-md text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-colors flex items-center gap-1"
        >
          <FolderPlus className="w-3 h-3" />
        </button>
      </div>

      {active.folder === "trash" && messages.length > 0 && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setEmptyTrashOpen(true)} className="font-mono text-[10px] gap-1.5 text-red-400/80 border-red-500/20">
            <Trash2 className="w-3 h-3" /> Empty Trash
          </Button>
        </div>
      )}

      {/* Bulk action bar — replaces the empty-trash row above while
          anything is selected; select-all lives on the list itself
          (see the header row inside the list container below). */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-1.5 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2 flex-wrap">
          <span className="font-mono text-[10px] text-primary mr-1">{selectedIds.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => runBulkAction({ action: "markRead" })} className="font-mono text-[10px] gap-1 h-7">
            <MailOpen className="w-3 h-3" /> Read
          </Button>
          <Button size="sm" variant="outline" onClick={() => runBulkAction({ action: "markUnread" })} className="font-mono text-[10px] gap-1 h-7">
            <Circle className="w-3 h-3" /> Unread
          </Button>
          <Button size="sm" variant="outline" onClick={() => runBulkAction({ action: "star" })} className="font-mono text-[10px] gap-1 h-7">
            <Star className="w-3 h-3" /> Star
          </Button>
          {active.folder === "snoozed" ? (
            <Button size="sm" variant="outline" onClick={() => runBulkAction({ action: "unsnooze" })} className="font-mono text-[10px] gap-1 h-7">
              <BellOff className="w-3 h-3" /> Unsnooze
            </Button>
          ) : active.folder === "inbox" && (
            <SnoozeMenu
              onSnooze={(until) => runBulkAction({ action: "snooze", until: until.toISOString() })}
              trigger={
                <Button size="sm" variant="outline" className="font-mono text-[10px] gap-1 h-7"><Clock className="w-3 h-3" /> Snooze</Button>
              }
            />
          )}
          {active.folder === "spam" ? (
            <Button size="sm" variant="outline" onClick={() => runBulkAction({ action: "move", folder: "inbox" })} className="font-mono text-[10px] gap-1 h-7">
              <ShieldOff className="w-3 h-3" /> Not spam
            </Button>
          ) : active.folder !== "trash" && (
            <Button size="sm" variant="outline" onClick={() => runBulkAction({ action: "move", folder: "spam" })} className="font-mono text-[10px] gap-1 h-7">
              <ShieldAlert className="w-3 h-3" /> Spam
            </Button>
          )}
          <DropdownMenu open={bulkLabelMenuOpen} onOpenChange={setBulkLabelMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="font-mono text-[10px] gap-1 h-7"><Tag className="w-3 h-3" /> Label</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="font-mono text-xs">
              <DropdownMenuLabel className="font-mono text-[9px] uppercase text-muted-foreground/50">Add label</DropdownMenuLabel>
              {labels.length === 0 ? (
                <div className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground/40">No labels yet</div>
              ) : (
                labels.map((l) => (
                  <DropdownMenuItem key={l.id} onClick={() => runBulkAction({ action: "addLabel", labelId: l.id })} className="gap-2 text-xs">
                    <LabelDot color={l.color} /> {l.name}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu open={bulkMoveMenuOpen} onOpenChange={setBulkMoveMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="font-mono text-[10px] gap-1 h-7"><FolderInput className="w-3 h-3" /> Move</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="font-mono text-xs">
              {systemFolders.filter((f) => !NON_MOVE_TARGET_FOLDERS.has(f.key as SystemFolderKey)).map((f) => (
                <DropdownMenuItem key={f.key} onClick={() => runBulkAction({ action: "move", folder: f.key })} className="gap-2 text-xs">
                  {f.label}
                </DropdownMenuItem>
              ))}
              {customFolders.length > 0 && <DropdownMenuSeparator />}
              {customFolders.map((f) => (
                <DropdownMenuItem key={f.id} onClick={() => runBulkAction({ action: "move", folder: "custom", folderId: f.id })} className="gap-2 text-xs">
                  {f.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="outline" onClick={() => setBulkDeleteConfirm(true)} className="font-mono text-[10px] gap-1 h-7 text-red-400/80 border-red-500/20">
            <Trash2 className="w-3 h-3" /> Delete
          </Button>
          <button onClick={() => setSelectedIds(new Set())} className="font-mono text-[9px] text-muted-foreground/40 hover:text-foreground/70 ml-auto">
            Clear
          </button>
        </div>
      )}

      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="px-4 py-14 flex items-center justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          </div>
        ) : messages.length === 0 ? (
          <div className="px-4 py-14 text-center">
            {active.folder === "inbox" ? <Inbox className="w-6 h-6 text-muted-foreground/20 mx-auto mb-2" />
              : activeIsCustom ? <Folder className="w-6 h-6 text-muted-foreground/20 mx-auto mb-2" />
              : (() => { const Icon = FOLDER_ICONS[active.folder as SystemFolderKey] ?? Inbox; return <Icon className="w-6 h-6 text-muted-foreground/20 mx-auto mb-2" />; })()}
            <p className="font-mono text-[10px] text-muted-foreground/40">Nothing in {activeLabel.toLowerCase()}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 px-4 py-2 border-b border-border/10">
              <button onClick={toggleSelectAll} className="flex-shrink-0 text-muted-foreground/40 hover:text-primary">
                {allSelected ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5" />}
              </button>
              <span className="font-mono text-[9px] text-muted-foreground/30 uppercase tracking-wide">
                {allSelected ? "All selected" : "Select all"}
              </span>
            </div>
            <div className="divide-y divide-border/10">
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn("w-full flex items-start gap-3 px-4 py-3 hover:bg-muted/10 transition-colors", (m.threadUnread ?? !m.isRead) && active.folder === "inbox" && "bg-primary/3")}
              >
                <button onClick={() => toggleSelect(m.id)} className="flex-shrink-0 mt-1 text-muted-foreground/30 hover:text-primary">
                  {selectedIds.has(m.id) ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => openMessage(m)} className="flex-shrink-0 mt-1">
                  {m.isDraft ? <FileEdit className="w-3.5 h-3.5 text-yellow-500/50" />
                    : active.folder === "sent" || m.direction === "outbound" ? <Send className="w-3.5 h-3.5 text-muted-foreground/30" />
                    : !(m.threadUnread ?? !m.isRead) ? <MailOpen className="w-3.5 h-3.5 text-muted-foreground/30" />
                    : <Circle className="w-3.5 h-3.5 text-primary fill-primary/40" />}
                </button>
                <button onClick={() => openMessage(m)} className="flex-1 min-w-0 text-left">
                  <div className="flex items-baseline gap-2">
                    <span className={cn("font-mono text-xs truncate flex-1", !(m.threadUnread ?? !m.isRead) || m.direction === "outbound" ? "text-muted-foreground/60" : "font-bold text-foreground")}>
                      {m.isDraft ? (m.to ? `To: ${m.to}` : "Draft") : m.direction === "outbound" ? m.to : m.from}
                    </span>
                    {m.isStarred && <Star className="w-3 h-3 text-yellow-400 fill-yellow-400 flex-shrink-0" />}
                    <span className="font-mono text-[9px] text-muted-foreground/30 flex-shrink-0">{formatDate(m.receivedAt ?? m.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <p className={cn("font-mono text-[10px] truncate", !(m.threadUnread ?? !m.isRead) || m.direction === "outbound" ? "text-muted-foreground/40" : "text-foreground/70")}>
                      {m.subject || "(no subject)"}
                    </p>
                    {!!m.messageCount && m.messageCount > 1 && (
                      <span className="font-mono text-[9px] text-primary/70 flex-shrink-0">({m.messageCount})</span>
                    )}
                    {m.hasAttachments && <Paperclip className="w-2.5 h-2.5 text-muted-foreground/30 flex-shrink-0" />}
                    {active.folder === "snoozed" && m.snoozedUntil && (
                      <span className="inline-flex items-center gap-1 font-mono text-[9px] text-primary/70 flex-shrink-0">
                        <Clock className="w-2.5 h-2.5" /> Until {formatDate(m.snoozedUntil)}
                      </span>
                    )}
                    {active.folder === "scheduled" && m.scheduledSendAt && (
                      <span className="inline-flex items-center gap-1 font-mono text-[9px] text-primary/70 flex-shrink-0">
                        <CalendarClock className="w-2.5 h-2.5" /> Sends {formatDate(m.scheduledSendAt)}
                      </span>
                    )}
                    {active.folder === "outbox" && m.undoExpiresAt && (
                      <OutboxUndoChip messageId={m.id} undoExpiresAt={m.undoExpiresAt} token={token} onUndone={refreshAll} />
                    )}
                    {m.direction === "outbound" && m.deliveryStatus && (() => {
                      const meta = DELIVERY_STATUS_META[m.deliveryStatus];
                      const Icon = meta.icon;
                      return (
                        <span title={m.bounceReason ?? undefined} className={cn("inline-flex items-center gap-1 font-mono text-[9px] flex-shrink-0", meta.className)}>
                          <Icon className={cn("w-2.5 h-2.5", meta.spin && "animate-spin")} /> {meta.label}
                        </span>
                      );
                    })()}
                    {/* Bounce + Complaint Handling (Phase 1) — shown
                        alongside (not instead of) the delivery-status badge
                        above, since a complained message was still
                        delivered. */}
                    {m.direction === "outbound" && m.complainedAt && (
                      <span title="Recipient marked this as spam" className="inline-flex items-center gap-1 font-mono text-[9px] flex-shrink-0 text-amber-400/80">
                        <Flag className="w-2.5 h-2.5" /> Spam report
                      </span>
                    )}
                    {m.labels.map((l) => <LabelChip key={l.id} label={l} />)}
                  </div>
                </button>
                {/* Quick reactions — toggle without opening the message. */}
                <button
                  onClick={() => toggleStarOnMessage(m)}
                  title={m.isStarred ? "Unstar" : "Star"}
                  className="flex-shrink-0 mt-0.5 text-muted-foreground/30 hover:text-yellow-400"
                >
                  <Star className={cn("w-3.5 h-3.5", m.isStarred && "text-yellow-400 fill-yellow-400")} />
                </button>
                <button
                  onClick={() => toggleReadOnMessage(m)}
                  title={m.isRead ? "Mark unread" : "Mark read"}
                  className="flex-shrink-0 mt-0.5 text-muted-foreground/30 hover:text-muted-foreground/70"
                >
                  {m.isRead ? <MailOpen className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5 fill-primary/40 text-primary" />}
                </button>
                {active.folder === "snoozed" ? (
                  <button onClick={() => unsnoozeMessage(m)} title="Unsnooze" className="flex-shrink-0 mt-0.5 text-muted-foreground/30 hover:text-muted-foreground/70">
                    <BellOff className="w-3.5 h-3.5" />
                  </button>
                ) : active.folder === "scheduled" ? (
                  <button onClick={() => cancelScheduleMessage(m)} title="Cancel send" className="flex-shrink-0 mt-0.5 text-muted-foreground/30 hover:text-red-400">
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                ) : active.folder === "inbox" && (
                  <SnoozeMenu
                    onSnooze={(until) => snoozeMessage(m, until)}
                    trigger={
                      <button title="Snooze" className="flex-shrink-0 mt-0.5 text-muted-foreground/30 hover:text-muted-foreground/70">
                        <Clock className="w-3.5 h-3.5" />
                      </button>
                    }
                  />
                )}
                <LabelPickerMenu
                  labels={labels}
                  selectedIds={m.labels.map((l) => l.id)}
                  onToggle={(labelId) => toggleLabelOnMessage(m, labelId)}
                  trigger={
                    <button className="flex-shrink-0 mt-0.5 text-muted-foreground/30 hover:text-muted-foreground/70">
                      <Tags className="w-3.5 h-3.5" />
                    </button>
                  }
                />
                <MoveToMenu
                  current={active}
                  systemFolders={systemFolders}
                  customFolders={customFolders}
                  onMove={async (folder, folderId) => {
                    await authedFetch(token, `/ayzen-email/mailbox/${m.id}/move`, {
                      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder, folderId }),
                    });
                    refreshAll();
                  }}
                  trigger={
                    <button className="flex-shrink-0 mt-0.5 text-muted-foreground/30 hover:text-muted-foreground/70">
                      <FolderInput className="w-3.5 h-3.5" />
                    </button>
                  }
                />
              </div>
            ))}
            </div>
          </>
        )}
      </div>

      <ComposeDialog
        open={composing}
        onOpenChange={setComposing}
        fromAddress={ayzenEmail ?? ""}
        signature={mailboxSignature}
        signatureEnabled={mailboxSignatureEnabled}
        templates={templates}
        onTemplatesChanged={fetchTemplates}
        onSent={(opts) => { refreshAll(); if (!opts?.silent) toast({ title: "Check the Sent tab" }); }}
        onDraftSaved={() => { if (active.folder === "drafts") fetchMessages(); fetchFolders(); }}
      />

      {editingDraft && (
        <ComposeDialog
          open={!!editingDraft}
          onOpenChange={(v) => { if (!v) setEditingDraft(null); }}
          fromAddress={ayzenEmail ?? ""}
          draftId={editingDraft.id}
          defaultTo={editingDraft.to}
          defaultCc={editingDraft.cc ?? undefined}
          defaultBcc={editingDraft.bcc ?? undefined}
          defaultSubject={editingDraft.subject ?? ""}
          defaultBody={editingDraft.html || editingDraft.text || ""}
          defaultBodyIsHtml={!!editingDraft.html}
          signature={mailboxSignature}
          signatureEnabled={mailboxSignatureEnabled}
          templates={templates}
          onTemplatesChanged={fetchTemplates}
          onSent={(opts) => { setEditingDraft(null); refreshAll(); if (!opts?.silent) toast({ title: "Check the Sent tab" }); }}
          onDraftSaved={() => { fetchMessages(); fetchFolders(); }}
        />
      )}

      {/* New folder */}
      <Dialog open={newFolderOpen} onOpenChange={(v) => { setNewFolderOpen(v); if (!v) setNewFolderName(""); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
              <FolderPlus className="w-4 h-4 text-primary" /> New Folder
            </DialogTitle>
          </DialogHeader>
          <Input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createFolder(); }}
            placeholder="Folder name"
            className="font-mono text-xs"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewFolderOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button onClick={createFolder} disabled={!newFolderName.trim()} className="font-mono text-xs">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename folder */}
      <Dialog open={!!renameFolder} onOpenChange={(v) => { if (!v) setRenameFolder(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
              <Pencil className="w-4 h-4 text-primary" /> Rename Folder
            </DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitRename(); }}
            className="font-mono text-xs"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameFolder(null)} className="font-mono text-xs">Cancel</Button>
            <Button onClick={submitRename} disabled={!renameValue.trim()} className="font-mono text-xs">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete folder */}
      <AlertDialog open={!!deleteFolder} onOpenChange={(v) => { if (!v) setDeleteFolder(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm">Delete "{deleteFolder?.name}"?</AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs">
              The folder will be removed. Any messages in it move to Archive — nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteFolder} className="font-mono text-xs bg-red-500/90 hover:bg-red-500">Delete folder</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Empty trash */}
      <AlertDialog open={emptyTrashOpen} onOpenChange={setEmptyTrashOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm">Empty Trash?</AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs">
              All messages in Trash will be permanently deleted and can't be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmEmptyTrash} className="font-mono text-xs bg-red-500/90 hover:bg-red-500">Empty Trash</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete */}
      <AlertDialog open={bulkDeleteConfirm} onOpenChange={setBulkDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm">Delete {selectedIds.size} message(s)?</AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs">
              Anything already in Trash is deleted permanently. Everything else moves to Trash and can be restored later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setBulkDeleteConfirm(false); runBulkAction({ action: "delete" }); }}
              className="font-mono text-xs bg-red-500/90 hover:bg-red-500"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SignatureDialog
        open={signatureDialogOpen}
        onOpenChange={setSignatureDialogOpen}
        token={token}
        signature={mailboxSignature}
        enabled={mailboxSignatureEnabled}
        onSaved={(sig, en) => { setMailboxSignature(sig); setMailboxSignatureEnabled(en); }}
      />

      <TemplatesManagerDialog
        open={templatesManagerOpen}
        onOpenChange={setTemplatesManagerOpen}
        token={token}
        templates={templates}
        onChanged={fetchTemplates}
      />

      <LabelDialog
        open={labelDialogOpen}
        onOpenChange={(v) => { setLabelDialogOpen(v); if (!v) setEditingLabel(null); }}
        token={token}
        label={editingLabel}
        onSaved={() => { fetchLabels(); refreshAll(); }}
        onRequestDelete={(l) => { setLabelDialogOpen(false); setEditingLabel(null); setDeleteLabelTarget(l); }}
      />

      {/* Delete label */}
      <AlertDialog open={!!deleteLabelTarget} onOpenChange={(v) => { if (!v) setDeleteLabelTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm">Delete label "{deleteLabelTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs">
              This removes the label from every message that has it. The messages themselves aren't touched — only the tag.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteLabelTarget) return;
                await authedFetch(token, `/ayzen-email/mailbox/labels/${deleteLabelTarget.id}`, { method: "DELETE" });
                setFilters((prev) => prev.labelId === deleteLabelTarget.id ? { ...prev, labelId: null } : prev);
                setDeleteLabelTarget(null);
                fetchLabels(); refreshAll();
              }}
              className="font-mono text-xs bg-red-500/90 hover:bg-red-500"
            >
              Delete label
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RulesDialog
        open={rulesDialogOpen}
        onOpenChange={setRulesDialogOpen}
        token={token}
        rules={rules}
        labels={labels}
        systemFolders={systemFolders}
        customFolders={customFolders}
        onChanged={fetchRules}
      />

      <AttachmentSearchDialog
        open={attachmentSearchOpen}
        onOpenChange={setAttachmentSearchOpen}
        token={token}
        onOpenMessage={(id) => { setAttachmentSearchOpen(false); navigate(`/mailbox/${id}`); }}
      />

      <AnalyticsDialog open={analyticsOpen} onOpenChange={setAnalyticsOpen} />
    </div>
  );
}

// ─── Signature settings dialog ──────────────────────────────────────────────
function SignatureDialog({
  open, onOpenChange, token, signature, enabled, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  token: string | null;
  signature: string;
  enabled: boolean;
  onSaved: (signature: string, enabled: boolean) => void;
}) {
  const { toast } = useToast();
  const editorRef = useRef<RichTextEditorHandle>(null);
  const [draftHtml, setDraftHtml] = useState(signature);
  const [draftEnabled, setDraftEnabled] = useState(enabled);
  const [resetKey, setResetKey] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraftHtml(signature);
      setDraftEnabled(enabled);
      setResetKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature, enabled]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/signature`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: draftHtml, enabled: draftEnabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save signature");
      onSaved(data.signature ?? "", data.enabled ?? draftEnabled);
      toast({ title: "Signature saved" });
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not save signature", description: err?.message ?? "Network error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
            <PenTool className="w-4 h-4 text-primary" /> Signature
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <RichTextEditor
            ref={editorRef}
            html={draftHtml}
            resetKey={resetKey}
            onChange={setDraftHtml}
            placeholder="Your name, title, links…"
          />
          <div className="flex items-center justify-between bg-muted/10 border border-border/20 rounded-lg px-3 py-2.5">
            <div>
              <p className="font-mono text-[11px] text-foreground/80">Auto-insert</p>
              <p className="font-mono text-[9px] text-muted-foreground/40">Adds this to new messages, replies, and forwards automatically</p>
            </div>
            <Switch checked={draftEnabled} onCheckedChange={setDraftEnabled} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="font-mono text-xs">Cancel</Button>
          <Button onClick={save} disabled={saving} className="font-mono text-xs gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Label create/edit dialog ───────────────────────────────────────────────
function LabelDialog({
  open, onOpenChange, token, label, onSaved, onRequestDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  token: string | null;
  label: LabelWithCount | null;
  onSaved: () => void;
  onRequestDelete: (label: LabelWithCount) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState<AyzenLabelColor>("sky");
  const [saving, setSaving] = useState(false);
  const isEditing = !!label;

  useEffect(() => {
    if (open) { setName(label?.name ?? ""); setColor((label?.color as AyzenLabelColor) ?? "sky"); }
  }, [open, label]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const res = await authedFetch(
        token,
        isEditing ? `/ayzen-email/mailbox/labels/${label!.id}` : `/ayzen-email/mailbox/labels`,
        { method: isEditing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: trimmed, color }) },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save label");
      onSaved();
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not save label", description: err?.message ?? "Network error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
            <Tag className="w-4 h-4 text-primary" /> {isEditing ? "Edit Label" : "New Label"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder="Label name"
            className="font-mono text-xs"
            autoFocus
            maxLength={40}
          />
          <div>
            <Label className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground/50">Color</Label>
            <div className="flex items-center gap-2 mt-1.5">
              {AYZEN_LABEL_COLORS.map((c) => (
                <ColorSwatch key={c} color={c} selected={color === c} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter className="flex items-center justify-between sm:justify-between w-full">
          {isEditing ? (
            <Button variant="ghost" onClick={() => onRequestDelete(label!)} className="font-mono text-xs text-red-400/80 gap-1.5 mr-auto">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} className="font-mono text-xs">Cancel</Button>
            <Button onClick={save} disabled={saving || !name.trim()} className="font-mono text-xs gap-1.5">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Rules dialog ────────────────────────────────────────────────────────────
// Lists existing rules with enable/disable + delete, and a form to add a
// new one. Kept as a single dialog (list + create form together) rather
// than separate screens since the total rule count per user is expected
// to be small (a handful, not hundreds) — no pagination needed.
function RulesDialog({
  open, onOpenChange, token, rules, labels, systemFolders, customFolders, onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  token: string | null;
  rules: MailRule[];
  labels: LabelWithCount[];
  systemFolders: FolderCounts[];
  customFolders: CustomFolder[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [field, setField] = useState<RuleField>("from");
  const [matchType, setMatchType] = useState<RuleMatchType>("contains");
  const [value, setValue] = useState("");
  const [actionLabelId, setActionLabelId] = useState<number | null>(null);
  const [actionFolder, setActionFolder] = useState<string | null>(null); // system key, "custom", or null
  const [actionFolderId, setActionFolderId] = useState<number | null>(null);
  const [actionMarkRead, setActionMarkRead] = useState(false);
  const [actionStar, setActionStar] = useState(false);
  const [applyToExisting, setApplyToExisting] = useState(false);
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setRuleName(""); setField("from"); setMatchType("contains"); setValue("");
    setActionLabelId(null); setActionFolder(null); setActionFolderId(null);
    setActionMarkRead(false); setActionStar(false); setApplyToExisting(false);
    setShowForm(false);
  };

  const hasAction = actionLabelId != null || !!actionFolder || actionMarkRead || actionStar;

  const createRule = async () => {
    if (!ruleName.trim() || !value.trim() || !hasAction) return;
    setSaving(true);
    try {
      const res = await authedFetch(token, `/ayzen-email/mailbox/rules`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: ruleName.trim(), field, matchType, value: value.trim(),
          actionLabelId, actionFolder, actionFolderId, actionMarkRead, actionStar, applyToExisting,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create rule");
      toast({
        title: "Rule created",
        description: applyToExisting ? `Applied to ${data.messagesTouched ?? 0} existing message(s)` : undefined,
      });
      resetForm();
      onChanged();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not create rule", description: err?.message ?? "Network error" });
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (rule: MailRule) => {
    await authedFetch(token, `/ayzen-email/mailbox/rules/${rule.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rule, enabled: !rule.enabled }),
    });
    onChanged();
  };

  const deleteRule = async (rule: MailRule) => {
    await authedFetch(token, `/ayzen-email/mailbox/rules/${rule.id}`, { method: "DELETE" });
    onChanged();
  };

  const describeRule = (r: MailRule) => {
    const actions: string[] = [];
    const label = labels.find((l) => l.id === r.actionLabelId);
    if (label) actions.push(`label "${label.name}"`);
    if (r.actionFolder) {
      const folderLabel = r.actionFolder === "custom"
        ? (customFolders.find((f) => f.id === r.actionFolderId)?.name ?? "folder")
        : FOLDER_LABELS[r.actionFolder as SystemFolderKey];
      actions.push(`move to ${folderLabel}`);
    }
    if (r.actionMarkRead) actions.push("mark read");
    if (r.actionStar) actions.push("star");
    return `${RULE_FIELD_LABELS[r.field]} ${RULE_MATCH_LABELS[r.matchType]} "${r.value}" → ${actions.join(", ") || "no action"}`;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) resetForm(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" /> Rules
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {rules.length === 0 && !showForm && (
            <p className="font-mono text-[10px] text-muted-foreground/40 py-2">
              No rules yet. Rules run automatically on new inbound mail — e.g. label everything from a sender, or move newsletters straight to a folder.
            </p>
          )}
          {rules.map((r) => (
            <div key={r.id} className={cn("flex items-start gap-2.5 border border-border/20 rounded-lg px-3 py-2.5", !r.enabled && "opacity-40")}>
              <Switch checked={r.enabled} onCheckedChange={() => toggleEnabled(r)} className="mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs font-bold truncate">{r.name}</p>
                <p className="font-mono text-[9px] text-muted-foreground/50 truncate">{describeRule(r)}</p>
              </div>
              <button onClick={() => deleteRule(r)} className="flex-shrink-0 text-muted-foreground/30 hover:text-red-400 mt-0.5">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        {showForm ? (
          <div className="space-y-3 border border-border/20 rounded-lg p-3">
            <Input value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="Rule name" className="font-mono text-xs" autoFocus maxLength={60} />

            <div className="flex items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="font-mono text-[10px] gap-1">{RULE_FIELD_LABELS[field]} <ChevronDown className="w-3 h-3" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="font-mono text-xs">
                  {RULE_FIELDS.map((f) => <DropdownMenuItem key={f} onClick={() => setField(f)} className="text-xs">{RULE_FIELD_LABELS[f]}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="font-mono text-[10px] gap-1">{RULE_MATCH_LABELS[matchType]} <ChevronDown className="w-3 h-3" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="font-mono text-xs">
                  {RULE_MATCH_TYPES.map((mt) => <DropdownMenuItem key={mt} onClick={() => setMatchType(mt)} className="text-xs">{RULE_MATCH_LABELS[mt]}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
              <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. billing@stripe.com" className="font-mono text-xs flex-1" maxLength={200} />
            </div>

            <div className="space-y-1.5">
              <Label className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground/50">Then</Label>
              <div className="flex items-center gap-1.5 flex-wrap">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="font-mono text-[10px] gap-1">
                      <Tag className="w-3 h-3" /> {labels.find((l) => l.id === actionLabelId)?.name ?? "Add label"} <ChevronDown className="w-3 h-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="font-mono text-xs">
                    <DropdownMenuItem onClick={() => setActionLabelId(null)} className="text-xs text-muted-foreground/50">None</DropdownMenuItem>
                    {labels.map((l) => <DropdownMenuItem key={l.id} onClick={() => setActionLabelId(l.id)} className="gap-2 text-xs"><LabelDot color={l.color} /> {l.name}</DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="font-mono text-[10px] gap-1">
                      <FolderInput className="w-3 h-3" />
                      {actionFolder === "custom" ? (customFolders.find((f) => f.id === actionFolderId)?.name ?? "Folder") : actionFolder ? FOLDER_LABELS[actionFolder as SystemFolderKey] : "Move to"}
                      <ChevronDown className="w-3 h-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="font-mono text-xs">
                    <DropdownMenuItem onClick={() => { setActionFolder(null); setActionFolderId(null); }} className="text-xs text-muted-foreground/50">Don't move</DropdownMenuItem>
                    {systemFolders.filter((f) => f.key !== "drafts" && f.key !== "sent").map((f) => (
                      <DropdownMenuItem key={f.key} onClick={() => { setActionFolder(f.key); setActionFolderId(null); }} className="text-xs">{f.label}</DropdownMenuItem>
                    ))}
                    {customFolders.map((f) => (
                      <DropdownMenuItem key={f.id} onClick={() => { setActionFolder("custom"); setActionFolderId(f.id); }} className="text-xs">{f.name}</DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <FilterChip active={actionMarkRead} icon={MailOpen} label="Mark read" onClick={() => setActionMarkRead((v) => !v)} />
                <FilterChip active={actionStar} icon={Star} label="Star" onClick={() => setActionStar((v) => !v)} />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch checked={applyToExisting} onCheckedChange={setApplyToExisting} />
              <Label className="font-mono text-[10px] text-muted-foreground/60">Also apply to existing mail</Label>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={resetForm} className="font-mono text-xs">Cancel</Button>
              <Button onClick={createRule} disabled={saving || !ruleName.trim() || !value.trim() || !hasAction} className="font-mono text-xs gap-1.5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Create rule
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="font-mono text-xs gap-1.5 w-full">
            <Zap className="w-3.5 h-3.5" /> New rule
          </Button>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="font-mono text-xs">Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Attachment search — Attachment System 2.0 ─────────────────────────────
// Finds attachments by filename across every folder (unlike the main mail
// search box, which only matches subject/from/to/cc/bcc). Selecting a
// result opens that message's thread directly.
// ─── Mail Analytics dialog ──────────────────────────────────────────────────
interface MailAnalytics {
  emailsReceived: number; emailsSent: number; unread: number; attachments: number;
  avgResponseMs: number | null; correspondentCount: number;
  topCorrespondents: { email: string; name: string | null; count: number; lastInteraction: string }[];
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `${hrs}h ${rem}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function AnalyticsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { token } = useAuth();
  const [data, setData] = useState<MailAnalytics | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    authedFetch(token, `/ayzen-email/mailbox/analytics`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setData(d))
      .finally(() => setLoading(false));
  }, [open, token]);

  const stats = data ? [
    { label: "Emails received", value: data.emailsReceived },
    { label: "Emails sent", value: data.emailsSent },
    { label: "Unread", value: data.unread },
    { label: "Avg response time", value: formatDuration(data.avgResponseMs) },
    { label: "Top correspondents", value: data.correspondentCount },
    { label: "Attachments", value: data.attachments },
  ] : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" /> Mail Analytics
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
        ) : !data ? (
          <p className="font-mono text-xs text-muted-foreground/50 text-center py-8">Could not load analytics</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2.5">
              {stats.map((s) => (
                <div key={s.label} className="bg-muted/10 border border-border/20 rounded-lg px-3 py-2.5">
                  <p className="font-mono text-lg font-bold">{s.value}</p>
                  <p className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground/50 mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>
            {data.topCorrespondents.length > 0 && (
              <div className="space-y-1.5">
                <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/50">Top correspondents</p>
                <div className="space-y-1">
                  {data.topCorrespondents.map((c) => (
                    <div key={c.email} className="flex items-center justify-between gap-2 bg-muted/5 border border-border/10 rounded px-2.5 py-1.5">
                      <div className="min-w-0">
                        <p className="font-mono text-[11px] truncate">{c.name || c.email}</p>
                        {c.name && <p className="font-mono text-[9px] text-muted-foreground/40 truncate">{c.email}</p>}
                      </div>
                      <span className="font-mono text-[10px] text-primary/70 flex-shrink-0">{c.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface AttachmentSearchResult {
  attachment: { id: number; filename: string; contentType: string; sizeBytes: number };
  message: {
    id: number; subject: string | null; from: string; to: string;
    folder: SystemFolderKey | "custom"; folderId: number | null;
    receivedAt: string | null; createdAt: string;
  };
}

function AttachmentSearchDialog({
  open, onOpenChange, token, onOpenMessage,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  token: string | null;
  onOpenMessage: (messageId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AttachmentSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(""); setResults(null); setLoading(false);
  }, [open]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    if (!q) { setResults(null); setLoading(false); return; }
    setLoading(true);
    debounce.current = setTimeout(() => {
      authedFetch(token, `/ayzen-email/mailbox/attachments/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.ok ? r.json() : { results: [] })
        .then((data) => setResults(data.results ?? []))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, token]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm uppercase tracking-wider flex items-center gap-2">
            <Paperclip className="w-4 h-4 text-primary" /> Search Attachments
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-muted-foreground/40 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filename…  e.g. invoice.pdf"
              className="font-mono text-xs pl-9"
            />
          </div>

          <div className="max-h-80 overflow-y-auto space-y-1.5">
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40" />
              </div>
            )}
            {!loading && results && results.length === 0 && (
              <p className="font-mono text-[11px] text-muted-foreground/40 text-center py-8">No attachments match "{query}"</p>
            )}
            {!loading && results?.map((r) => {
              const Icon = attachmentIcon(r.attachment.contentType);
              return (
                <button
                  key={r.attachment.id}
                  onClick={() => onOpenMessage(r.message.id)}
                  className="w-full flex items-center gap-2.5 bg-muted/10 border border-border/20 rounded px-3 py-2 hover:bg-muted/20 transition-colors text-left"
                >
                  <Icon className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] truncate flex-1">{r.attachment.filename}</span>
                      <span className="font-mono text-[9px] text-muted-foreground/40 flex-shrink-0">{formatBytes(r.attachment.sizeBytes)}</span>
                    </div>
                    <p className="font-mono text-[9px] text-muted-foreground/40 truncate">
                      {r.message.subject || "(no subject)"} — {FOLDER_LABELS[r.message.folder as SystemFolderKey] ?? "Folder"}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="font-mono text-xs">Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
