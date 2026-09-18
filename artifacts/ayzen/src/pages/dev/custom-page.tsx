import { useEffect, useRef, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { resolveDevNavIcon } from "@/lib/dev-nav-icons";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { NavType } from "@/hooks/use-dev-nav";
import {
  FileQuestion, Settings2, ArrowLeft, Pencil, Save, X, Loader2,
  Bold, Italic, Underline, Heading2, Heading3, Pilcrow, List, ListOrdered,
  Quote, Link2, Undo2, Redo2, Eraser, Sparkles,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface DevNavItem {
  id: number;
  label: string;
  icon: string;
  href: string | null;
  content: string | null;
  enabled: boolean;
}

/**
 * Strips anything that could execute on render — this HTML is
 * author-trusted (only dev/admin can save it, same gate the API enforces)
 * but we still scrub script tags / inline event handlers / javascript:
 * URLs before it ever hits dangerouslySetInnerHTML, same discipline any
 * admin-authored WYSIWYG field should get.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#$2");
}

function ToolbarButton({ label, icon: Icon, onClick, active }: {
  label: string; icon: typeof Bold; onClick: () => void; active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className={cn(
            "p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors",
            active && "bg-primary/10 text-primary"
          )}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Blank landing page for any sidebar entry created from a Sidebar Builder
 * tab (Dev/User/Admin/Moderator/Team Leader) without an explicit href —
 * now doubles as that page's WordPress-style content editor: dev/admin
 * users can write and format a real page body right here (title + rich
 * text), saved back onto the dev_nav_items row itself, no extra route or
 * migration needed. Matches its own URL against that navType's nav-item
 * rows so it always shows the right title/icon/content. One route per
 * navType renders this same component with a fixed navType (see
 * route-config.tsx).
 */
export default function DevCustomPage({ navType = "dev" }: { navType?: NavType }) {
  const [location] = useLocation();
  const { token, isDev, isAdmin } = useAuth();
  const { toast } = useToast();
  const canEdit = isDev || isAdmin;

  const [item, setItem] = useState<DevNavItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setNotFound(false);
    setEditing(false);
    (async () => {
      if (!token) return;
      const r = await fetch(`${BASE}/api/admin/nav/${navType}/by-href?href=${encodeURIComponent(location)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (cancelled) return;
      if (r.ok) setItem(await r.json());
      else setNotFound(true);
    })();
    return () => { cancelled = true; };
  }, [location, token, navType]);

  const Icon = resolveDevNavIcon(item?.icon);

  const startEditing = () => {
    if (!item) return;
    setTitleDraft(item.label);
    setEditing(true);
    // populate the contentEditable after it mounts
    requestAnimationFrame(() => {
      if (editorRef.current) editorRef.current.innerHTML = item.content ?? "";
    });
  };

  const cancelEditing = () => setEditing(false);

  const exec = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
  };

  const insertLink = () => {
    const url = window.prompt("Link URL:", "https://");
    if (url) exec("createLink", url);
  };

  const save = async () => {
    if (!item || !token) return;
    const html = sanitizeHtml(editorRef.current?.innerHTML ?? "");
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/admin/nav/${navType}/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: titleDraft.trim() || item.label, content: html }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast({ title: "Couldn't save page", description: body?.error, variant: "destructive" });
        return;
      }
      const updated = await r.json();
      setItem(updated);
      setEditing(false);
      toast({ title: "Page saved" });
    } catch (e: any) {
      toast({ title: "Couldn't save page", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // ── Editing mode: title field + toolbar + contentEditable body ─────────
  if (editing && item) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="Page title"
            className="text-lg font-mono font-semibold h-auto py-2 border-none px-0 focus-visible:ring-0 shadow-none"
          />
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={cancelEditing} disabled={saving}>
              <X className="w-3.5 h-3.5" /> Cancel
            </Button>
            <Button size="sm" className="gap-1.5" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </Button>
          </div>
        </div>

        <Card>
          <div className="flex flex-wrap items-center gap-0.5 p-1.5 border-b border-border/40">
            <ToolbarButton label="Bold" icon={Bold} onClick={() => exec("bold")} />
            <ToolbarButton label="Italic" icon={Italic} onClick={() => exec("italic")} />
            <ToolbarButton label="Underline" icon={Underline} onClick={() => exec("underline")} />
            <Separator orientation="vertical" className="h-4 mx-1" />
            <ToolbarButton label="Heading 2" icon={Heading2} onClick={() => exec("formatBlock", "h2")} />
            <ToolbarButton label="Heading 3" icon={Heading3} onClick={() => exec("formatBlock", "h3")} />
            <ToolbarButton label="Paragraph" icon={Pilcrow} onClick={() => exec("formatBlock", "p")} />
            <Separator orientation="vertical" className="h-4 mx-1" />
            <ToolbarButton label="Bullet list" icon={List} onClick={() => exec("insertUnorderedList")} />
            <ToolbarButton label="Numbered list" icon={ListOrdered} onClick={() => exec("insertOrderedList")} />
            <ToolbarButton label="Quote" icon={Quote} onClick={() => exec("formatBlock", "blockquote")} />
            <ToolbarButton label="Link" icon={Link2} onClick={insertLink} />
            <Separator orientation="vertical" className="h-4 mx-1" />
            <ToolbarButton label="Undo" icon={Undo2} onClick={() => exec("undo")} />
            <ToolbarButton label="Redo" icon={Redo2} onClick={() => exec("redo")} />
            <ToolbarButton label="Clear formatting" icon={Eraser} onClick={() => exec("removeFormat")} />
          </div>
          <CardContent className="p-0">
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              className={cn(
                "min-h-[50vh] px-6 py-5 text-sm leading-relaxed outline-none font-mono",
                "prose prose-sm prose-invert max-w-none",
                "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2",
                "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5",
                "[&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
                "[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
                "[&_a]:text-primary [&_a]:underline"
              )}
            />
          </CardContent>
        </Card>
        <p className="text-[11px] text-muted-foreground font-mono">
          Editing the {navType} page at <span className="text-foreground/70">{location}</span> — visible to anyone who can reach this link once saved.
        </p>
      </div>
    );
  }

  // ── View mode: rendered content, or the "not wired up yet" placeholder ──
  const hasContent = !!item?.content?.trim();

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      {item && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Icon className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-lg font-mono font-semibold">{item.label}</h1>
          </div>
          {canEdit && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={startEditing}>
              <Pencil className="w-3.5 h-3.5" /> {hasContent ? "Edit page" : "Build this page"}
            </Button>
          )}
        </div>
      )}

      {hasContent ? (
        <Card>
          <CardContent
            className={cn(
              "p-6 text-sm leading-relaxed font-mono",
              "prose prose-sm prose-invert max-w-none",
              "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2",
              "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5",
              "[&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
              "[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
              "[&_a]:text-primary [&_a]:underline"
            )}
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(item!.content!) }}
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center text-center gap-4 py-16">
            <div className="w-14 h-14 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              {notFound ? <FileQuestion className="w-7 h-7 text-muted-foreground" /> : <Icon className="w-7 h-7 text-primary" />}
            </div>
            <div>
              <h1 className="text-lg font-mono font-semibold">{item?.label ?? "New Page"}</h1>
              <p className="text-sm text-muted-foreground mt-1 font-mono max-w-sm">
                {canEdit
                  ? "This sidebar page is ready — write its content right here, or point this entry at a different route from the sidebar builder."
                  : "This sidebar page is ready — there's no content wired up here yet."}
              </p>
            </div>
            <div className="flex items-center gap-2 mt-2">
              {canEdit && item && (
                <Button size="sm" className="gap-1.5" onClick={startEditing}>
                  <Sparkles className="w-3.5 h-3.5" /> Build this page
                </Button>
              )}
              <Link href="/admin/dev-nav-builder">
                <Button variant="outline" size="sm" className="gap-1.5">
                  <Settings2 className="w-3.5 h-3.5" /> Edit in Sidebar Builder
                </Button>
              </Link>
              <Link href="/admin/dashboard">
                <Button variant="ghost" size="sm" className="gap-1.5">
                  <ArrowLeft className="w-3.5 h-3.5" /> Back
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
