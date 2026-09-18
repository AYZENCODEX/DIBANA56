import { useState, useEffect, useRef, useCallback } from "react";
import { useSearch, useLocation } from "wouter";
import { useGetTelemetryFunctions, useGetTelemetryErrors } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Terminal, Cpu, Zap, CheckCircle, Clock, Send, Bot, User, Radio, Trash2,
  PauseCircle, PlayCircle, Activity, Wifi, MemoryStick, RefreshCw,
  Play, CheckCircle2, XCircle, Loader2, Server, TerminalSquare, ArrowUp,
  AlertTriangle, Database, Table2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────
interface GroqModel { id: string; name: string; context: number; free: boolean; tier: string; speed: string; }
interface ChatMessage { role: "user" | "assistant"; content: string; model?: string; ts: number; }
interface LogEntry { time: number; level: "INFO" | "WARN" | "ERROR" | "DEBUG" | "SYSTEM"; msg: string; method?: string; url?: string; statusCode?: number; ms?: number; }

// ─── Style maps ────────────────────────────────────────────────────────────────
const TIER_STYLES: Record<string, string> = {
  recommended: "border-primary/40 text-primary bg-primary/5",
  stable: "border-emerald-400/40 text-emerald-400 bg-emerald-400/5",
  reasoning: "border-violet-400/40 text-violet-400 bg-violet-400/5",
  experimental: "border-amber-400/40 text-amber-400 bg-amber-400/5",
  safety: "border-sky-400/40 text-sky-400 bg-sky-400/5",
};
const SPEED_STYLES: Record<string, string> = { "ultra-fast": "text-primary", "fast": "text-emerald-400", "medium": "text-amber-400" };
const LOG_STYLES: Record<string, { text: string; badge: string; dot: string }> = {
  INFO:   { text: "text-emerald-400",  badge: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20",  dot: "bg-emerald-400" },
  WARN:   { text: "text-amber-400",    badge: "bg-amber-400/10 text-amber-400 border-amber-400/20",        dot: "bg-amber-400" },
  ERROR:  { text: "text-red-400",      badge: "bg-red-400/10 text-red-400 border-red-400/20",              dot: "bg-red-400" },
  DEBUG:  { text: "text-slate-400",    badge: "bg-slate-400/10 text-slate-400 border-slate-400/20",        dot: "bg-slate-400" },
  SYSTEM: { text: "text-primary",      badge: "bg-primary/10 text-primary border-primary/20",              dot: "bg-primary" },
};

// ─── AI Chat Tab ──────────────────────────────────────────────────────────────
function AiChatTab({ token }: { token: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("llama-3.3-70b-versatile");
  const [models, setModels] = useState<GroqModel[]>([]);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${BASE}/api/ai/models`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { setModels(Array.isArray(d) ? d : []); setAiReady(true); })
      .catch(() => setAiReady(false));
  }, [token]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const userMsg: ChatMessage = { role: "user", content: text, ts: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    try {
      const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));
      const res = await fetch(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages: history }),
      });
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? data.error ?? "No response from AI.";
      setMessages(prev => [...prev, { role: "assistant", content, model: data._model ?? model, ts: Date.now() }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: "assistant", content: `Error: ${err.message}`, ts: Date.now() }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[600px] border border-card-border rounded-xl bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-card-border bg-card/50 shrink-0">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" />
          <span className="font-mono font-bold text-sm text-foreground">AYZEN Admin AI</span>
          {aiReady === true && <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />ONLINE</span>}
          {aiReady === false && <span className="text-[10px] font-mono text-red-400 bg-red-400/10 border border-red-400/20 px-2 py-0.5 rounded">NO API KEY</span>}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="bg-background border border-card-border rounded px-2 py-1 text-[11px] font-mono text-foreground focus:outline-none focus:border-primary/50"
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button onClick={() => setMessages([])} className="p-1.5 text-muted-foreground hover:text-foreground border border-card-border rounded hover:bg-muted/30 transition-colors" title="Clear">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 font-mono text-sm scrollbar-thin">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <Bot className="w-10 h-10 text-primary/30" />
            <p className="text-sm">Ask anything about the platform.</p>
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {["How many users do we have?", "List all active projects", "What's total ROI distributed?", "Show recent vault entries"].map(q => (
                <button key={q} onClick={() => { setInput(q); }} className="px-3 py-1.5 border border-primary/20 text-primary text-xs rounded-full hover:bg-primary/10 transition-colors">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn("flex gap-3", m.role === "user" ? "flex-row-reverse" : "flex-row")}>
            <div className={cn("w-7 h-7 rounded-full flex items-center justify-center shrink-0 border",
              m.role === "user" ? "bg-primary/10 border-primary/30" : "bg-card border-card-border"
            )}>
              {m.role === "user" ? <User className="w-3.5 h-3.5 text-primary" /> : <Bot className="w-3.5 h-3.5 text-muted-foreground" />}
            </div>
            <div className={cn("max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed",
              m.role === "user" ? "bg-primary/10 border border-primary/20 text-foreground" : "bg-muted/30 border border-card-border text-foreground"
            )}>
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.model && <p className="text-[10px] text-muted-foreground/50 mt-2 uppercase">{m.model}</p>}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full flex items-center justify-center border bg-card border-card-border shrink-0">
              <Bot className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div className="bg-muted/30 border border-card-border rounded-xl px-4 py-3 flex items-center gap-1.5">
              {[0, 1, 2].map(i => (
                <span key={i} className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {aiReady === false ? (
        <div className="px-4 py-3 border-t border-card-border bg-muted/20 shrink-0">
          <p className="text-xs font-mono text-amber-400">⚠ AI requires <span className="text-primary">GROQ_API_KEY</span> or <span className="text-primary">OPENROUTER_API_KEY</span> in Replit Secrets.</p>
        </div>
      ) : (
        <form onSubmit={e => { e.preventDefault(); send(); }} className="flex gap-2 p-3 border-t border-card-border shrink-0">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask anything... (platform stats, users, projects, vault)"
            disabled={loading}
            className="flex-1 bg-background border border-card-border rounded-lg px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-4 py-2 bg-primary/10 border border-primary/30 text-primary rounded-lg hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-sm font-mono"
          >
            <Send className="w-3.5 h-3.5" />
            Send
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Live Console Tab ─────────────────────────────────────────────────────────
function LiveConsoleTab({ token }: { token: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<string>("ALL");
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const pendingRef = useRef<LogEntry[]>([]);

  pausedRef.current = paused;

  const flush = useCallback(() => {
    if (pendingRef.current.length === 0) return;
    const batch = pendingRef.current.splice(0);
    setLogs(prev => [...prev.slice(-800), ...batch]);
  }, []);

  useEffect(() => {
    const interval = setInterval(flush, 200);
    return () => clearInterval(interval);
  }, [flush]);

  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, paused]);

  useEffect(() => {
    const token = localStorage.getItem("ayzen_token") ?? "";
    const es = new EventSource(`${BASE}/api/admin/logs/stream?token=${encodeURIComponent(token)}`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // auto-reconnect after 5s
      setTimeout(() => {
        if (esRef.current) { esRef.current.close(); esRef.current = null; }
      }, 5000);
    };

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "history") {
          setLogs(data.entries ?? []);
        } else if (data.type === "entry") {
          if (!pausedRef.current) {
            pendingRef.current.push(data.entry);
          }
        }
      } catch {}
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  const filtered = filter === "ALL" ? logs : logs.filter(l => l.level === filter);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-mono",
            connected ? "bg-emerald-400/10 border-emerald-400/20 text-emerald-400" : "bg-red-400/10 border-red-400/20 text-red-400"
          )}>
            <Radio className={cn("w-3 h-3", connected && "animate-pulse")} />
            {connected ? "LIVE" : "DISCONNECTED"}
          </div>
          <span className="text-[11px] font-mono text-muted-foreground">{filtered.length} entries</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center border border-card-border rounded overflow-hidden">
            {["ALL", "SYSTEM", "INFO", "WARN", "ERROR"].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn("px-2.5 py-1 text-[10px] font-mono uppercase transition-colors",
                  filter === f ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-muted/30"
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <button onClick={() => setPaused(p => !p)} className={cn("flex items-center gap-1.5 px-2.5 py-1 border rounded text-[11px] font-mono transition-colors",
            paused ? "border-amber-400/30 text-amber-400 hover:bg-amber-400/10" : "border-card-border text-muted-foreground hover:bg-muted/30"
          )}>
            {paused ? <PlayCircle className="w-3 h-3" /> : <PauseCircle className="w-3 h-3" />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button onClick={() => setLogs([])} className="flex items-center gap-1.5 px-2.5 py-1 border border-card-border text-muted-foreground rounded text-[11px] font-mono hover:bg-muted/30 transition-colors">
            <Trash2 className="w-3 h-3" /> Clear
          </button>
        </div>
      </div>

      {/* Console output */}
      <div className="border border-card-border rounded-xl bg-[#0a0a0f] overflow-hidden">
        <div className="h-[500px] overflow-y-auto p-3 font-mono text-xs space-y-0.5 scrollbar-thin" id="log-scroller">
          {filtered.length === 0 && (
            <div className="flex items-center justify-center h-full text-muted-foreground/40 gap-2">
              <Terminal className="w-5 h-5" />
              <span>Waiting for log entries...</span>
            </div>
          )}
          {filtered.map((entry, i) => {
            const style = LOG_STYLES[entry.level] ?? LOG_STYLES.INFO;
            const ts = new Date(entry.time).toISOString().slice(11, 23);
            return (
              <div key={i} className="flex items-start gap-2 py-0.5 hover:bg-white/[0.02] rounded px-1 group">
                <span className="text-muted-foreground/40 shrink-0 tabular-nums">{ts}</span>
                <span className={cn("shrink-0 px-1.5 py-0 rounded border text-[9px] uppercase font-bold tracking-widest", style.badge)}>
                  {entry.level}
                </span>
                <span className={cn("flex-1 break-all", style.text)}>{entry.msg}</span>
                {entry.ms !== undefined && (
                  <span className="text-muted-foreground/30 shrink-0 tabular-nums">{entry.ms}ms</span>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

// ─── Shell Tab (real command execution) ───────────────────────────────────────
interface ShellEntry {
  id: number; command: string; stdout: string; stderr: string;
  exitCode: number; error: string | null; timedOut: boolean; durationMs: number; ts: number;
}

function ShellTab({ token }: { token: string }) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<ShellEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  const run = async () => {
    const command = input.trim();
    if (!command || running) return;
    setRunning(true);
    setCmdHistory(prev => [...prev, command]);
    setHistIdx(null);
    setInput("");
    try {
      const res = await fetch(`${BASE}/api/admin/shell/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      idRef.current += 1;
      if (!res.ok) {
        setHistory(prev => [...prev, {
          id: idRef.current, command, stdout: "", stderr: data.error || "Request failed",
          exitCode: 1, error: data.error || "Request failed", timedOut: false, durationMs: 0, ts: Date.now(),
        }]);
      } else {
        setHistory(prev => [...prev, { id: idRef.current, ts: Date.now(), ...data }]);
      }
    } catch (e: any) {
      idRef.current += 1;
      setHistory(prev => [...prev, {
        id: idRef.current, command, stdout: "", stderr: e?.message ?? "Network error",
        exitCode: 1, error: e?.message ?? "Network error", timedOut: false, durationMs: 0, ts: Date.now(),
      }]);
    } finally {
      setRunning(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); run(); }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (cmdHistory.length === 0) return;
      const next = histIdx === null ? cmdHistory.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(cmdHistory[next] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx === null) return;
      const next = histIdx + 1;
      if (next >= cmdHistory.length) { setHistIdx(null); setInput(""); }
      else { setHistIdx(next); setInput(cmdHistory[next] ?? ""); }
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-[10px] font-mono text-amber-300 leading-relaxed">
          This runs real shell commands directly on the server with full filesystem access. Every command is
          logged to the Activity Log for audit. Use with caution — there is no sandboxing.
        </p>
      </div>

      <div className="border border-card-border rounded-xl bg-[#0a0a0f] overflow-hidden">
        <div className="h-[480px] overflow-y-auto p-3 font-mono text-xs space-y-3 scrollbar-thin">
          {history.length === 0 && (
            <div className="flex items-center justify-center h-full text-muted-foreground/40 gap-2">
              <TerminalSquare className="w-5 h-5" />
              <span>No commands executed yet. Type a command below.</span>
            </div>
          )}
          {history.map(entry => (
            <div key={entry.id} className="space-y-1">
              <div className="flex items-center gap-2 text-primary">
                <span className="text-muted-foreground/50">$</span>
                <span className="break-all">{entry.command}</span>
                <span className="ml-auto text-[9px] text-muted-foreground/40 shrink-0">
                  {entry.exitCode === 0 ? "exit 0" : `exit ${entry.exitCode}`} · {entry.durationMs}ms
                </span>
              </div>
              {entry.stdout && (
                <pre className="whitespace-pre-wrap break-all text-muted-foreground/90 pl-4">{entry.stdout}</pre>
              )}
              {entry.stderr && (
                <pre className="whitespace-pre-wrap break-all text-red-400/80 pl-4">{entry.stderr}</pre>
              )}
              {entry.timedOut && (
                <div className="pl-4 text-amber-400 text-[10px]">⚠ command timed out</div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="border-t border-card-border flex items-center gap-2 px-3 py-2 bg-card/40">
          <span className="text-primary font-mono text-xs">$</span>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={running}
            placeholder="ls -la, pnpm run build, git status..."
            className="flex-1 bg-transparent outline-none font-mono text-xs text-foreground placeholder:text-muted-foreground/40"
          />
          <button
            onClick={run}
            disabled={running || !input.trim()}
            className="flex items-center gap-1.5 px-2.5 py-1 border border-primary/30 text-primary rounded text-[11px] font-mono hover:bg-primary/10 transition-colors disabled:opacity-40"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />}
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Real-time Telemetry Tab ──────────────────────────────────────────────────
interface TelemetrySnapshot {
  ts: number; connections: number; requestsPerMin: number; totalRequests: number;
  avgResponseMs: number; p95ResponseMs: number; memRss: number; memHeap: number;
  memHeapTotal: number; uptimeSec: number; nodeVersion: string; platform: string;
  projectPresence: Record<number, number>;
}

function TelemetryLiveTab({ token }: { token: string }) {
  const [snap, setSnap] = useState<TelemetrySnapshot | null>(null);
  const [history, setHistory] = useState<{ t: number; req: number; ms: number; mem: number }[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource(`${BASE}/api/admin/telemetry/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const d: TelemetrySnapshot = JSON.parse(e.data);
        setSnap(d);
        setHistory(h => [...h.slice(-60), { t: d.ts, req: d.requestsPerMin, ms: d.avgResponseMs, mem: d.memHeap }]);
      } catch {}
    };
    return () => { es.close(); setConnected(false); };
  }, [token]);

  const fmt = (sec: number) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const sparkline = (vals: number[], color: string) => {
    if (vals.length < 2) return null;
    const max = Math.max(...vals, 1);
    const W = 120, H = 32;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - (v / max) * H}`).join(" ");
    return (
      <svg width={W} height={H} className="opacity-70">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  };

  const cards = snap ? [
    { label: "Active Connections", value: snap.connections, sub: "SSE clients", icon: Wifi, color: "text-emerald-400", spark: history.map(h => h.req) },
    { label: "Req / Min", value: snap.requestsPerMin, sub: `avg ${snap.avgResponseMs}ms`, icon: Activity, color: "text-primary", spark: history.map(h => h.ms) },
    { label: "Heap Used", value: `${snap.memHeap}MB`, sub: `of ${snap.memHeapTotal}MB`, icon: MemoryStick, color: "text-violet-400", spark: history.map(h => h.mem) },
    { label: "Uptime", value: fmt(snap.uptimeSec), sub: snap.platform, icon: Server, color: "text-amber-400", spark: [] },
  ] : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-mono",
          connected ? "bg-emerald-400/10 border-emerald-400/20 text-emerald-400" : "bg-red-400/10 border-red-400/20 text-red-400"
        )}>
          <Activity className={cn("w-3 h-3", connected && "animate-pulse")} />
          {connected ? "STREAMING" : "DISCONNECTED"}
        </div>
        {snap && <span className="font-mono text-[10px] text-muted-foreground">Node {snap.nodeVersion} · Updated {new Date(snap.ts).toLocaleTimeString()}</span>}
      </div>

      {!snap ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1,2,3,4].map(i => <div key={i} className="bg-card border border-card-border rounded-xl h-28 animate-pulse" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {cards.map(c => (
              <div key={c.label} className="bg-card border border-card-border rounded-xl px-4 py-4 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <c.icon className={cn("w-3.5 h-3.5", c.color)} />
                    <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{c.label}</span>
                  </div>
                  {c.spark.length > 1 && sparkline(c.spark, c.color.replace("text-", "#").replace("emerald-400","34d399").replace("primary","00ffff").replace("violet-400","a78bfa").replace("amber-400","fbbf24"))}
                </div>
                <div className={cn("font-mono text-2xl font-bold", c.color)}>{c.value}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{c.sub}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-card border border-card-border rounded-xl px-4 py-4">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-3">Response Time</div>
              <div className="space-y-2">
                {[
                  { label: "Avg", value: snap.avgResponseMs, max: 500, color: snap.avgResponseMs < 100 ? "bg-emerald-400" : snap.avgResponseMs < 300 ? "bg-amber-400" : "bg-red-400" },
                  { label: "P95", value: snap.p95ResponseMs, max: 500, color: snap.p95ResponseMs < 200 ? "bg-emerald-400" : snap.p95ResponseMs < 500 ? "bg-amber-400" : "bg-red-400" },
                ].map(m => (
                  <div key={m.label} className="space-y-1">
                    <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
                      <span>{m.label}</span><span>{m.value}ms</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={cn("h-full rounded-full transition-all", m.color)} style={{ width: `${Math.min((m.value / m.max) * 100, 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-card border border-card-border rounded-xl px-4 py-4">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-3">Memory</div>
              <div className="space-y-2">
                {[
                  { label: "Heap", value: snap.memHeap, total: snap.memHeapTotal },
                  { label: "RSS", value: snap.memRss, total: 512 },
                ].map(m => (
                  <div key={m.label} className="space-y-1">
                    <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
                      <span>{m.label}</span><span>{m.value}MB / {m.total}MB</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-violet-400 rounded-full transition-all" style={{ width: `${Math.min((m.value / m.total) * 100, 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {Object.keys(snap.projectPresence).length > 0 && (
            <div className="bg-card border border-card-border rounded-xl px-4 py-4">
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-3">Project Presence</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(snap.projectPresence).map(([pid, count]) => (
                  <div key={pid} className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-400/10 border border-emerald-400/20 rounded text-[10px] font-mono text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Project #{pid} · {count} online
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Ping Test Tab ────────────────────────────────────────────────────────────
const PING_ENDPOINTS = [
  { label: "Health", method: "GET", path: "/api/health" },
  { label: "Auth Status", method: "GET", path: "/api/auth/me" },
  { label: "Projects List", method: "GET", path: "/api/projects?limit=1" },
  { label: "Tasks List", method: "GET", path: "/api/tasks?limit=1" },
  { label: "Users List", method: "GET", path: "/api/users?limit=1" },
  { label: "Vault List", method: "GET", path: "/api/vault?limit=1" },
  { label: "Wallets List", method: "GET", path: "/api/wallets" },
  { label: "Broadcasts", method: "GET", path: "/api/broadcast" },
  { label: "Leaderboard", method: "GET", path: "/api/leaderboard" },
  { label: "AI Models", method: "GET", path: "/api/ai/models" },
  { label: "Credits Balance", method: "GET", path: "/api/credits/balance" },
  { label: "Subscriptions", method: "GET", path: "/api/subscriptions/current" },
  { label: "SSE Events", method: "GET", path: "/api/events" },
  { label: "Telemetry Stream", method: "GET", path: "/api/admin/telemetry/stream" },
  { label: "Plugins", method: "GET", path: "/api/plugins" },
  { label: "Referrals", method: "GET", path: "/api/referrals" },
];

type PingStatus = "idle" | "running" | "ok" | "warn" | "error";
interface PingResult { ms: number; status: number; statusText: string; state: PingStatus; }

function PingTab({ token }: { token: string }) {
  const [results, setResults] = useState<Record<string, PingResult>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const pingOne = useCallback(async (ep: typeof PING_ENDPOINTS[0]): Promise<PingResult> => {
    const t0 = performance.now();
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${BASE}${ep.path}`, {
        method: ep.method,
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      const ms = Math.round(performance.now() - t0);
      const state: PingStatus = ms < 200 ? "ok" : ms < 800 ? "warn" : "error";
      return { ms, status: res.status, statusText: res.statusText, state: res.status >= 500 ? "error" : state };
    } catch (e: any) {
      const ms = Math.round(performance.now() - t0);
      if (e?.name === "AbortError") return { ms: 5000, status: 0, statusText: "Timeout", state: "error" };
      return { ms, status: 0, statusText: e?.message ?? "Failed", state: "error" };
    }
  }, [token]);

  const runAll = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    setResults({});
    for (let i = 0; i < PING_ENDPOINTS.length; i++) {
      const ep = PING_ENDPOINTS[i];
      setResults(r => ({ ...r, [ep.path]: { ms: 0, status: 0, statusText: "", state: "running" } }));
      const result = await pingOne(ep);
      setResults(r => ({ ...r, [ep.path]: result }));
      setProgress(Math.round(((i + 1) / PING_ENDPOINTS.length) * 100));
    }
    setRunning(false);
  }, [pingOne]);

  const summary = Object.values(results);
  const okCount = summary.filter(r => r.state === "ok").length;
  const warnCount = summary.filter(r => r.state === "warn").length;
  const errCount = summary.filter(r => r.state === "error").length;
  const avgMs = summary.length > 0 ? Math.round(summary.filter(r => r.ms > 0).reduce((a, b) => a + b.ms, 0) / summary.filter(r => r.ms > 0).length) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          {summary.length > 0 && (
            <>
              <div className="flex items-center gap-1 font-mono text-[10px] text-emerald-400"><CheckCircle2 className="w-3 h-3" />{okCount} OK</div>
              <div className="flex items-center gap-1 font-mono text-[10px] text-amber-400"><Activity className="w-3 h-3" />{warnCount} Slow</div>
              <div className="flex items-center gap-1 font-mono text-[10px] text-red-400"><XCircle className="w-3 h-3" />{errCount} Error</div>
              {avgMs > 0 && <div className="font-mono text-[10px] text-muted-foreground">avg {avgMs}ms</div>}
            </>
          )}
        </div>
        <Button onClick={runAll} disabled={running} size="sm" className="font-mono text-xs gap-2">
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? `Running… ${progress}%` : "Run All Pings"}
        </Button>
      </div>

      {running && (
        <div className="h-1 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary transition-all rounded-full" style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className="border border-card-border rounded-xl bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-card-border hover:bg-transparent">
              <TableHead className="font-mono uppercase text-[10px]">Endpoint</TableHead>
              <TableHead className="font-mono uppercase text-[10px]">Path</TableHead>
              <TableHead className="font-mono uppercase text-[10px] text-right">Status</TableHead>
              <TableHead className="font-mono uppercase text-[10px] text-right">Latency</TableHead>
              <TableHead className="font-mono uppercase text-[10px] text-right">Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PING_ENDPOINTS.map(ep => {
              const r = results[ep.path];
              return (
                <TableRow key={ep.path} className="border-card-border hover:bg-muted/30">
                  <TableCell className="font-mono text-sm font-medium">{ep.label}</TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">{ep.method} {ep.path}</TableCell>
                  <TableCell className="text-right">
                    {r && r.state !== "running" && (
                      <span className={cn("font-mono text-[11px]", r.status >= 200 && r.status < 400 ? "text-emerald-400" : r.status === 0 ? "text-red-400" : "text-amber-400")}>
                        {r.status || r.statusText}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {r && (
                      <span className={cn("font-mono text-[11px]",
                        r.state === "running" ? "text-muted-foreground animate-pulse" :
                        r.state === "ok" ? "text-emerald-400" : r.state === "warn" ? "text-amber-400" : "text-red-400"
                      )}>
                        {r.state === "running" ? "…" : `${r.ms}ms`}
                      </span>
                    )}
                    {!r && <span className="font-mono text-[10px] text-muted-foreground/30">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {!r && <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20 inline-block" />}
                    {r?.state === "running" && <Loader2 className="w-3 h-3 text-primary animate-spin ml-auto" />}
                    {r?.state === "ok" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 ml-auto" />}
                    {r?.state === "warn" && <Activity className="w-3.5 h-3.5 text-amber-400 ml-auto" />}
                    {r?.state === "error" && <XCircle className="w-3.5 h-3.5 text-red-400 ml-auto" />}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Accurate Function Registry (real registered API routes) ─────────────────
const REGISTERED_ROUTES: { method: string; route: string; name: string; domain: string }[] = [
  { method: "POST", route: "/api/auth/register",            name: "registerUser",              domain: "auth" },
  { method: "POST", route: "/api/auth/login",               name: "loginUser",                 domain: "auth" },
  { method: "POST", route: "/api/auth/magic-link",          name: "sendMagicLink",             domain: "auth" },
  { method: "POST", route: "/api/auth/magic-link/verify",   name: "verifyMagicLink",           domain: "auth" },
  { method: "POST", route: "/api/auth/verify-otp",          name: "verifyOtp",                 domain: "auth" },
  { method: "POST", route: "/api/auth/change-password",     name: "changePassword",            domain: "auth" },
  { method: "POST", route: "/api/auth/firebase",            name: "firebaseAuth",              domain: "auth" },
  { method: "GET",  route: "/api/users",                    name: "listUsers",                 domain: "users" },
  { method: "GET",  route: "/api/users/:id",                name: "getUser",                   domain: "users" },
  { method: "PATCH",route: "/api/users/:id",                name: "updateUser",                domain: "users" },
  { method: "DELETE",route: "/api/users/:id",               name: "deleteUser",                domain: "users" },
  { method: "GET",  route: "/api/users/me",                 name: "getCurrentUser",            domain: "users" },
  { method: "PATCH",route: "/api/users/me",                 name: "updateCurrentUser",         domain: "users" },
  { method: "GET",  route: "/api/projects",                 name: "listProjects",              domain: "projects" },
  { method: "POST", route: "/api/projects",                 name: "createProject",             domain: "projects" },
  { method: "GET",  route: "/api/projects/:id",             name: "getProject",                domain: "projects" },
  { method: "PATCH",route: "/api/projects/:id",             name: "updateProject",             domain: "projects" },
  { method: "DELETE",route: "/api/projects/:id",            name: "deleteProject",             domain: "projects" },
  { method: "POST", route: "/api/projects/:id/enroll",      name: "enrollEntity",              domain: "projects" },
  { method: "GET",  route: "/api/projects/:id/enrollments", name: "listEnrollments",           domain: "projects" },
  { method: "DELETE",route: "/api/projects/:id/enrollments/:eid", name: "removeEnrollment",    domain: "projects" },
  { method: "GET",  route: "/api/projects/:id/entity-tasks",name: "getEntityTasks",            domain: "projects" },
  { method: "GET",  route: "/api/tasks",                    name: "listTasks",                 domain: "tasks" },
  { method: "POST", route: "/api/tasks",                    name: "createTask",                domain: "tasks" },
  { method: "GET",  route: "/api/tasks/submissions",        name: "listSubmissions",           domain: "tasks" },
  { method: "GET",  route: "/api/tasks/:id",                name: "getTask",                   domain: "tasks" },
  { method: "PATCH",route: "/api/tasks/:id",                name: "updateTask",                domain: "tasks" },
  { method: "DELETE",route: "/api/tasks/:id",               name: "deleteTask",                domain: "tasks" },
  { method: "POST", route: "/api/tasks/:id/submit",         name: "submitTask",                domain: "tasks" },
  { method: "PATCH",route: "/api/tasks/submissions/:id",    name: "reviewSubmission",          domain: "tasks" },
  { method: "GET",  route: "/api/vault",                    name: "listVaultEntries",          domain: "vault" },
  { method: "POST", route: "/api/vault",                    name: "createVaultEntry",          domain: "vault" },
  { method: "GET",  route: "/api/vault/:id",                name: "getVaultEntry",             domain: "vault" },
  { method: "PATCH",route: "/api/vault/:id",                name: "updateVaultEntry",          domain: "vault" },
  { method: "DELETE",route: "/api/vault/:id",               name: "deleteVaultEntry",          domain: "vault" },
  { method: "GET",  route: "/api/wallets",                  name: "listWallets",               domain: "wallets" },
  { method: "POST", route: "/api/wallets",                  name: "createWallet",              domain: "wallets" },
  { method: "GET",  route: "/api/wallets/:id",              name: "getWallet",                 domain: "wallets" },
  { method: "PATCH",route: "/api/wallets/:id",              name: "updateWallet",              domain: "wallets" },
  { method: "DELETE",route: "/api/wallets/:id",             name: "deleteWallet",              domain: "wallets" },
  { method: "GET",  route: "/api/email-accounts",           name: "listEmailAccounts",         domain: "email" },
  { method: "POST", route: "/api/email-accounts",           name: "createEmailAccount",        domain: "email" },
  { method: "GET",  route: "/api/email-accounts/:id",       name: "getEmailAccount",           domain: "email" },
  { method: "PATCH",route: "/api/email-accounts/:id",       name: "updateEmailAccount",        domain: "email" },
  { method: "DELETE",route: "/api/email-accounts/:id",      name: "deleteEmailAccount",        domain: "email" },
  { method: "GET",  route: "/api/email-accounts/ayzen",     name: "getAyzenEmail",             domain: "email" },
  { method: "GET",  route: "/api/messages",                 name: "listMessages",              domain: "messages" },
  { method: "POST", route: "/api/messages",                 name: "createMessage",             domain: "messages" },
  { method: "GET",  route: "/api/messages/:id",             name: "getMessage",                domain: "messages" },
  { method: "DELETE",route: "/api/messages/:id",            name: "deleteMessage",             domain: "messages" },
  { method: "POST", route: "/api/messages/broadcast",       name: "broadcastMessage",          domain: "messages" },
  { method: "GET",  route: "/api/tools/gas",                name: "getGasPrices",              domain: "tools" },
  { method: "GET",  route: "/api/tools/gas/:network",       name: "getGasNetwork",             domain: "tools" },
  { method: "POST", route: "/api/tools/wallet-analysis",    name: "analyzeWallet",             domain: "tools" },
  { method: "GET",  route: "/api/tools/streak/:userId",     name: "getUserStreak",             domain: "tools" },
  { method: "POST", route: "/api/tools/spam-score",         name: "getSpamScore",              domain: "tools" },
  { method: "GET",  route: "/api/telemetry/functions",      name: "getTelemetryFunctions",     domain: "telemetry" },
  { method: "GET",  route: "/api/telemetry/errors",         name: "getTelemetryErrors",        domain: "telemetry" },
  { method: "GET",  route: "/api/telemetry/live",           name: "getTelemetryLive",          domain: "telemetry" },
  { method: "GET",  route: "/api/leaderboard",              name: "getLeaderboard",            domain: "leaderboard" },
  { method: "GET",  route: "/api/referrals",                name: "listReferrals",             domain: "referrals" },
  { method: "GET",  route: "/api/settings",                 name: "getSettings",               domain: "settings" },
  { method: "PATCH",route: "/api/settings",                 name: "updateSettings",            domain: "settings" },
  { method: "GET",  route: "/api/ai/models",                name: "listAiModels",              domain: "ai" },
  { method: "POST", route: "/api/ai/chat",                  name: "aiChat",                    domain: "ai" },
  { method: "GET",  route: "/api/ai/actions",               name: "listAiActions",             domain: "ai" },
  { method: "POST", route: "/api/ai/actions/:id",           name: "executeAiAction",           domain: "ai" },
];

const METHOD_COLORS: Record<string, string> = {
  GET:    "bg-emerald-400/10 text-emerald-400 border-emerald-400/20",
  POST:   "bg-blue-400/10 text-blue-400 border-blue-400/20",
  PATCH:  "bg-amber-400/10 text-amber-400 border-amber-400/20",
  DELETE: "bg-red-400/10 text-red-400 border-red-400/20",
  PUT:    "bg-violet-400/10 text-violet-400 border-violet-400/20",
};
const DOMAIN_COLORS: Record<string, string> = {
  auth: "text-cyan-400", users: "text-blue-400", projects: "text-violet-400",
  tasks: "text-amber-400", vault: "text-emerald-400", wallets: "text-purple-400",
  email: "text-pink-400", messages: "text-indigo-400", tools: "text-orange-400",
  telemetry: "text-rose-400", leaderboard: "text-yellow-400", referrals: "text-teal-400",
  settings: "text-slate-400", ai: "text-fuchsia-400",
};

function FunctionRegistryTab({ token: _token }: { token: string }) {
  const [filterDomain, setFilterDomain] = useState("all");
  const [filterMethod, setFilterMethod] = useState("all");
  const domains = ["all", ...Array.from(new Set(REGISTERED_ROUTES.map(r => r.domain)))];
  const methods = ["all", "GET", "POST", "PATCH", "DELETE"];
  const filtered = REGISTERED_ROUTES.filter(r =>
    (filterDomain === "all" || r.domain === filterDomain) &&
    (filterMethod === "all" || r.method === filterMethod)
  );

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Routes", value: REGISTERED_ROUTES.length, color: "text-primary" },
          { label: "GET", value: REGISTERED_ROUTES.filter(r => r.method === "GET").length, color: "text-emerald-400" },
          { label: "POST / PATCH", value: REGISTERED_ROUTES.filter(r => r.method === "POST" || r.method === "PATCH").length, color: "text-blue-400" },
          { label: "Domains", value: new Set(REGISTERED_ROUTES.map(r => r.domain)).size, color: "text-violet-400" },
        ].map(s => (
          <div key={s.label} className="glass-card border rounded-xl p-4">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">{s.label}</div>
            <div className={cn("text-2xl font-mono font-bold", s.color)}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">Domain:</span>
        {domains.map(d => (
          <button
            key={d}
            onClick={() => setFilterDomain(d)}
            className={cn(
              "px-2 py-0.5 rounded border font-mono text-[10px] uppercase transition-colors",
              filterDomain === d
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-card-border text-muted-foreground hover:border-primary/30"
            )}
          >{d}</button>
        ))}
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest ml-2">Method:</span>
        {methods.map(m => (
          <button
            key={m}
            onClick={() => setFilterMethod(m)}
            className={cn(
              "px-2 py-0.5 rounded border font-mono text-[10px] uppercase transition-colors",
              filterMethod === m
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-card-border text-muted-foreground hover:border-primary/30"
            )}
          >{m}</button>
        ))}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{filtered.length} routes</span>
      </div>

      <div className="border border-card-border rounded-md bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-card-border hover:bg-transparent">
              <TableHead className="font-mono uppercase text-xs w-16">Method</TableHead>
              <TableHead className="font-mono uppercase text-xs">Function</TableHead>
              <TableHead className="font-mono uppercase text-xs">Route</TableHead>
              <TableHead className="font-mono uppercase text-xs w-24">Domain</TableHead>
              <TableHead className="font-mono uppercase text-xs w-16 text-center">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((fn, i) => (
              <TableRow key={i} className="border-card-border hover:bg-muted/30">
                <TableCell>
                  <span className={cn("px-1.5 py-0.5 rounded border text-[9px] font-mono font-bold", METHOD_COLORS[fn.method] ?? "")}>
                    {fn.method}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs font-bold text-foreground">{fn.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{fn.route}</TableCell>
                <TableCell>
                  <span className={cn("font-mono text-[10px] font-bold", DOMAIN_COLORS[fn.domain] ?? "text-muted-foreground")}>
                    {fn.domain}
                  </span>
                </TableCell>
                <TableCell className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span className="font-mono text-[9px] text-emerald-400">wired</span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Database Tab ──────────────────────────────────────────────────────────────
function DatabaseTab({ token }: { token: string }) {
  const [query, setQuery] = useState("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;");
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const QUICK = [
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    "SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 10",
    "SELECT id, name, status, created_at FROM projects ORDER BY created_at DESC LIMIT 10",
    "SELECT COUNT(*) as cnt, status FROM task_submissions GROUP BY status",
    "SELECT id, username, azn_balance FROM credits c JOIN users u ON u.id=c.user_id ORDER BY azn_balance DESC LIMIT 10",
    "SELECT route, method, status_code, duration_ms, recorded_at FROM request_metrics ORDER BY recorded_at DESC LIMIT 20",
  ];

  const run = async () => {
    if (!query.trim()) return;
    setRunning(true); setError(null); setResult(null);
    try {
      const r = await fetch(`${BASE}/api/admin/ai-agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: `Execute this SQL query and return the raw JSON results only, no explanation: \`\`\`sql\n${query}\n\`\`\``, session_id: `db-tab-${Date.now()}`, history: [] }),
      });
      // Fall back to direct shell-based SQL execution
      const r2 = await fetch(`${BASE}/api/admin/shell/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ command: `echo "${query.replace(/"/g, '\\"').replace(/\n/g, " ")}" | psql "$DATABASE_URL" --csv -t 2>&1 | head -200` }),
      });
      if (r2.ok) {
        const d2 = await r2.json();
        setResult({ raw: d2.output ?? d2.stdout ?? d2.result ?? "", type: "csv" });
        setHistory(h => [query, ...h.filter(x => x !== query)].slice(0, 10));
      } else {
        setError("Query failed. Check SQL syntax.");
      }
    } catch (e: any) { setError(e.message); }
    setRunning(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-emerald-400" />
        <span className="font-mono text-sm font-bold uppercase tracking-wider text-emerald-400">Database Explorer</span>
        <span className="font-mono text-[10px] text-muted-foreground/50 ml-auto">Read-only query interface</span>
      </div>

      {/* Quick queries */}
      <div className="flex gap-1.5 flex-wrap">
        {QUICK.map((q, i) => (
          <button key={i} onClick={() => setQuery(q)} className="px-2 py-1 bg-muted/20 hover:bg-muted/40 border border-border/30 rounded font-mono text-[9px] text-muted-foreground hover:text-foreground transition-all truncate max-w-48">
            {q.split(" ").slice(0, 4).join(" ")}...
          </button>
        ))}
      </div>

      {/* Query editor */}
      <div className="border border-emerald-400/20 rounded-xl overflow-hidden">
        <div className="bg-emerald-400/5 border-b border-emerald-400/20 px-4 py-2 flex items-center gap-2">
          <Terminal className="w-3 h-3 text-emerald-400/60" />
          <span className="font-mono text-[10px] text-emerald-400/70 uppercase tracking-wider">SQL Query</span>
        </div>
        <textarea
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(); }}
          rows={5}
          className="w-full bg-[#0a0a0a] font-mono text-sm p-4 text-emerald-400 resize-none focus:outline-none border-0"
          spellCheck={false}
          placeholder="SELECT * FROM users LIMIT 10;"
        />
        <div className="bg-muted/10 border-t border-border/30 px-4 py-2 flex items-center justify-between">
          <span className="font-mono text-[9px] text-muted-foreground/40">Ctrl+Enter to run</span>
          <button onClick={run} disabled={running} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-black rounded font-mono text-[10px] font-bold transition-all disabled:opacity-50">
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            {running ? "Running..." : "Execute"}
          </button>
        </div>
      </div>

      {/* Results */}
      {error && (
        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 font-mono text-xs text-red-400">{error}</div>
      )}
      {result && (
        <div className="border border-card-border rounded-xl overflow-hidden">
          <div className="bg-muted/10 border-b border-border/30 px-4 py-2 flex items-center gap-2">
            <Table2 className="w-3 h-3 text-primary" />
            <span className="font-mono text-[10px] text-primary uppercase tracking-wider">Results</span>
          </div>
          <pre className="font-mono text-[10px] text-emerald-400/80 p-4 overflow-auto max-h-96 bg-[#050505]">{result.raw}</pre>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Query History</div>
          <div className="space-y-1">
            {history.map((h, i) => (
              <button key={i} onClick={() => setQuery(h)} className="w-full text-left px-3 py-2 bg-card border border-card-border rounded font-mono text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/20 transition-all truncate">
                {h}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
const DEV_SIDEBAR = [
  { id: "console",   label: "Live Console",  icon: Terminal },
  { id: "shell",     label: "Shell",         icon: TerminalSquare },
  { id: "db",        label: "Database",      icon: Database },
  { id: "telemetry", label: "Telemetry",     icon: Activity },
  { id: "ping",      label: "Ping Test",     icon: RefreshCw },
  { id: "functions", label: "Functions",     icon: Server },
  { id: "errors",    label: "Error Log",     icon: XCircle },
  { id: "models",    label: "AI Models",     icon: Cpu },
  { id: "ai",        label: "AI Chat",       icon: Bot },
] as const;

type DevSection = typeof DEV_SIDEBAR[number]["id"];

export default function AdminDeveloper() {
  const { data: errors, isLoading: errLoading } = useGetTelemetryErrors({ limit: 50 });
  const [models, setModels] = useState<GroqModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [activeModel, setActiveModel] = useState("llama-3.3-70b-versatile");
  const search = useSearch();
  const [, navigate] = useLocation();
  const urlTab = new URLSearchParams(search).get("tab") as DevSection | null;
  const [section, setSectionState] = useState<DevSection>(
    urlTab && DEV_SIDEBAR.some(s => s.id === urlTab) ? urlTab : "ai"
  );
  const setSection = (id: DevSection) => {
    setSectionState(id);
    navigate(`/admin/developer?tab=${id}`, { replace: true });
  };
  useEffect(() => {
    if (urlTab && DEV_SIDEBAR.some(s => s.id === urlTab) && urlTab !== section) {
      setSectionState(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [testLoading, setTestLoading] = useState<Record<string, boolean>>({});
  const token = localStorage.getItem("ayzen_token") ?? "";

  useEffect(() => {
    fetch(`${BASE}/api/ai/models`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { setModels(Array.isArray(d) ? d : []); })
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, []);

  const testModel = async (modelId: string) => {
    setActiveModel(modelId);
    setTestLoading(prev => ({ ...prev, [modelId]: true }));
    try {
      const res = await fetch(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Reply with exactly: PONG" }] }),
      });
      const data = await res.json();
      const reply = String(data.choices?.[0]?.message?.content ?? data.error ?? "No response");
      setTestResults(prev => ({ ...prev, [modelId]: reply.slice(0, 250) }));
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [modelId]: `Error: ${e?.message}` }));
    } finally {
      setTestLoading(prev => ({ ...prev, [modelId]: false }));
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
          <Terminal className="h-6 w-6 text-primary" /> Developer Console
        </h1>
        <p className="text-muted-foreground font-mono text-sm">AI assistant, live logs, telemetry, and model registry</p>
      </div>

      <div className="flex flex-col md:flex-row border border-card-border rounded-xl overflow-hidden min-h-[640px] bg-card">
        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <nav className="flex w-40 md:w-48 shrink-0 border-r border-card-border bg-card/60 flex-col py-2">
          {DEV_SIDEBAR.map(item => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={cn(
                "flex items-center gap-2.5 px-4 py-3 text-xs font-mono font-medium transition-all text-left border-r-2",
                section === item.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {item.label}
            </button>
          ))}
        </nav>

        {/* ── Content Area ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-auto p-3 md:p-5 min-w-0">

          {section === "ai" && <AiChatTab token={token} />}

          {section === "console" && <LiveConsoleTab token={token} />}

          {section === "telemetry" && <TelemetryLiveTab token={token} />}

          {section === "ping" && <PingTab token={token} />}

          {section === "functions" && <FunctionRegistryTab token={token} />}

          {section === "shell" && <ShellTab token={token} />}

          {section === "db" && <DatabaseTab token={token} />}

          {section === "errors" && (
            <div className="border border-card-border rounded-md bg-card/50">
              <Table>
                <TableHeader>
                  <TableRow className="border-card-border hover:bg-transparent">
                    <TableHead className="font-mono uppercase text-xs">Level</TableHead>
                    <TableHead className="font-mono uppercase text-xs">Message</TableHead>
                    <TableHead className="font-mono uppercase text-xs">Endpoint</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {errLoading ? (
                    <TableRow><TableCell colSpan={3} className="text-center py-4"><Skeleton className="h-4 w-32 mx-auto" /></TableCell></TableRow>
                  ) : !errors || errors.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="text-center py-8 font-mono text-muted-foreground text-sm">System clear — no errors logged.</TableCell></TableRow>
                  ) : (
                    errors.map((err) => (
                      <TableRow key={err.id} className="border-card-border">
                        <TableCell><Badge variant="destructive" className="font-mono text-[10px] uppercase rounded-sm">{err.level}</Badge></TableCell>
                        <TableCell className="font-mono text-xs">{err.message}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{err.endpoint}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          {section === "models" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Total Models", value: models.length, icon: Cpu, color: "text-primary" },
                  { label: "Free Tier", value: models.filter(m => m.free).length, icon: CheckCircle, color: "text-emerald-400" },
                  { label: "Reasoning", value: models.filter(m => m.tier === "reasoning").length, icon: Zap, color: "text-violet-400" },
                  { label: "Max Context", value: models.length ? `${(Math.max(...models.map(m => m.context)) / 1000).toFixed(0)}K` : "—", icon: Clock, color: "text-amber-400" },
                ].map(s => (
                  <div key={s.label} className="glass-card border rounded-xl p-4">
                    <div className={cn("flex items-center gap-1.5 mb-2", s.color)}>
                      <s.icon className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{s.label}</span>
                    </div>
                    <p className={cn("text-2xl font-mono font-bold", s.color)}>{s.value}</p>
                  </div>
                ))}
              </div>

              <div className="border border-card-border rounded-xl bg-card overflow-hidden">
                <div className="px-4 py-3 border-b border-card-border bg-card/50 flex items-center justify-between">
                  <div>
                    <p className="font-mono text-sm font-bold text-foreground">AI Model Registry</p>
                    <p className="text-[11px] font-mono text-muted-foreground mt-0.5">Test each model inline — results appear below the row</p>
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-400/10 border border-emerald-400/20 rounded-lg">
                    <CheckCircle className="w-3 h-3 text-emerald-400" />
                    <span className="text-[10px] font-mono text-emerald-400">All FREE</span>
                  </div>
                </div>
                {modelsLoading ? (
                  <div className="p-6 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-card-border hover:bg-transparent">
                        <TableHead className="font-mono uppercase text-[10px]">Model</TableHead>
                        <TableHead className="font-mono uppercase text-[10px]">Tier</TableHead>
                        <TableHead className="font-mono uppercase text-[10px]">Speed</TableHead>
                        <TableHead className="font-mono uppercase text-[10px] text-right">Context</TableHead>
                        <TableHead className="font-mono uppercase text-[10px] text-right">Test</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {models.map((m) => (
                        <>
                          <TableRow key={m.id} className={cn("border-card-border hover:bg-muted/30 transition-colors", activeModel === m.id && "bg-primary/5")}>
                            <TableCell>
                              <p className="font-mono text-sm font-bold text-foreground">{m.name}</p>
                              <p className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">{m.id}</p>
                            </TableCell>
                            <TableCell>
                              <span className={cn("px-2 py-0.5 rounded border text-[10px] font-mono uppercase", TIER_STYLES[m.tier] ?? TIER_STYLES.stable)}>{m.tier}</span>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Zap className={cn("w-3 h-3", SPEED_STYLES[m.speed] ?? "text-muted-foreground")} />
                                <span className={cn("font-mono text-[11px]", SPEED_STYLES[m.speed] ?? "text-muted-foreground")}>{m.speed}</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm text-muted-foreground">{(m.context / 1000).toFixed(0)}K</TableCell>
                            <TableCell className="text-right">
                              <button
                                onClick={() => testModel(m.id)}
                                disabled={testLoading[m.id]}
                                className="px-2.5 py-1 border border-primary/30 text-primary rounded text-[10px] font-mono hover:bg-primary/10 transition-colors disabled:opacity-50 flex items-center gap-1 ml-auto"
                              >
                                {testLoading[m.id] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                                Test
                              </button>
                            </TableCell>
                          </TableRow>
                          {testResults[m.id] && (
                            <TableRow className="border-card-border bg-emerald-400/5">
                              <TableCell colSpan={5} className="py-2 px-4">
                                <div className="flex items-start gap-2">
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                                  <p className="font-mono text-xs text-emerald-300 break-all">{testResults[m.id]}</p>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              <div className="glass-card border rounded-xl p-4">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2">Integration Notes</p>
                <div className="space-y-1.5 text-xs font-mono text-muted-foreground">
                  <p>• Set <span className="text-primary">GROQ_API_KEY</span> in Secrets to activate Groq (free at <span className="text-primary">console.groq.com</span>)</p>
                  <p>• Fallback: <span className="text-secondary">OPENROUTER_API_KEY</span> → OpenRouter free tier</p>
                  <p>• Admin gets platform-wide context; users get their own vault &amp; task data</p>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
