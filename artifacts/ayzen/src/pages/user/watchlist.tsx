import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import {
  Bookmark, BookmarkX, Loader2, FolderOpen, ExternalLink,
  CheckSquare, Zap, ChevronRight, Star,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface WatchProject {
  watchlist_id: number;
  added_at: string;
  id: number;
  name: string;
  description?: string;
  status: string;
  project_type?: string;
  chain?: string;
  xp_name?: string;
  logo_url?: string;
  task_count: number;
  is_joined: number;
}

const STATUS_COLORS: Record<string, string> = {
  active:    "text-emerald-400 border-emerald-400/30 bg-emerald-400/5",
  inactive:  "text-muted-foreground border-border/30",
  completed: "text-violet-400 border-violet-400/30 bg-violet-400/5",
  upcoming:  "text-amber-400 border-amber-400/30 bg-amber-400/5",
};

export default function WatchlistPage() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [items, setItems] = useState<WatchProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/watchlist`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setItems(await r.json());
    } catch { }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const remove = async (projectId: number) => {
    setRemoving(prev => new Set(prev).add(projectId));
    try {
      await fetch(`${BASE}/api/watchlist/${projectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      setItems(prev => prev.filter(p => p.id !== projectId));
      toast({ title: "Removed from watchlist" });
    } catch { toast({ title: "Error", variant: "destructive" }); }
    setRemoving(prev => { const s = new Set(prev); s.delete(projectId); return s; });
  };

  if (loading) return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </div>
  );

  return (
    <div className="space-y-5 py-2">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono font-black text-2xl text-foreground flex items-center gap-2">
            <Bookmark className="w-5 h-5 text-primary" /> Watchlist
          </h1>
          <p className="text-xs font-mono text-muted-foreground mt-1">
            {items.length} saved project{items.length !== 1 ? "s" : ""} — bookmark from the Projects page
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setLocation("/projects")} className="text-xs font-mono gap-1.5">
          <FolderOpen className="w-3.5 h-3.5" /> Browse Projects
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="py-20 flex flex-col items-center gap-4 border border-dashed border-border/30 rounded-2xl">
          <Bookmark className="w-12 h-12 text-muted-foreground/20" />
          <div className="text-center">
            <p className="font-mono font-bold text-sm text-foreground">No bookmarks yet</p>
            <p className="font-mono text-xs text-muted-foreground/60 mt-1">
              Go to Projects and click the ★ icon to save protocols here.
            </p>
          </div>
          <Button size="sm" onClick={() => setLocation("/projects")} className="text-xs gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" /> Browse Projects
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map(p => (
            <div key={p.id} className="bg-card border border-card-border rounded-xl p-4 hover:border-primary/30 transition-all group">
              <div className="flex items-start gap-3">
                {/* Logo / initial */}
                <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 font-mono font-bold text-primary text-sm">
                  {p.logo_url
                    ? <img src={p.logo_url} alt={p.name} className="w-full h-full object-cover rounded-xl" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    : p.name[0]?.toUpperCase()
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-mono font-bold text-sm text-foreground truncate">{p.name}</span>
                    <Badge variant="outline" className={cn("text-[9px] capitalize flex-shrink-0", STATUS_COLORS[p.status] ?? "")}>
                      {p.status}
                    </Badge>
                  </div>
                  {p.description && (
                    <p className="font-mono text-[10px] text-muted-foreground/60 line-clamp-2 leading-relaxed">{p.description}</p>
                  )}
                  <div className="flex items-center gap-3 mt-2">
                    {p.chain && (
                      <span className="font-mono text-[9px] text-muted-foreground/50 uppercase">{p.chain}</span>
                    )}
                    <span className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground/50">
                      <CheckSquare className="w-2.5 h-2.5" /> {p.task_count} tasks
                    </span>
                    {p.xp_name && (
                      <span className="flex items-center gap-1 font-mono text-[9px] text-primary/70">
                        <Zap className="w-2.5 h-2.5" /> {p.xp_name}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/20">
                <Button
                  size="sm"
                  variant={p.is_joined ? "outline" : "default"}
                  onClick={() => setLocation(`/projects/${p.id}`)}
                  className="flex-1 text-xs font-mono gap-1.5 h-8"
                >
                  {p.is_joined ? <><ExternalLink className="w-3 h-3" /> View</> : <><Star className="w-3 h-3" /> Join</>}
                  <ChevronRight className="w-3 h-3 ml-auto" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(p.id)}
                  disabled={removing.has(p.id)}
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-400/10"
                >
                  {removing.has(p.id)
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <BookmarkX className="w-3.5 h-3.5" />
                  }
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
