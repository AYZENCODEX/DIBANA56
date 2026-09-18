import { useState, useEffect, useCallback } from "react";
import { useSearch, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Bot, Send, Cpu, Terminal, Database, Trash2, RefreshCw, Save, Zap,
  Loader2, Code2, Server, ShieldCheck, Sparkles, Globe, Plus, Pencil,
  FileText, GitCommit, Layers, FolderTree, AlertTriangle, HardDrive,
  Hammer, FileCode2, Puzzle, Webhook, Router as RouterIcon, RotateCcw, X,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const token = () => localStorage.getItem("ayzen_token") ?? "";
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}/api${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts?.headers ?? {}) } });

type Tab = "agents" | "skills" | "providers" | "console";
const TAB_IDS: Tab[] = ["agents", "skills", "providers", "console"];

const ICONS: Record<string, any> = {
  Bot, HardDrive, Hammer, Database, Terminal, FileCode2, FileText, FolderTree,
  RotateCcw, ShieldCheck, GitCommit, Layers, Sparkles, Server, AlertTriangle,
  Puzzle, Webhook,
};
function AgentIcon({ name, className }: { name: string; className?: string }) {
  const Cmp = ICONS[name] ?? Bot;
  return <Cmp className={className} />;
}

interface AgentType {
  id: number; key: string; label: string; icon: string; description: string;
  provider_key: string; model: string; system_prompt: string;
  is_custom: boolean; enabled: boolean; sort_order: number;
  skill_count: number; skill_enabled_count: number;
}
interface Skill {
  id: number; key: string; agent_type_key: string; label: string; description: string;
  icon: string; handler_kind: "native" | "http_webhook"; handler_config: string;
  is_custom: boolean; enabled: boolean; sort_order: number;
}
interface Provider {
  id: number; key: string; label: string; base_url: string; api_key_env: string;
  is_custom: boolean; enabled: boolean; sort_order: number;
}

export default function McpAgentsPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const params = new URLSearchParams(search);
  const initialTab = (params.get("tab") as Tab) && TAB_IDS.includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "agents";
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    navigate(`/admin/mcp-agents?tab=${tab}`, { replace: true });
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const [types, setTypes] = useState<AgentType[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [t, s, p] = await Promise.all([
        api("/admin/mcp-agents/types").then(r => r.json()),
        api("/admin/mcp-agents/skills").then(r => r.json()),
        api("/admin/mcp-agents/providers").then(r => r.json()),
      ]);
      setTypes(t); setSkills(s); setProviders(p);
    } catch {
      toast({ title: "Failed to load MCP agent config", variant: "destructive" });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold">MCP Agents</h1>
          <span className="text-xs text-muted-foreground">Modular agent types, skills &amp; router</span>
        </div>
        <Button size="sm" variant="outline" onClick={loadAll} disabled={loading}>
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      <div className="flex gap-1 border-b border-border/60 overflow-x-auto">
        {([
          ["agents", "Agents", Bot],
          ["skills", "Skills", Puzzle],
          ["providers", "Providers / Router", RouterIcon],
          ["console", "Console", Terminal],
        ] as [Tab, string, any][]).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap",
              tab === id ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      {loading && !types ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : (
        <>
          {tab === "agents" && <AgentsTab types={types ?? []} providers={providers ?? []} reload={loadAll} toast={toast} />}
          {tab === "skills" && <SkillsTab skills={skills ?? []} types={types ?? []} reload={loadAll} toast={toast} />}
          {tab === "providers" && <ProvidersTab providers={providers ?? []} reload={loadAll} toast={toast} />}
          {tab === "console" && <ConsoleTab types={types ?? []} toast={toast} />}
        </>
      )}
    </div>
  );
}

// ── Agents tab ────────────────────────────────────────────────────────────────
function AgentsTab({ types, providers, reload, toast }: { types: AgentType[]; providers: Provider[]; reload: () => void; toast: any }) {
  const [editing, setEditing] = useState<AgentType | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle(t: AgentType) {
    await api(`/admin/mcp-agents/types/${t.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !t.enabled }) });
    reload();
  }
  async function remove(t: AgentType) {
    if (!confirm(`Delete custom agent type "${t.label}"? Its skills are removed too.`)) return;
    const r = await api(`/admin/mcp-agents/types/${t.id}`, { method: "DELETE" });
    if (!r.ok) { toast({ title: (await r.json()).error, variant: "destructive" }); return; }
    reload();
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}><Plus className="w-3.5 h-3.5 mr-1.5" /> Add Agent Type</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {types.map(t => (
          <Card key={t.id} className={cn("p-4 space-y-2", !t.enabled && "opacity-60")}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <AgentIcon name={t.icon} className="w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm truncate">{t.label}</span>
                    {!t.is_custom && <Badge variant="secondary" className="text-[9px] px-1.5">built-in</Badge>}
                  </div>
                  <span className="text-[11px] text-muted-foreground font-mono">{t.key}</span>
                </div>
              </div>
              <Switch checked={t.enabled} onCheckedChange={() => toggle(t)} />
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>
            <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
              <Badge variant="outline" className="gap-1"><Globe className="w-3 h-3" />{t.provider_key}</Badge>
              <Badge variant="outline" className="gap-1"><Cpu className="w-3 h-3" />{t.model}</Badge>
              <Badge variant="outline" className="gap-1"><Puzzle className="w-3 h-3" />{t.skill_enabled_count}/{t.skill_count} skills</Badge>
            </div>
            <div className="flex justify-end gap-1.5 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setEditing(t)}><Pencil className="w-3.5 h-3.5 mr-1" /> Edit</Button>
              {t.is_custom && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(t)}><Trash2 className="w-3.5 h-3.5" /></Button>}
            </div>
          </Card>
        ))}
      </div>

      <AgentTypeDialog
        open={!!editing || creating}
        initial={editing}
        providers={providers}
        busy={busy}
        onClose={() => { setEditing(null); setCreating(false); }}
        onSave={async (payload) => {
          setBusy(true);
          try {
            const r = editing
              ? await api(`/admin/mcp-agents/types/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) })
              : await api("/admin/mcp-agents/types", { method: "POST", body: JSON.stringify(payload) });
            if (!r.ok) { toast({ title: (await r.json()).error, variant: "destructive" }); return; }
            toast({ title: editing ? "Agent type updated" : "Agent type created" });
            setEditing(null); setCreating(false);
            reload();
          } finally { setBusy(false); }
        }}
      />
    </div>
  );
}

function AgentTypeDialog({ open, initial, providers, busy, onClose, onSave }: {
  open: boolean; initial: AgentType | null; providers: Provider[]; busy: boolean;
  onClose: () => void; onSave: (p: any) => void;
}) {
  const [form, setForm] = useState<any>({});
  useEffect(() => {
    if (open) setForm(initial ?? { key: "", label: "", icon: "Bot", description: "", provider_key: providers[0]?.key ?? "groq", model: "llama-3.3-70b-versatile", system_prompt: "" });
  }, [open, initial, providers]);

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{initial ? `Edit ${initial.label}` : "New Agent Type"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {!initial && (
            <div className="space-y-1">
              <Label className="text-xs">Key (unique, lowercase)</Label>
              <Input value={form.key ?? ""} onChange={e => setForm({ ...form, key: e.target.value })} placeholder="e.g. deploy" />
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Label</Label>
            <Input value={form.label ?? ""} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Deploy Agent" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description</Label>
            <Input value={form.description ?? ""} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Router (Provider)</Label>
              <Select value={form.provider_key ?? "groq"} onValueChange={v => setForm({ ...form, provider_key: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{providers.map(p => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Model</Label>
              <Input value={form.model ?? ""} onChange={e => setForm({ ...form, model: e.target.value })} placeholder="llama-3.3-70b-versatile" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">System Prompt</Label>
            <Textarea rows={5} value={form.system_prompt ?? ""} onChange={e => setForm({ ...form, system_prompt: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !form.label || (!initial && !form.key)} onClick={() => onSave(form)}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Skills tab ────────────────────────────────────────────────────────────────
function SkillsTab({ skills, types, reload, toast }: { skills: Skill[]; types: AgentType[]; reload: () => void; toast: any }) {
  const [filter, setFilter] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const grouped = types.map(t => ({ type: t, skills: skills.filter(s => s.agent_type_key === t.key) }))
    .filter(g => filter === "all" || g.type.key === filter);

  async function toggle(s: Skill) {
    await api(`/admin/mcp-agents/skills/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) });
    reload();
  }
  async function remove(s: Skill) {
    if (!confirm(`Remove skill "${s.label}"?`)) return;
    const r = await api(`/admin/mcp-agents/skills/${s.id}`, { method: "DELETE" });
    if (!r.ok) { toast({ title: (await r.json()).error, variant: "destructive" }); return; }
    reload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agent types</SelectItem>
            {types.map(t => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => setCreating(true)}><Plus className="w-3.5 h-3.5 mr-1.5" /> Add Skill</Button>
      </div>

      {grouped.map(g => (
        <div key={g.type.key} className="space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <AgentIcon name={g.type.icon} className="w-3.5 h-3.5 text-primary" /> {g.type.label}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {g.skills.map(s => (
              <Card key={s.id} className={cn("p-3 flex items-center justify-between gap-2", !s.enabled && "opacity-50")}>
                <div className="flex items-center gap-2 min-w-0">
                  <AgentIcon name={s.icon} className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate">{s.label}</span>
                      {s.handler_kind === "http_webhook" && <Badge variant="outline" className="text-[9px] px-1"><Webhook className="w-2.5 h-2.5 mr-0.5" />webhook</Badge>}
                      {!s.is_custom && <Badge variant="secondary" className="text-[9px] px-1.5">built-in</Badge>}
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">{s.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch checked={s.enabled} onCheckedChange={() => toggle(s)} />
                  {s.is_custom && <Button size="sm" variant="ghost" className="text-destructive h-7 w-7 p-0" onClick={() => remove(s)}><X className="w-3.5 h-3.5" /></Button>}
                </div>
              </Card>
            ))}
            {g.skills.length === 0 && <p className="text-xs text-muted-foreground italic px-1">No skills yet.</p>}
          </div>
        </div>
      ))}

      <SkillDialog open={creating} types={types} onClose={() => setCreating(false)} onSave={async (payload) => {
        const r = await api("/admin/mcp-agents/skills", { method: "POST", body: JSON.stringify(payload) });
        if (!r.ok) { toast({ title: (await r.json()).error, variant: "destructive" }); return; }
        toast({ title: "Skill added" });
        setCreating(false);
        reload();
      }} />
    </div>
  );
}

function SkillDialog({ open, types, onClose, onSave }: { open: boolean; types: AgentType[]; onClose: () => void; onSave: (p: any) => void }) {
  const [form, setForm] = useState<any>({});
  useEffect(() => {
    if (open) setForm({ key: "", agent_type_key: types[0]?.key ?? "", label: "", description: "", icon: "Webhook", handler_kind: "http_webhook", webhook_url: "" });
  }, [open, types]);

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New Skill</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">
          Custom skills call a webhook URL you host with <code className="text-[10px]">{"{ skill, input }"}</code> as the POST body — no redeploy needed.
        </p>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Agent type</Label>
            <Select value={form.agent_type_key ?? ""} onValueChange={v => setForm({ ...form, agent_type_key: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{types.map(t => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Key</Label>
              <Input value={form.key ?? ""} onChange={e => setForm({ ...form, key: e.target.value })} placeholder="send_slack_message" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Label</Label>
              <Input value={form.label ?? ""} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Send Slack Message" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description (shown to the model)</Label>
            <Input value={form.description ?? ""} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Webhook URL</Label>
            <Input value={form.webhook_url ?? ""} onChange={e => setForm({ ...form, webhook_url: e.target.value })} placeholder="https://example.com/hooks/skill" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!form.key || !form.label || !form.agent_type_key || !form.webhook_url}
            onClick={() => onSave({
              key: form.key, agent_type_key: form.agent_type_key, label: form.label,
              description: form.description, icon: "Webhook", handler_kind: "http_webhook",
              handler_config: JSON.stringify({ url: form.webhook_url }),
            })}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" /> Add Skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Providers / Router tab ───────────────────────────────────────────────────
function ProvidersTab({ providers, reload, toast }: { providers: Provider[]; reload: () => void; toast: any }) {
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<any>({ key: "", label: "", base_url: "", api_key_env: "" });

  async function toggle(p: Provider) {
    await api(`/admin/mcp-agents/providers/${p.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !p.enabled }) });
    reload();
  }
  async function remove(p: Provider) {
    if (!confirm(`Delete provider "${p.label}"?`)) return;
    const r = await api(`/admin/mcp-agents/providers/${p.id}`, { method: "DELETE" });
    if (!r.ok) { toast({ title: (await r.json()).error, variant: "destructive" }); return; }
    reload();
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Providers are the "router" — where model calls actually go. API key values themselves are managed on the{" "}
        <a href={`${BASE}/admin/security?tab=keys`} className="text-primary underline">Key Manager</a> page (round-robin per provider);
        this list just defines the provider key, base URL and which env var to fall back to.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {providers.map(p => (
          <Card key={p.id} className={cn("p-3 flex items-center justify-between gap-2", !p.enabled && "opacity-50")}>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium">{p.label}</span>
                {!p.is_custom && <Badge variant="secondary" className="text-[9px] px-1.5">built-in</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground font-mono truncate">{p.base_url}</p>
              <p className="text-[11px] text-muted-foreground">key env: <code>{p.api_key_env}</code></p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Switch checked={p.enabled} onCheckedChange={() => toggle(p)} />
              {p.is_custom && <Button size="sm" variant="ghost" className="text-destructive h-7 w-7 p-0" onClick={() => remove(p)}><Trash2 className="w-3.5 h-3.5" /></Button>}
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogTrigger asChild>
          <Button size="sm"><Plus className="w-3.5 h-3.5 mr-1.5" /> Add Provider</Button>
        </DialogTrigger>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Provider</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label className="text-xs">Key</Label><Input value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} placeholder="together" /></div>
              <div className="space-y-1"><Label className="text-xs">Label</Label><Input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Together AI" /></div>
            </div>
            <div className="space-y-1"><Label className="text-xs">Base URL (OpenAI-compatible)</Label><Input value={form.base_url} onChange={e => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.together.xyz/v1" /></div>
            <div className="space-y-1"><Label className="text-xs">API key env var (fallback)</Label><Input value={form.api_key_env} onChange={e => setForm({ ...form, api_key_env: e.target.value })} placeholder="TOGETHER_API_KEY" /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button disabled={!form.key || !form.label || !form.base_url || !form.api_key_env} onClick={async () => {
              const r = await api("/admin/mcp-agents/providers", { method: "POST", body: JSON.stringify(form) });
              if (!r.ok) { toast({ title: (await r.json()).error, variant: "destructive" }); return; }
              toast({ title: "Provider added" });
              setCreating(false); setForm({ key: "", label: "", base_url: "", api_key_env: "" });
              reload();
            }}><Save className="w-3.5 h-3.5 mr-1.5" /> Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Console tab ───────────────────────────────────────────────────────────────
function ConsoleTab({ types, toast }: { types: AgentType[]; toast: any }) {
  const [agentKey, setAgentKey] = useState(types[0]?.key ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ role: string; content: string; tool_calls?: any[] }[]>([]);

  useEffect(() => { if (!agentKey && types[0]) setAgentKey(types[0].key); }, [types, agentKey]);

  async function send() {
    if (!message.trim() || !agentKey) return;
    const userMsg = { role: "user", content: message };
    setLog(l => [...l, userMsg]);
    setMessage("");
    setBusy(true);
    try {
      const r = await api("/admin/mcp-agents/run", {
        method: "POST",
        body: JSON.stringify({ agent_type: agentKey, message: userMsg.content, session_id: "console" }),
      });
      const data = await r.json();
      if (!r.ok) { toast({ title: data.error, variant: "destructive" }); return; }
      setLog(l => [...l, { role: "assistant", content: data.content, tool_calls: data.tool_calls }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={agentKey} onValueChange={setAgentKey}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {types.filter(t => t.enabled).map(t => (
              <SelectItem key={t.key} value={t.key}>
                <span className="flex items-center gap-1.5"><AgentIcon name={t.icon} className="w-3.5 h-3.5" /> {t.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => setLog([])}><Trash2 className="w-3.5 h-3.5 mr-1" /> Clear</Button>
      </div>

      <Card className="p-3 min-h-[300px] max-h-[50vh] overflow-y-auto space-y-3">
        {log.length === 0 && <p className="text-xs text-muted-foreground italic">Send a message to test the selected agent type's live config (router, model, skills).</p>}
        {log.map((m, i) => (
          <div key={i} className={cn("text-sm rounded-lg p-2.5", m.role === "user" ? "bg-primary/10 ml-8" : "bg-muted/50 mr-8")}>
            <div className="whitespace-pre-wrap">{m.content || <span className="italic text-muted-foreground">(no text output)</span>}</div>
            {!!m.tool_calls?.length && (
              <div className="mt-2 space-y-1">
                {m.tool_calls.map((t: any, j: number) => (
                  <div key={j} className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
                    <Code2 className="w-3 h-3" /> {t.tool}({JSON.stringify(t.input)})
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running...</div>}
      </Card>

      <div className="flex gap-2">
        <Input value={message} onChange={e => setMessage(e.target.value)} placeholder="Ask the agent..." onKeyDown={e => e.key === "Enter" && send()} disabled={busy} />
        <Button onClick={send} disabled={busy || !message.trim()}><Send className="w-3.5 h-3.5" /></Button>
      </div>
    </div>
  );
}
