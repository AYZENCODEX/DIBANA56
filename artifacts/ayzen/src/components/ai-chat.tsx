import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  MessageCircle, X, Send, Loader2, Bot, ChevronDown, Database, ChevronUp, Settings2,
  Play, CheckCircle2, XCircle, Vault, ListTodo, DollarSign, KeyRound, FolderGit2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Path of the dedicated full-page Zynth assistant (see pages/user/assistant.tsx).
// Kept here rather than imported from route-config to avoid a circular
// import (route-config lazy-imports the page that renders this component).
const ASSISTANT_PAGE_PATH = "/assistant";

interface Message {
  role: "user" | "assistant";
  content: string;
  model?: string;
  action?: ParsedAction | null;
  actionResult?: { success: boolean; message: string } | null;
  executingAction?: boolean;
}

interface ParsedAction {
  type: "create_vault" | "complete_task" | "get_password" | "add_roi" | "create_project";
  params: Record<string, string>;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  endpoint: string;
  method: "GET" | "POST";
}

const MODELS = [
  { id: "llama-3.3-70b-versatile",                     name: "Llama 3.3 70B",    badge: "⚡ Recommended" },
  { id: "llama-3.1-8b-instant",                         name: "Llama 3.1 8B",     badge: "🚀 Ultra-Fast" },
  { id: "qwen-qwq-32b",                                 name: "Qwen QwQ 32B",     badge: "🧠 Reasoning" },
  { id: "deepseek-r1-distill-llama-70b",                name: "DeepSeek R1 70B",  badge: "🧠 Reasoning" },
  { id: "gemma2-9b-it",                                 name: "Gemma 2 9B",       badge: "✓ Stable" },
  { id: "meta-llama/llama-4-scout-17b-16e-instruct",   name: "Llama 4 Scout",    badge: "🆕 New" },
];

const QUICK_PROMPTS = [
  "Show my vault entities",
  "What projects am I in?",
  "Create a vault entry for Uniswap",
  "What's my ROI?",
];

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function parseActionBlock(content: string): ParsedAction | null {
  const match = content.match(/ACTION:\s*(\w+)([\s\S]*?)(?:$)/m);
  if (!match) return null;

  const actionType = match[1].trim().toLowerCase() as ParsedAction["type"];
  const lines = match[2].trim().split("\n");
  const params: Record<string, string> = {};
  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) params[key.trim().toLowerCase()] = rest.join(":").trim();
  }

  const actionConfigs: Record<string, Omit<ParsedAction, "type" | "params">> = {
    create_vault: {
      label: "Create Vault Entry",
      description: `Create vault for "${params.project || params.projectname || "project"}"`,
      icon: Vault,
      endpoint: "/api/ai/actions/create-vault",
      method: "POST",
    },
    complete_task: {
      label: "Complete Task",
      description: `Mark task #${params.task_id || params.taskid || "?"} as done`,
      icon: ListTodo,
      endpoint: "/api/ai/actions/complete-task",
      method: "POST",
    },
    get_password: {
      label: "Get Password",
      description: `Retrieve ${params.field || "credentials"} for "${params.project || "project"}"`,
      icon: KeyRound,
      endpoint: "/api/ai/actions/get-password",
      method: "GET",
    },
    add_roi: {
      label: "Add ROI",
      description: `Record $${params.amount || "?"} ROI`,
      icon: DollarSign,
      endpoint: "/api/ai/actions/add-roi",
      method: "POST",
    },
    create_project: {
      label: "Create Project",
      description: `Create project "${params.name || "?"}"`,
      icon: FolderGit2,
      endpoint: "/api/ai/actions/create-project",
      method: "POST",
    },
  };

  const config = actionConfigs[actionType];
  if (!config) return null;
  return { type: actionType, params, ...config };
}

function buildActionBody(action: ParsedAction): Record<string, unknown> {
  switch (action.type) {
    case "create_vault":
      return {
        projectName: action.params.project ?? action.params.projectname,
        category: action.params.category ?? "Wallet",
        email: action.params.email !== "skip" ? action.params.email : undefined,
        twitterUsername: action.params.twitter !== "skip" ? action.params.twitter : undefined,
        discordUsername: action.params.discord !== "skip" ? action.params.discord : undefined,
        telegramUsername: action.params.telegram !== "skip" ? action.params.telegram : undefined,
      };
    case "complete_task":
      return {
        taskId: action.params.task_id ?? action.params.taskid,
        notes: action.params.notes,
      };
    case "get_password":
      return {}; // GET with query params
    case "add_roi":
      return {
        amount: action.params.amount,
        projectId: action.params.project_id ?? action.params.projectid,
        notes: action.params.notes,
      };
    case "create_project":
      return {
        name: action.params.name,
        description: action.params.description,
        tier: action.params.tier ?? "1",
      };
    default:
      return {};
  }
}

function buildActionUrl(action: ParsedAction): string {
  if (action.type === "get_password") {
    const p = new URLSearchParams();
    if (action.params.project) p.set("projectName", action.params.project);
    if (action.params.field) p.set("field", action.params.field);
    return `${BASE}${action.endpoint}?${p.toString()}`;
  }
  return `${BASE}${action.endpoint}`;
}

// Strip the ACTION block from display text
function stripActionBlock(content: string): string {
  return content.replace(/ACTION:\s*\w+[\s\S]*$/m, "").trim();
}

interface AiChatProps {
  // When true, renders the panel docked to fill its parent container
  // instead of as a floating bottom-right widget — used by the dedicated
  // /assistant page (Zynth) so subdomain visitors land on a real page
  // rather than needing to discover the floating bubble. All chat/action
  // logic below is identical in both modes; only the outer chrome differs.
  standalone?: boolean;
}

export function AiChat({ standalone = false }: AiChatProps = {}) {
  const [location] = useLocation();
  const [open, setOpen] = useState(standalone);
  const [showSettings, setShowSettings] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  const executeAction = useCallback(async (msgIndex: number, action: ParsedAction) => {
    const token = localStorage.getItem("ayzen_token") ?? "";
    setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, executingAction: true } : m));

    try {
      const url = buildActionUrl(action);
      const body = buildActionBody(action);
      const res = await fetch(url, {
        method: action.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        ...(action.method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json();
      const success = res.ok && (data.success !== false);
      const message = data.message || (success ? "Action completed successfully!" : data.error || "Action failed.");

      setMessages(prev => prev.map((m, i) => i === msgIndex
        ? { ...m, executingAction: false, actionResult: { success, message } }
        : m
      ));
    } catch (err: any) {
      setMessages(prev => prev.map((m, i) => i === msgIndex
        ? { ...m, executingAction: false, actionResult: { success: false, message: `Error: ${err.message}` } }
        : m
      ));
    }
  }, []);

  const sendMessage = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    const userMsg: Message = { role: "user", content };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    setInput("");
    setLoading(true);

    try {
      const token = localStorage.getItem("ayzen_token") ?? "";
      const res = await fetch(`${BASE}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: newMsgs.map(m => ({ role: m.role, content: m.content })), model: selectedModel }),
      });
      const data = await res.json();
      const errText = typeof data.error === "string" ? data.error : (data.error?.message ?? null);
      const reply: string = data.choices?.[0]?.message?.content ?? errText ?? "No response from AI.";
      const model: string = data._model ?? selectedModel;
      const action = parseActionBlock(reply);

      setMessages(m => [...m, { role: "assistant", content: reply, model, action }]);
    } catch {
      setMessages(m => [...m, { role: "assistant", content: "Connection error. Please try again." }]);
    }
    setLoading(false);
  };

  const currentModel = MODELS.find(m => m.id === selectedModel);

  // The floating bubble would otherwise stack on top of the docked instance
  // the dedicated assistant page renders inline — hide the floating one
  // there. Placed after every hook call (not before) so hook call order
  // stays identical across renders of this same instance as location
  // changes — an early return above the hooks would violate that. The
  // docked instance (standalone=true) never hits this branch.
  if (!standalone && location === ASSISTANT_PAGE_PATH) return null;

  return (
    <div className={standalone ? "flex flex-col h-full w-full" : "fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3"}>
      {(standalone || open) && (
        <div
          className={cn(
            "bg-card border border-card-border rounded-xl flex flex-col overflow-hidden",
            standalone ? "w-full h-full" : "shadow-2xl w-80 md:w-96 animate-scale-in"
          )}
          style={standalone ? undefined : { height: "540px" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-card-border shrink-0 bg-card">
            <div className="flex items-center gap-2">
              <div className="relative">
                <div className="w-6 h-6 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center">
                  <Bot className="w-3.5 h-3.5 text-primary" />
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-emerald-400 rounded-full border border-card" />
              </div>
              <div>
                <span className="font-mono text-sm font-bold text-primary tracking-wider">AYZEN AI</span>
                <div className="flex items-center gap-1">
                  <Database className="w-2.5 h-2.5 text-muted-foreground/40" />
                  <span className="text-[9px] font-mono text-muted-foreground/50">DB-CONNECTED · CAN ACT</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowSettings(s => !s)}
                className={cn("p-1.5 rounded transition-colors", showSettings ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground")}
                title="Model settings"
              >
                <Settings2 className="w-3.5 h-3.5" />
              </button>
              {!standalone && (
                <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded">
                  <ChevronDown className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Model selector */}
          {showSettings && (
            <div className="shrink-0 border-b border-card-border bg-muted/20 px-3 py-2.5 animate-fade-up">
              <p className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest mb-2">Select Model — All Groq Free</p>
              <div className="grid grid-cols-2 gap-1">
                {MODELS.map(m => (
                  <button
                    key={m.id}
                    onClick={() => setSelectedModel(m.id)}
                    className={cn(
                      "text-left px-2 py-1.5 rounded border text-[10px] font-mono transition-all",
                      selectedModel === m.id
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                    )}
                  >
                    <div className="font-bold truncate">{m.name}</div>
                    <div className="text-muted-foreground/60 text-[9px]">{m.badge}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Active model pill */}
          {!showSettings && currentModel && (
            <div className="shrink-0 px-3 pt-2 pb-0.5">
              <button onClick={() => setShowSettings(true)} className="flex items-center gap-1.5 text-[9px] font-mono text-muted-foreground/50 hover:text-muted-foreground transition-colors">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                {currentModel.name}
                <ChevronUp className="w-2.5 h-2.5" />
              </button>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-4 py-4">
                <div className="relative">
                  <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center animate-glow-pulse">
                    <Bot className="w-6 h-6 text-primary" />
                  </div>
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-secondary/20 border border-secondary/30 flex items-center justify-center">
                    <Database className="w-2 h-2 text-secondary" />
                  </div>
                </div>
                <div className="text-xs font-mono text-muted-foreground text-center leading-relaxed">
                  Ask me anything — I can also<br /><span className="text-primary">create vault entries, complete tasks,</span><br />and get your passwords.
                </div>
                <div className="flex flex-col gap-1.5 w-full">
                  {QUICK_PROMPTS.map((q) => (
                    <button key={q} onClick={() => sendMessage(q)}
                      className="text-[10px] font-mono text-left px-2.5 py-2 rounded-lg border border-border hover:border-primary/40 hover:text-primary hover:bg-primary/5 text-muted-foreground transition-all">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn("flex gap-2 animate-fade-up", m.role === "user" ? "flex-row-reverse" : "flex-row")}>
                {m.role === "assistant" && (
                  <div className="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="w-3 h-3 text-primary" />
                  </div>
                )}
                <div className="max-w-[85%] flex flex-col gap-1">
                  <div className={cn(
                    "text-xs font-mono p-2.5 rounded-xl leading-relaxed whitespace-pre-wrap",
                    m.role === "user"
                      ? "bg-primary/15 text-foreground border border-primary/20 rounded-tr-sm"
                      : "bg-muted/60 text-foreground border border-border rounded-tl-sm"
                  )}>
                    {m.role === "assistant" && m.action ? stripActionBlock(m.content) : m.content}
                  </div>
                  {m.role === "assistant" && m.model && (
                    <span className="text-[9px] font-mono text-muted-foreground/30 ml-1">{m.model.split("/").pop()}</span>
                  )}

                  {/* Action Card */}
                  {m.role === "assistant" && m.action && !m.actionResult && (
                    <div className="border border-primary/30 bg-primary/5 rounded-lg p-2.5 space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <m.action.icon className="w-3 h-3 text-primary" />
                        <span className="font-mono text-[10px] font-bold text-primary uppercase">{m.action.label}</span>
                      </div>
                      <p className="font-mono text-[9px] text-muted-foreground">{m.action.description}</p>
                      <button
                        onClick={() => executeAction(i, m.action!)}
                        disabled={m.executingAction}
                        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-primary/20 hover:bg-primary/30 border border-primary/30 text-primary rounded text-[10px] font-mono uppercase transition-colors disabled:opacity-50"
                      >
                        {m.executingAction ? (
                          <><Loader2 className="w-2.5 h-2.5 animate-spin" /> Executing...</>
                        ) : (
                          <><Play className="w-2.5 h-2.5" /> Execute Action</>
                        )}
                      </button>
                    </div>
                  )}

                  {/* Action Result */}
                  {m.role === "assistant" && m.actionResult && (
                    <div className={cn(
                      "flex items-start gap-1.5 p-2 rounded-lg border text-[10px] font-mono",
                      m.actionResult.success
                        ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-400"
                        : "border-red-400/30 bg-red-400/5 text-red-400"
                    )}>
                      {m.actionResult.success
                        ? <CheckCircle2 className="w-3 h-3 flex-shrink-0 mt-0.5" />
                        : <XCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                      }
                      <span className="leading-relaxed">{m.actionResult.message}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex gap-2 animate-fade-up">
                <div className="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Bot className="w-3 h-3 text-primary" />
                </div>
                <div className="bg-muted/60 border border-border text-xs font-mono p-2.5 rounded-xl rounded-tl-sm flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin text-primary" />
                  <span className="text-muted-foreground">Thinking…</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-card-border shrink-0 flex gap-2 bg-card">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
              placeholder="Ask AYZEN AI… or request an action"
              className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-primary/60 transition-colors placeholder:text-muted-foreground"
              disabled={loading}
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="text-primary hover:text-primary/80 disabled:opacity-30 transition-colors p-2 hover:bg-primary/10 rounded-lg"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Toggle button — standalone mode has no collapsed state to toggle to */}
      {!standalone && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-[52px] h-[52px] bg-primary rounded-full flex items-center justify-center shadow-lg hover:bg-primary/90 transition-all hover:scale-105 active:scale-95 relative animate-glow-pulse"
        >
          {open ? (
            <X className="w-5 h-5 text-primary-foreground" />
          ) : (
            <>
              <MessageCircle className="w-5 h-5 text-primary-foreground" />
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-400 rounded-full border-2 border-background" />
            </>
          )}
        </button>
      )}
    </div>
  );
}
