/**
 * pages/user/developer.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this at: artifacts/ayzen/src/pages/user/developer.tsx
 *
 * The project-user-facing counterpart to the admin Developer console — this
 * one is scoped to the logged-in user's own account, not platform internals.
 * Three tabs:
 *   - API Keys   — full CRUD over the user's own AYZEN API keys (backend
 *                   already existed: routes/api-keys.ts, unused by any
 *                   frontend page until now).
 *   - MCP        — how to point an MCP client (Claude, etc.) at AYZEN using
 *                   the same API key (backend: routes/mcp.ts).
 *   - Usage & Logs — masked key list with last-used timestamps, sourced
 *                   from the same GET /api-keys response (lastUsedAt).
 */
import { useState, useEffect, useCallback } from "react";
import { useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Key, Plug, ScrollText, Plus, Trash2, RefreshCw, Copy, CheckCircle2, XCircle, Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface ApiKey {
  id: number;
  name: string;
  keyPrefix: string;
  type: "full" | "scoped";
  scopes?: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

function authHeaders(token: string | null) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` };
}

export default function UserDeveloper() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const search = useSearch();

  const params = new URLSearchParams(search);
  const tab = params.get("tab") ?? "keys";

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/api-keys`, { headers: authHeaders(token) });
      if (r.ok) setKeys((await r.json()).keys ?? []);
    } catch { } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const createKey = async () => {
    if (!newName.trim()) { toast({ variant: "destructive", title: "Name is required" }); return; }
    setCreating(true);
    try {
      const r = await fetch(`${BASE}/api/api-keys`, {
        method: "POST", headers: authHeaders(token),
        body: JSON.stringify({ name: newName.trim(), type: "full" }),
      });
      const data = await r.json();
      if (r.ok) {
        setRevealedKey(data.key ?? data.secret ?? data.plaintext);
        setNewName("");
        setCreateOpen(false);
        await fetchKeys();
      } else {
        toast({ variant: "destructive", title: "Failed to create key", description: data.error });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setCreating(false);
  };

  const revokeKey = async (id: number) => {
    try {
      const r = await fetch(`${BASE}/api/api-keys/${id}/revoke`, { method: "POST", headers: authHeaders(token) });
      if (r.ok) { toast({ title: "Key revoked" }); await fetchKeys(); }
    } catch { }
  };

  const deleteKey = async (id: number) => {
    try {
      const r = await fetch(`${BASE}/api/api-keys/${id}`, { method: "DELETE", headers: authHeaders(token) });
      if (r.ok) { toast({ title: "Key deleted" }); await fetchKeys(); }
    } catch { }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  const mcpUrl = `${window.location.origin}${BASE}/api/mcp`;

  return (
    <div className="max-w-4xl mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-xl font-mono font-bold text-foreground flex items-center gap-2">
          <Key className="w-5 h-5 text-primary" /> Developer
        </h1>
        <p className="text-xs font-mono text-muted-foreground mt-1">
          Generate API keys and connect AI clients like Claude directly to your AYZEN account.
        </p>
      </div>

      {tab === "keys" && (
        <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-mono font-bold text-foreground">Your API keys</div>
            <Button size="sm" className="font-mono text-xs gap-2" onClick={() => setCreateOpen(true)}>
              <Plus className="w-3.5 h-3.5" /> New Key
            </Button>
          </div>
          {loading ? (
            <div className="text-xs font-mono text-muted-foreground">Loading…</div>
          ) : keys.length === 0 ? (
            <div className="text-xs font-mono text-muted-foreground">No API keys yet. Create one to use the AYZEN API or connect MCP.</div>
          ) : (
            <div className="divide-y divide-card-border">
              {keys.map((k) => (
                <div key={k.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-mono text-foreground flex items-center gap-2">
                      {k.name}
                      {k.revoked
                        ? <Badge variant="destructive" className="text-[10px]">Revoked</Badge>
                        : <Badge className="text-[10px]"><CheckCircle2 className="w-3 h-3 mr-1" />Active</Badge>}
                    </div>
                    <div className="text-[11px] font-mono text-muted-foreground/60 mt-0.5">
                      {k.keyPrefix}••••••••••  ·  {k.type}
                      {k.lastUsedAt ? `  ·  last used ${new Date(k.lastUsedAt).toLocaleString()}` : "  ·  never used"}
                    </div>
                  </div>
                  {!k.revoked && (
                    <div className="flex gap-1 shrink-0">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs font-mono" onClick={() => revokeKey(k.id)}>
                        <XCircle className="w-3.5 h-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs font-mono text-destructive" onClick={() => deleteKey(k.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "mcp" && (
        <div className="bg-card border border-card-border rounded-lg p-5 space-y-4">
          <div className="text-sm font-mono font-bold text-foreground flex items-center gap-2">
            <Plug className="w-4 h-4 text-primary" /> Connect Claude (MCP)
          </div>
          <p className="text-xs font-mono text-muted-foreground">
            AYZEN exposes an MCP (Model Context Protocol) endpoint, secured with your own API key above.
            Add it as a remote MCP connector wherever your client supports one — it can read and update
            your vault entries, list projects, and pull a dashboard summary directly in conversation.
          </p>
          <div className="space-y-1">
            <Label className="text-xs font-mono">MCP Server URL</Label>
            <div className="flex gap-2">
              <Input readOnly value={mcpUrl} className="font-mono text-xs" />
              <Button size="sm" variant="outline" onClick={() => copy(mcpUrl)}><Copy className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-mono">Authorization header</Label>
            <Input readOnly value="Bearer <your API key>" className="font-mono text-xs" />
          </div>
          <p className="text-[11px] font-mono text-muted-foreground/60">
            Use a key from the API Keys tab — create one first if you haven't. Available tools: list/get/create/update
            vault entries, list projects, dashboard summary.
          </p>
        </div>
      )}

      {tab === "logs" && (
        <div className="bg-card border border-card-border rounded-lg p-5 space-y-3">
          <div className="text-sm font-mono font-bold text-foreground flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-primary" /> Usage &amp; Logs
          </div>
          {keys.length === 0 ? (
            <div className="text-xs font-mono text-muted-foreground">No keys yet — usage will show here once you create one.</div>
          ) : (
            <div className="divide-y divide-card-border">
              {keys.map((k) => (
                <div key={k.id} className="py-2.5 flex items-center justify-between">
                  <div className="text-xs font-mono text-foreground">{k.name} <span className="text-muted-foreground/50">({k.keyPrefix}••••)</span></div>
                  <div className="text-[11px] font-mono text-muted-foreground flex items-center gap-1.5">
                    <Clock className="w-3 h-3" />
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never used"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-mono">New API Key</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs font-mono">Name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Claude MCP" className="font-mono text-sm" />
            </div>
            <Button onClick={createKey} disabled={creating} className="w-full font-mono text-xs">
              {creating ? "Creating…" : "Create Key"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealedKey} onOpenChange={() => setRevealedKey(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-mono">Save this key now</DialogTitle></DialogHeader>
          <p className="text-xs font-mono text-muted-foreground">
            This is shown once. Copy it now — it can't be retrieved again after you close this dialog.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={revealedKey ?? ""} className="font-mono text-xs" />
            <Button size="sm" variant="outline" onClick={() => revealedKey && copy(revealedKey)}><Copy className="w-3.5 h-3.5" /></Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
