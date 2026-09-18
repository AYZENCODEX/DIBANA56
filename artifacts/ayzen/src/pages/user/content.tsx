import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Wand2, Plus, Trash2, Copy, Check, Loader2,
  FileText, Hash, MessageSquare, BookOpen, ChevronDown,
  RefreshCw, Coins, Brain,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Project = { id: number; name: string; type?: string };
type GeneratedContent = { id: number; project_id: number; type: string; prompt_used?: string; output: string; created_at: string };
type Memory = { id: number; project_id: number; content_type: string; content: string; created_at: string };

const CONTENT_TYPES = [
  { value: "post", label: "Post", icon: FileText, desc: "Full social media post" },
  { value: "reply", label: "Reply", icon: MessageSquare, desc: "Quick reply/comment" },
  { value: "comment", label: "Comment", icon: Hash, desc: "Thread comment" },
];

const MEMORY_TYPES = [
  { value: "context", label: "Context", desc: "Project background & goals" },
  { value: "post", label: "Post Sample", desc: "Example posts to match" },
  { value: "hashtag", label: "Hashtags", desc: "Tags to include" },
  { value: "question", label: "Questions", desc: "Topics to discuss" },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <button onClick={copy} className={cn("p-1.5 rounded transition-colors", copied ? "text-emerald-400" : "text-muted-foreground/50 hover:text-primary")}>
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export default function ContentPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [contentType, setContentType] = useState("post");
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedContent[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [tab, setTab] = useState<"generate" | "history" | "memory">("generate");
  const [memDialog, setMemDialog] = useState(false);
  const [memType, setMemType] = useState("context");
  const [memContent, setMemContent] = useState("");
  const [savingMem, setSavingMem] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    customFetch<any>("/projects").then(data => {
      const list = Array.isArray(data) ? data : data?.projects ?? [];
      setProjects(list);
      if (list.length > 0) setSelectedProject(list[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    setLoadingHistory(true);
    Promise.all([
      customFetch<GeneratedContent[]>(`/content/generated/${selectedProject}`).catch(() => []),
      customFetch<Memory[]>(`/content/memory/${selectedProject}`).catch(() => []),
    ]).then(([hist, mem]) => {
      setGenerated(Array.isArray(hist) ? hist : []);
      setMemories(Array.isArray(mem) ? mem : []);
    }).finally(() => setLoadingHistory(false));
  }, [selectedProject]);

  const generate = async () => {
    if (!selectedProject) { toast({ title: "Select a project first", variant: "destructive" }); return; }
    setGenerating(true);
    try {
      const data = await customFetch<GeneratedContent>("/content/generate", {
        method: "POST",
        body: JSON.stringify({ projectId: selectedProject, type: contentType, prompt: prompt.trim() || undefined }),
      });
      setGenerated(prev => [data, ...prev]);
      setPrompt("");
      toast({ title: "Content generated!" });
    } catch (e: any) {
      toast({ title: e?.message ?? "Generation failed", variant: "destructive" });
    } finally { setGenerating(false); }
  };

  const saveMemory = async () => {
    if (!selectedProject || !memContent.trim()) return;
    setSavingMem(true);
    try {
      const data = await customFetch<Memory>(`/content/memory/${selectedProject}`, {
        method: "POST",
        body: JSON.stringify({ contentType: memType, content: memContent.trim() }),
      });
      setMemories(prev => [data, ...prev]);
      setMemContent("");
      setMemDialog(false);
      toast({ title: "Memory saved!" });
    } catch { toast({ title: "Failed to save memory", variant: "destructive" }); } finally { setSavingMem(false); }
  };

  const deleteMemory = async (id: number) => {
    try {
      await customFetch(`/content/memory/${id}`, { method: "DELETE" });
      setMemories(prev => prev.filter(m => m.id !== id));
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  };

  const selectedProjectObj = projects.find(p => p.id === selectedProject);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Wand2 className="w-5 h-5 text-primary" /> Content Generator</h1>
          <p className="text-sm text-muted-foreground mt-0.5">AI-powered social content for your Web3 farming projects.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-card/60 border border-border/40 rounded-lg px-3 py-2">
          <Coins className="w-3.5 h-3.5 text-yellow-400" />
          1 credit per generation
        </div>
      </div>

      {/* Project selector */}
      <div className="flex items-center gap-3">
        <label className="text-xs text-muted-foreground font-medium whitespace-nowrap">Project:</label>
        <Select value={String(selectedProject ?? "")} onValueChange={v => setSelectedProject(parseInt(v))}>
          <SelectTrigger className="h-9 text-sm bg-background/50 w-56">
            <SelectValue placeholder="Select project…" />
          </SelectTrigger>
          <SelectContent>
            {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {selectedProjectObj && <Badge variant="outline" className="text-[10px]">{selectedProjectObj.type ?? "airdrop"}</Badge>}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border/40">
        {(["generate", "history", "memory"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={cn("px-4 py-2.5 text-sm font-medium capitalize transition-all border-b-2 -mb-px",
              tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t === "generate" ? "Generate" : t === "history" ? "History" : "Project Memory"}
          </button>
        ))}
      </div>

      {tab === "generate" && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {CONTENT_TYPES.map(ct => (
              <button key={ct.value} onClick={() => setContentType(ct.value)}
                className={cn("flex items-center gap-2.5 p-3 rounded-lg border text-left transition-all",
                  contentType === ct.value ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/40 bg-card/40 text-muted-foreground hover:border-border/60")}>
                <ct.icon className={cn("w-4 h-4", contentType === ct.value ? "text-primary" : "")} />
                <div><div className="text-xs font-medium">{ct.label}</div><div className="text-[10px] text-muted-foreground/70">{ct.desc}</div></div>
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Optional prompt / context</label>
            <Textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder={`Write a ${contentType} about [topic]…\nLeave empty to auto-generate from project memory.`}
              className="min-h-[90px] text-sm bg-background/50 resize-none"
            />
          </div>

          <div className="bg-card/40 border border-border/40 rounded-lg p-3 text-xs text-muted-foreground flex items-start gap-2">
            <Brain className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0" />
            <span>
              {memories.length > 0
                ? `Using ${memories.length} memory item${memories.length !== 1 ? "s" : ""} from this project as context.`
                : "No memory set for this project yet. Add memory items to improve generation quality."}
            </span>
          </div>

          <Button onClick={generate} disabled={generating || !selectedProject} className="w-full h-10 gap-2">
            {generating ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</> : <><Wand2 className="w-4 h-4" /> Generate {contentType}</>}
          </Button>

          {/* Latest result */}
          {generated.length > 0 && (
            <div className="bg-card/60 border border-primary/20 rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-primary capitalize">{generated[0].type}</span>
                <CopyButton text={generated[0].output} />
              </div>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{generated[0].output}</p>
            </div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-3">
          {loadingHistory ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : generated.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">No generated content yet for this project.</div>
          ) : (
            generated.map(g => (
              <div key={g.id} className="bg-card/60 border border-border/40 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] capitalize">{g.type}</Badge>
                    <span className="text-[10px] text-muted-foreground">{new Date(g.created_at).toLocaleDateString()}</span>
                  </div>
                  <CopyButton text={g.output} />
                </div>
                {g.prompt_used && <p className="text-[11px] text-muted-foreground italic">Prompt: {g.prompt_used}</p>}
                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{g.output}</p>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "memory" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Context items that guide all generation calls for this project.</p>
            <Button size="sm" variant="outline" onClick={() => setMemDialog(true)} className="h-8 gap-1.5 text-xs"><Plus className="w-3.5 h-3.5" /> Add Memory</Button>
          </div>

          {loadingHistory ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : memories.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">No memory items. Add context to improve content quality.</div>
          ) : (
            memories.map(m => (
              <div key={m.id} className="bg-card/60 border border-border/40 rounded-lg p-3 flex gap-3">
                <Badge variant="outline" className="text-[10px] capitalize flex-shrink-0 h-5 mt-0.5">{m.content_type}</Badge>
                <p className="text-sm text-foreground flex-1 leading-relaxed">{m.content}</p>
                <button onClick={() => deleteMemory(m.id)} className="text-muted-foreground/40 hover:text-red-400 transition-colors flex-shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <Dialog open={memDialog} onOpenChange={setMemDialog}>
        <DialogContent className="sm:max-w-md bg-card border-border">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><BookOpen className="w-4 h-4 text-primary" /> Add Memory</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Type</label>
              <Select value={memType} onValueChange={setMemType}>
                <SelectTrigger className="h-9 text-sm bg-background/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_TYPES.map(mt => <SelectItem key={mt.value} value={mt.value}>{mt.label} — {mt.desc}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Content</label>
              <Textarea value={memContent} onChange={e => setMemContent(e.target.value)} placeholder="Enter context, sample posts, hashtags…" className="min-h-[80px] text-sm bg-background/50 resize-none" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMemDialog(false)}>Cancel</Button>
            <Button size="sm" onClick={saveMemory} disabled={savingMem || !memContent.trim()}>
              {savingMem ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
