import { useState, useEffect, useRef, useCallback } from "react";
import { useSearch, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Bot, Send, Settings, Cpu, Terminal, Database, Trash2,
  RefreshCw, ChevronDown, ChevronRight, Save, Zap,
  CheckCircle2, XCircle, Loader2, Code2, Server,
  ShieldCheck, Sparkles, Globe, Key, Users, Plus, Pencil,
  FileText, GitCommit, Layers, FolderTree, AlertTriangle, Puzzle,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const token = () => localStorage.getItem("ayzen_token") ?? "";
const api = (path: string, opts?: RequestInit) =>
  fetch(`${BASE}/api${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts?.headers ?? {}) } });

type Tab = "chat" | "agents" | "mcp" | "models" | "settings";
const TAB_IDS: Tab[] = ["chat", "agents", "mcp", "models", "settings"];

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  agent_name?: string;
  tool_calls?: { tool: string; input: any; output: string; agent?: string }[];
  created_at?: string;
}

interface AgentDef {
  id: number;
  name: string;
  role: string;
  description: string;
  router: string;
  model: string;
  system_prompt: string;
  enabled: boolean;
  sort_order: number;
}

interface ModelCatalogEntry {
  id: number;
  provider: string;
  model_id: string;
  label: string;
  ctx: number;
  is_custom: boolean;
  enabled: boolean;
}

const ROUTER_CONFIG = {
  groq:       { label: "Groq",         icon: Cpu,       color: "text-amber-400",   description: "LLaMA, Mixtral (ultra-fast)" },
  openrouter: { label: "OpenRouter",   icon: Globe,     color: "text-violet-400",  description: "100+ models via proxy" },
};

const MCP_SKILLS = [
  { key: "database",      label: "Database",       desc: "Execute SQL queries on the AYZEN database",              icon: Database,      color: "text-emerald-400" },
  { key: "shell",         label: "Shell",          desc: "Run raw shell commands on the server",                    icon: Terminal,      color: "text-amber-400" },
  { key: "console",       label: "Console Logs",   desc: "Query request metrics / performance logs",                icon: Server,        color: "text-primary" },
  { key: "error_logs",    label: "Error Logs",     desc: "Read persisted error_logs (stack traces, endpoints)",     icon: AlertTriangle, color: "text-red-400" },
  { key: "workflow_logs", label: "Workflow Logs",  desc: "Read live workflow / startup log-bus stream",             icon: Layers,        color: "text-sky-400" },
  { key: "files",         label: "File Read/Write", desc: "List, read, write and roll back repository files",      icon: FileText,      color: "text-fuchsia-400" },
  { key: "typecheck",     label: "Typecheck",      desc: "Run project-wide TypeScript typecheck",                   icon: ShieldCheck,   color: "text-cyan-400" },
  { key: "git",           label: "Git Commit",     desc: "Stage and commit verified changes",                       icon: GitCommit,     color: "text-orange-400" },
];

function ToolCallExpander({ calls }: { calls: { tool: string; input: any; output: string; agent?: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 border border-primary/20 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-2 px-3 py-2 bg-primary/5 hover:bg-primary/10 transition-colors">
        <Code2 className="w-3 h-3 text-primary/60" />
        <span className="font-mono text-[10px] text-primary/70 flex-1 text-left">{calls.length} tool call{calls.length > 1 ? "s" : ""} executed</span>
        {open ? <ChevronDown className="w-3 h-3 text-muted-foreground/40" /> : <ChevronRight className="w-3 h-3 text-muted-foreground/40" />}
      </button>
      {open && (
        <div className="divide-y divide-border/30">
          {calls.map((c, i) => (
            <div key={i} className="p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <Terminal className="w-3 h-3 text-amber-400" />
                <span className="font-mono text-[10px] font-bold text-amber-400">{c.tool}</span>
                {c.agent && <Badge variant="outline" className="font-mono text-[8px] border-violet-400/30 text-violet-400">{c.agent}</Badge>}
              </div>
              {c.input && <pre className="font-mono text-[9px] text-muted-foreground/70 bg-muted/20 rounded p-2 overflow-x-auto">{JSON.stringify(c.input, null, 2)}</pre>}
              {c.output && <pre className="font-mono text-[9px] text-emerald-400/80 bg-emerald-400/5 border border-emerald-400/10 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">{c.output.length > 1000 ? c.output.slice(0, 1000) + "\n...(truncated)" : c.output}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-[10px] font-mono font-bold",
        isUser ? "bg-primary/20 border border-primary/30 text-primary" : "bg-violet-500/20 border border-violet-400/30 text-violet-400"
      )}>
        {isUser ? "U" : <Bot className="w-3.5 h-3.5" />}
      </div>
      <div className={cn("flex-1 max-w-[85%]", isUser && "flex flex-col items-end")}>
        {msg.agent_name && (
          <Badge variant="outline" className="font-mono text-[8px] mb-1 border-violet-400/30 text-violet-400 bg-violet-400/5">{msg.agent_name}</Badge>
        )}
        <div className={cn("rounded-xl px-4 py-3 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words",
          isUser
            ? "bg-primary/15 border border-primary/20 text-foreground"
            : "bg-card border border-card-border text-foreground"
        )}>
          {msg.content || <span className="text-muted-foreground/40 italic">...</span>}
        </div>
        {msg.tool_calls && msg.tool_calls.length > 0 && (
          <div className={cn("w-full", isUser && "text-right")}>
            <ToolCallExpander calls={msg.tool_calls} />
          </div>
        )}
        {msg.created_at && (
          <div className="font-mono text-[9px] text-muted-foreground/30 mt-1 px-1">
            {new Date(msg.created_at).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminAiAgent() {
  const { toast } = useToast();
  const search = useSearch();
  const [, navigate] = useLocation();
  const urlTab = new URLSearchParams(search).get("tab") as Tab | null;
  const [tab, setTabState] = useState<Tab>(urlTab && TAB_IDS.includes(urlTab) ? urlTab : "chat");
  const setTab = (t: Tab) => { setTabState(t); navigate(t === "chat" ? "/admin/ai-agent" : `/admin/ai-agent?tab=${t}`, { replace: true }); };
  useEffect(() => {
    if (urlTab && TAB_IDS.includes(urlTab) && urlTab !== tab) setTabState(urlTab);
  }, [urlTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId] = useState(() => `dev-${Date.now()}`);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Settings state
  const [settings, setSettings] = useState({
    router: "groq",
    model: "llama-3.3-70b-versatile",
    system_prompt: "",
    temperature: 0.7,
    max_tokens: 4096,
    context_window: 32000,
    agent_mode: "single" as "single" | "cascade" | "multi_agent",
    tools_enabled: { database: true, shell: true, console: true, error_logs: true, workflow_logs: true, files: true, typecheck: true, git: false } as Record<string, boolean>,
    workflow: {},
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Models state
  const [models, setModels] = useState<Record<string, any[]>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [newModel, setNewModel] = useState({ provider: "groq", model_id: "", label: "", ctx: 32000 });

  // Agents roster state
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentDef | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const r = await api(`/admin/ai-agent/history?session_id=${sessionId}&limit=50`);
      const msgs = await r.json();
      if (Array.isArray(msgs) && msgs.length > 0) {
        setMessages(msgs.map((m: any) => ({
          id: String(m.id),
          role: m.role,
          content: m.content,
          agent_name: m.agent_name ?? undefined,
          tool_calls: m.tool_name ? [{ tool: m.tool_name, input: {}, output: m.tool_output ?? "" }] : undefined,
          created_at: m.created_at,
        })));
      }
    } catch {}
    setHistoryLoaded(true);
  }, [sessionId]);

  const loadSettings = useCallback(async () => {
    try {
      const r = await api("/admin/ai-agent/settings");
      const d = await r.json();
      setSettings(s => ({ ...s, ...d, tools_enabled: { ...s.tools_enabled, ...d.tools_enabled } }));
    } catch {}
  }, []);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const r = await api("/admin/ai-agent/models");
      setModels(await r.json());
    } catch {}
    setModelsLoading(false);
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const r = await api("/admin/ai-agent/model-catalog");
      setCatalog(await r.json());
    } catch {}
  }, []);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const r = await api("/admin/ai-agent/agents");
      setAgents(await r.json());
    } catch {}
    setAgentsLoading(false);
  }, []);

  useEffect(() => { loadHistory(); loadSettings(); }, [loadHistory, loadSettings]);
  useEffect(() => { if (tab === "models" && Object.keys(models).length === 0) { loadModels(); loadCatalog(); } }, [tab, models, loadModels, loadCatalog]);
  useEffect(() => { if (tab === "agents" && agents.length === 0) loadAgents(); }, [tab, agents, loadAgents]);
  useEffect(() => { setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100); }, [messages]);

  const send = async () => {
    if (!input.trim() || sending) return;
    const userMsg: Message = { id: Date.now().toString(), role: "user", content: input.trim() };
    const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setSending(true);

    const thinkingMsg: Message = { id: "thinking", role: "assistant", content: "" };
    setMessages(prev => [...prev, thinkingMsg]);
    try {
      const r = await api("/admin/ai-agent/chat", {
        method: "POST",
        body: JSON.stringify({ message: userMsg.content, session_id: sessionId, history }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMessages(prev => prev.filter(m => m.id !== "thinking"));
        toast({ variant: "destructive", title: d.error ?? "Agent error" });
      } else {
        const assistantMsg: Message = {
          id: Date.now().toString(),
          role: "assistant",
          content: d.content,
          tool_calls: d.tool_calls?.length ? d.tool_calls : undefined,
        };
        setMessages(prev => [...prev.filter(m => m.id !== "thinking"), assistantMsg]);
      }
    } catch (e: any) {
      setMessages(prev => prev.filter(m => m.id !== "thinking"));
      toast({ variant: "destructive", title: "Network error" });
    }
    setSending(false);
  };

  const clearHistory = async () => {
    await api(`/admin/ai-agent/history?session_id=${sessionId}`, { method: "DELETE" });
    setMessages([]);
    toast({ title: "History cleared" });
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const r = await api("/admin/ai-agent/settings", { method: "PUT", body: JSON.stringify(settings) });
      const d = await r.json();
      if (r.ok) toast({ title: "Settings saved" });
      else toast({ variant: "destructive", title: d.error });
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setSavingSettings(false);
  };

  const addModel = async () => {
    if (!newModel.model_id || !newModel.label) { toast({ variant: "destructive", title: "Model ID and label required" }); return; }
    try {
      const r = await api("/admin/ai-agent/model-catalog", { method: "POST", body: JSON.stringify(newModel) });
      if (r.ok) { toast({ title: "Model added" }); setNewModel({ provider: "groq", model_id: "", label: "", ctx: 32000 }); loadCatalog(); loadModels(); }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
  };

  const removeModel = async (id: number) => {
    await api(`/admin/ai-agent/model-catalog/${id}`, { method: "DELETE" });
    loadCatalog(); loadModels();
  };

  const renameModel = async (id: number, label: string) => {
    await api(`/admin/ai-agent/model-catalog/${id}`, { method: "PATCH", body: JSON.stringify({ label }) });
    loadCatalog(); loadModels();
  };

  const saveAgent = async (agent: AgentDef) => {
    await api(`/admin/ai-agent/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify(agent) });
    setEditingAgent(null);
    loadAgents();
    toast({ title: `${agent.name} updated` });
  };

  const toggleAgentEnabled = async (agent: AgentDef) => {
    await api(`/admin/ai-agent/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !agent.enabled }) });
    loadAgents();
  };

  const createAgent = async () => {
    const r = await api("/admin/ai-agent/agents", {
      method: "POST",
      body: JSON.stringify({ name: "New Agent", role: "custom", description: "Custom pipeline agent", system_prompt: "You are a custom agent in the AYZEN AI Agent pipeline.", sort_order: agents.length + 1 }),
    });
    if (r.ok) { loadAgents(); toast({ title: "Agent created" }); }
  };

  const deleteAgent = async (id: number) => {
    await api(`/admin/ai-agent/agents/${id}`, { method: "DELETE" });
    loadAgents();
  };

  const QUICK_PROMPTS = [
    "How many users are on the platform?",
    "Show me the latest 5 task submissions",
    "Show recent error logs and suggest a fix",
    "List all database tables",
    "Read artifacts/api-server/src/routes/tasks.ts and summarize it",
    "Run a typecheck across the project",
  ];

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col space-y-0 -m-6">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border/50 flex items-center justify-between flex-shrink-0 bg-background flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/20 border border-violet-400/30 flex items-center justify-center">
            <Bot className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-mono font-bold text-base tracking-tight uppercase">AYZEN AI Agent</h1>
              <Badge variant="outline" className="font-mono text-[9px] border-violet-400/30 text-violet-400 bg-violet-400/5">MCP</Badge>
              <Badge variant="outline" className="font-mono text-[9px] border-emerald-400/30 text-emerald-400 bg-emerald-400/5 uppercase">{settings.agent_mode}</Badge>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground/60">Autonomous developer-only agent · DB · Shell · Files · Logs</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { id: "chat", label: "Assistant", icon: Bot },
            { id: "agents", label: "Agent", icon: Users },
            { id: "mcp", label: "MCP Skill", icon: Puzzle },
            { id: "models", label: "AI Model", icon: Cpu },
            { id: "settings", label: "Settings", icon: Settings },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id as Tab)} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-[10px] uppercase tracking-wider transition-all border", tab === t.id ? "bg-violet-500/15 text-violet-400 border-violet-400/30" : "text-muted-foreground border-border/30 hover:border-border")}>
              <t.icon className="w-3 h-3" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── ASSISTANT (CHAT) TAB ── */}
      {tab === "chat" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-6 py-2 bg-muted/10 border-b border-border/30 flex items-center gap-3 flex-wrap">
            {MCP_SKILLS.map(t => (
              <div key={t.key} className={cn("flex items-center gap-1 text-[9px] font-mono", settings.tools_enabled[t.key] ? t.color : "text-muted-foreground/30 line-through")}>
                <t.icon className="w-2.5 h-2.5" />
                {t.label}
                {settings.tools_enabled[t.key] ? <CheckCircle2 className="w-2 h-2" /> : <XCircle className="w-2 h-2" />}
              </div>
            ))}
            <div className="ml-auto">
              <button onClick={clearHistory} className="font-mono text-[9px] text-muted-foreground/40 hover:text-red-400 flex items-center gap-1 transition-colors">
                <Trash2 className="w-2.5 h-2.5" /> Clear
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {!historyLoaded ? (
              <div className="space-y-4">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-12 gap-6">
                <div className="w-16 h-16 rounded-2xl bg-violet-500/10 border border-violet-400/20 flex items-center justify-center">
                  <Sparkles className="w-8 h-8 text-violet-400/60" />
                </div>
                <div className="text-center">
                  <div className="font-mono text-sm font-bold text-foreground mb-1">AYZEN AI Agent</div>
                  <div className="font-mono text-[11px] text-muted-foreground/60 max-w-sm">
                    {settings.agent_mode === "single"
                      ? "Single-agent chat with full database, shell, file, and log access."
                      : `Running in ${settings.agent_mode === "cascade" ? "cascade" : "multi-agent"} mode — your request is passed through the full agent pipeline (Planner → Architect → Coder → QA → DevOps).`}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 max-w-md w-full">
                  {QUICK_PROMPTS.map(p => (
                    <button key={p} onClick={() => setInput(p)} className="text-left px-3 py-2.5 bg-card border border-card-border hover:border-violet-400/30 rounded-lg font-mono text-[10px] text-muted-foreground hover:text-foreground transition-all">
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map(msg => <ChatBubble key={msg.id} msg={msg.id === "thinking" ? { ...msg, content: "" } : msg} />)
            )}
            {sending && messages[messages.length - 1]?.id === "thinking" && (
              <div className="flex gap-3">
                <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-400/30 flex items-center justify-center flex-shrink-0">
                  <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin" />
                </div>
                <div className="bg-card border border-card-border rounded-xl px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="px-6 py-4 border-t border-border/30 flex-shrink-0">
            <div className="flex gap-3 max-w-4xl mx-auto">
              <Input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Ask the agent to query, build, fix, or analyze... (Enter to send)"
                className="flex-1 font-mono text-sm bg-card border-card-border focus:border-violet-400/50"
                disabled={sending}
              />
              <Button onClick={send} disabled={sending || !input.trim()} className="bg-violet-600 hover:bg-violet-700 text-white border-0 gap-2 font-mono text-xs px-5">
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
            <div className="text-[9px] font-mono text-muted-foreground/30 text-center mt-2">
              Agent can execute SQL, shell, read/write files, typecheck, and git commit · All actions are logged
            </div>
          </div>
        </div>
      )}

      {/* ── AGENT TAB (multi-agent roster) ── */}
      {tab === "agents" && (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Agent Pipeline Roster</h2>
              <p className="font-mono text-[9px] text-muted-foreground/50 mt-1">Configure the 4–5 agents that run in sequence when Agent Mode is Cascade or Multi-Agent (Settings tab).</p>
            </div>
            <Button onClick={createAgent} size="sm" className="font-mono text-[10px] gap-1 bg-violet-600 hover:bg-violet-700 text-white border-0">
              <Plus className="w-3 h-3" /> Add Agent
            </Button>
          </div>

          {agentsLoading ? (
            <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
          ) : (
            <div className="space-y-3">
              {agents.map(agent => (
                <div key={agent.id} className={cn("rounded-xl border p-4", agent.enabled ? "bg-card border-card-border" : "bg-muted/10 border-border/30 opacity-60")}>
                  {editingAgent?.id === agent.id ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block font-mono text-[9px] text-muted-foreground/50 mb-1">Name</label>
                          <Input value={editingAgent.name} onChange={e => setEditingAgent({ ...editingAgent, name: e.target.value })} className="font-mono text-xs" />
                        </div>
                        <div>
                          <label className="block font-mono text-[9px] text-muted-foreground/50 mb-1">Role</label>
                          <Input value={editingAgent.role} onChange={e => setEditingAgent({ ...editingAgent, role: e.target.value })} className="font-mono text-xs" />
                        </div>
                      </div>
                      <div>
                        <label className="block font-mono text-[9px] text-muted-foreground/50 mb-1">Model</label>
                        <Input value={editingAgent.model} onChange={e => setEditingAgent({ ...editingAgent, model: e.target.value })} className="font-mono text-xs" />
                      </div>
                      <div>
                        <label className="block font-mono text-[9px] text-muted-foreground/50 mb-1">System Prompt (skill / fine-tuning instructions)</label>
                        <textarea value={editingAgent.system_prompt} onChange={e => setEditingAgent({ ...editingAgent, system_prompt: e.target.value })} rows={4} className="w-full bg-input border border-border rounded-lg font-mono text-[11px] p-2 resize-none" />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => saveAgent(editingAgent)} className="font-mono text-[10px] bg-violet-600 hover:bg-violet-700 text-white border-0">Save</Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingAgent(null)} className="font-mono text-[10px]">Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-400/25 flex items-center justify-center font-mono text-[10px] font-bold text-violet-400 flex-shrink-0">{agent.sort_order}</div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold">{agent.name}</span>
                            <Badge variant="outline" className="font-mono text-[8px] border-border/40 text-muted-foreground/60">{agent.role}</Badge>
                            <Badge variant="outline" className="font-mono text-[8px] border-border/40 text-muted-foreground/60">{agent.model}</Badge>
                          </div>
                          <p className="font-mono text-[10px] text-muted-foreground/60 mt-1">{agent.description}</p>
                          <p className="font-mono text-[9px] text-muted-foreground/35 mt-1 line-clamp-2">{agent.system_prompt}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button onClick={() => toggleAgentEnabled(agent)} className={cn("w-9 h-5 rounded-full transition-all relative", agent.enabled ? "bg-violet-500" : "bg-muted/50")}>
                          <span className={cn("absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all shadow-sm", agent.enabled ? "left-4.5" : "left-0.5")} />
                        </button>
                        <button onClick={() => setEditingAgent(agent)} className="text-muted-foreground/40 hover:text-violet-400"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => deleteAgent(agent.id)} className="text-muted-foreground/40 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {agents.length === 0 && <div className="font-mono text-xs text-muted-foreground/40 text-center py-8">No agents configured yet.</div>}
            </div>
          )}
        </div>
      )}

      {/* ── MCP SKILL TAB ── */}
      {tab === "mcp" && (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 max-w-2xl">
          <div>
            <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">MCP Skills</h2>
            <p className="font-mono text-[9px] text-muted-foreground/50 mt-1">Enable or disable which tool-call capabilities the agent(s) are allowed to use during a session.</p>
          </div>
          <div className="space-y-2">
            {MCP_SKILLS.map(t => (
              <div key={t.key} className="flex items-center justify-between p-3 bg-card border border-card-border rounded-xl">
                <div className="flex items-center gap-3">
                  <t.icon className={cn("w-4 h-4", settings.tools_enabled[t.key] ? t.color : "text-muted-foreground/30")} />
                  <div>
                    <div className="font-mono text-xs font-bold">{t.label}</div>
                    <div className="font-mono text-[9px] text-muted-foreground/50">{t.desc}</div>
                  </div>
                </div>
                <button
                  onClick={() => setSettings(s => ({ ...s, tools_enabled: { ...s.tools_enabled, [t.key]: !s.tools_enabled[t.key] } }))}
                  className={cn("w-10 h-5 rounded-full transition-all relative", settings.tools_enabled[t.key] ? "bg-violet-500" : "bg-muted/50")}
                >
                  <span className={cn("absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all shadow-sm", settings.tools_enabled[t.key] ? "left-5" : "left-0.5")} />
                </button>
              </div>
            ))}
          </div>
          {settings.tools_enabled.git && !settings.tools_enabled.typecheck && (
            <div className="flex items-center gap-2 p-3 bg-amber-500/5 border border-amber-400/20 rounded-xl">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <p className="font-mono text-[10px] text-amber-400/80">Git Commit is on but Typecheck is off — the DevOps agent won't be able to verify changes before committing. Enable Typecheck for the safe pipeline (generate → typecheck → fix → commit → rollback on failure).</p>
            </div>
          )}
          <Button onClick={saveSettings} disabled={savingSettings} className="w-full font-mono text-xs bg-violet-600 hover:bg-violet-700 text-white border-0 gap-2">
            <Save className="w-3.5 h-3.5" /> {savingSettings ? "Saving..." : "Save Skills"}
          </Button>
        </div>
      )}

      {/* ── AI MODEL TAB ── */}
      {tab === "models" && (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">AI Model Router</h2>
              <p className="font-mono text-[9px] text-muted-foreground/50 mt-1">Pick the active router + model for single-agent mode, and manage the model catalog (add / rename / remove).</p>
            </div>
            <button onClick={() => { loadModels(); loadCatalog(); }} disabled={modelsLoading} className="text-muted-foreground/40 hover:text-primary">
              <RefreshCw className={cn("w-4 h-4", modelsLoading && "animate-spin")} />
            </button>
          </div>

          {Object.entries(ROUTER_CONFIG).map(([routerKey, rCfg]) => (
            <div key={routerKey}>
              <div className="flex items-center gap-2 mb-3">
                <rCfg.icon className={cn("w-4 h-4", rCfg.color)} />
                <span className={cn("font-mono text-xs font-bold uppercase tracking-wider", rCfg.color)}>{rCfg.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground/50">— {rCfg.description}</span>
                {settings.router === routerKey && <Badge variant="outline" className={cn("font-mono text-[8px] ml-auto", rCfg.color, "border-current/30")}>ACTIVE</Badge>}
              </div>
              <div className="grid md:grid-cols-2 gap-2">
                {modelsLoading ? (
                  Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)
                ) : (models[routerKey] ?? []).map((m: any) => {
                  const isActive = settings.router === routerKey && settings.model === m.id;
                  return (
                    <div key={m.id} className={cn("p-3 rounded-xl border transition-all", isActive ? "bg-violet-500/10 border-violet-400/30" : "bg-card border-card-border hover:border-violet-400/20")}>
                      <button onClick={() => setSettings(s => ({ ...s, router: routerKey, model: m.id }))} className="w-full text-left">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono text-xs font-bold">{m.label}</span>
                          {isActive && <CheckCircle2 className="w-3.5 h-3.5 text-violet-400" />}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground/60">{m.id}</div>
                        <div className="font-mono text-[9px] text-muted-foreground/40 mt-0.5">ctx: {(m.ctx / 1000).toFixed(0)}K tokens {m.is_custom && "· custom"}</div>
                      </button>
                      {m.dbId && (
                        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-border/20">
                          <button onClick={() => { const label = prompt("New display name", m.label); if (label) renameModel(m.dbId, label); }} className="text-muted-foreground/40 hover:text-violet-400"><Pencil className="w-3 h-3" /></button>
                          {m.is_custom && <button onClick={() => removeModel(m.dbId)} className="text-muted-foreground/40 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="border border-dashed border-border/40 rounded-xl p-4 space-y-3">
            <div className="font-mono text-xs font-bold flex items-center gap-2"><Plus className="w-3.5 h-3.5 text-violet-400" /> Add Custom Model</div>
            <div className="grid md:grid-cols-4 gap-2">
              <select value={newModel.provider} onChange={e => setNewModel({ ...newModel, provider: e.target.value })} className="bg-input border border-border rounded-lg font-mono text-xs px-2 py-2">
                <option value="groq">Groq</option>
                <option value="openrouter">OpenRouter</option>
              </select>
              <Input placeholder="model id (e.g. llama-3.3-70b-versatile)" value={newModel.model_id} onChange={e => setNewModel({ ...newModel, model_id: e.target.value })} className="font-mono text-xs" />
              <Input placeholder="display name" value={newModel.label} onChange={e => setNewModel({ ...newModel, label: e.target.value })} className="font-mono text-xs" />
              <Input type="number" placeholder="context" value={newModel.ctx} onChange={e => setNewModel({ ...newModel, ctx: Number(e.target.value) })} className="font-mono text-xs" />
            </div>
            <Button size="sm" onClick={addModel} className="font-mono text-[10px] bg-violet-600 hover:bg-violet-700 text-white border-0">Add Model</Button>
          </div>

          <Button onClick={saveSettings} disabled={savingSettings} className="w-full font-mono text-xs bg-violet-600 hover:bg-violet-700 text-white border-0">
            {savingSettings ? "Saving..." : "Save Model Selection"}
          </Button>
        </div>
      )}

      {/* ── SETTINGS TAB ── */}
      {tab === "settings" && (
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6 max-w-2xl">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Agent Configuration</h2>

          {/* Agent Mode */}
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-3">Agent Mode</label>
            <div className="grid grid-cols-3 gap-3">
              {[
                { key: "single", label: "Single", icon: Bot, desc: "One agent handles chat + tools directly" },
                { key: "cascade", label: "Cascade", icon: FolderTree, desc: "Sequential pipeline: plan → build → verify" },
                { key: "multi_agent", label: "Multi-Agent", icon: Users, desc: "Full 4–5 agent roster collaborates" },
              ].map(m => (
                <button
                  key={m.key}
                  onClick={() => setSettings(s => ({ ...s, agent_mode: m.key as any }))}
                  className={cn("p-3 rounded-xl border transition-all text-left", settings.agent_mode === m.key ? "border-violet-400/40 bg-violet-500/5 text-violet-400" : "border-card-border bg-card hover:border-border text-foreground")}
                >
                  <m.icon className="w-4 h-4 mb-2" />
                  <div className="font-mono text-xs font-bold">{m.label}</div>
                  <div className="font-mono text-[9px] text-muted-foreground/50 mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Router selection */}
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-3">AI Router (single-agent mode)</label>
            <div className="grid grid-cols-3 gap-3">
              {Object.entries(ROUTER_CONFIG).map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => setSettings(s => ({ ...s, router: key }))}
                  className={cn("p-3 rounded-xl border transition-all text-left", settings.router === key ? cn("border-current/40", cfg.color, "bg-current/5") : "border-card-border bg-card hover:border-border")}
                >
                  <cfg.icon className={cn("w-4 h-4 mb-2", settings.router === key ? cfg.color : "text-muted-foreground/40")} />
                  <div className={cn("font-mono text-xs font-bold", settings.router === key ? cfg.color : "text-foreground")}>{cfg.label}</div>
                  <div className="font-mono text-[9px] text-muted-foreground/50 mt-0.5">{cfg.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Model */}
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-2">Model ID</label>
            <Input value={settings.model} onChange={e => setSettings(s => ({ ...s, model: e.target.value }))} placeholder="llama-3.3-70b-versatile" className="font-mono text-sm" />
            <p className="font-mono text-[9px] text-muted-foreground/40 mt-1">Manually enter any model ID from your router's catalogue</p>
          </div>

          {/* System prompt */}
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-2">System Prompt</label>
            <textarea
              value={settings.system_prompt}
              onChange={e => setSettings(s => ({ ...s, system_prompt: e.target.value }))}
              rows={5}
              className="w-full bg-input border border-border rounded-lg font-mono text-xs p-3 text-foreground resize-none focus:outline-none focus:border-violet-400/50"
              placeholder="You are AYZEN AI Agent..."
            />
          </div>

          {/* Temperature, tokens, context */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-2">Temperature ({settings.temperature})</label>
              <input type="range" min={0} max={2} step={0.1} value={settings.temperature} onChange={e => setSettings(s => ({ ...s, temperature: Number(e.target.value) }))} className="w-full" />
            </div>
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-2">Max Tokens</label>
              <Input type="number" value={settings.max_tokens} onChange={e => setSettings(s => ({ ...s, max_tokens: Number(e.target.value) }))} className="font-mono text-sm" />
            </div>
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-2">Context Window</label>
              <Input type="number" value={settings.context_window} onChange={e => setSettings(s => ({ ...s, context_window: Number(e.target.value) }))} className="font-mono text-sm" />
            </div>
          </div>

          <Button onClick={saveSettings} disabled={savingSettings} className="w-full font-mono text-xs bg-violet-600 hover:bg-violet-700 text-white border-0 gap-2">
            <Save className="w-3.5 h-3.5" />
            {savingSettings ? "Saving..." : "Save Configuration"}
          </Button>

          <div className="bg-muted/10 border border-border/30 rounded-xl p-4 space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 mb-2 flex items-center gap-2"><Key className="w-3 h-3" />API Keys Required</div>
            {[
              { key: "GROQ_API_KEY", router: "groq", label: "Groq" },
              { key: "OPENROUTER_API_KEY", router: "openrouter", label: "OpenRouter" },
            ].map(k => (
              <div key={k.key} className={cn("flex items-center justify-between font-mono text-[10px]", settings.router === k.router ? "text-foreground" : "text-muted-foreground/40")}>
                <span>{k.label}</span>
                <code className="bg-muted/20 px-2 py-0.5 rounded text-[9px]">{k.key}</code>
              </div>
            ))}
            <p className="font-mono text-[9px] text-muted-foreground/40 mt-2">Set via Environment Secrets in your Replit project settings.</p>
          </div>
        </div>
      )}
    </div>
  );
}
