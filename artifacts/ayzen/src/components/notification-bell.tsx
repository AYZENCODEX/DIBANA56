import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, BellRing, Check, CheckCheck, Trash2, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface Notification {
  id: number;
  userId: number;
  type: string;
  title: string;
  message: string | null;
  isRead: boolean;
  data: string | null;
  createdAt: string;
}

const TYPE_ICON: Record<string, string> = {
  task_approved: "✅",
  task_rejected: "❌",
  task_submitted: "📋",
  azn_transfer: "💸",
  system: "🔔",
  streak: "🔥",
  broadcast: "📡",
};

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationBell() {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const headers = { Authorization: `Bearer ${token}` };

  const fetchCount = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${BASE}/api/notifications/unread-count`, { headers });
      if (r.ok) { const d = await r.json(); setCount(d.count ?? 0); }
    } catch {}
  }, [token]);

  const fetchNotifications = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/notifications`, { headers });
      if (r.ok) setNotifications(await r.json());
    } catch {}
    setLoading(false);
  }, [token]);

  // Poll unread count every 30s
  useEffect(() => {
    fetchCount();
    const id = setInterval(fetchCount, 30_000);
    return () => clearInterval(id);
  }, [fetchCount]);

  // SSE — listen for real-time notification events
  useEffect(() => {
    if (!token) return;
    const url = `${BASE}/api/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    es.addEventListener("notification", () => { fetchCount(); if (open) fetchNotifications(); });
    return () => es.close();
  }, [token, open, fetchCount, fetchNotifications]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleOpen = () => {
    setOpen(v => !v);
    if (!open) fetchNotifications();
  };

  const markRead = async (id: number) => {
    await fetch(`${BASE}/api/notifications/${id}/read`, { method: "PATCH", headers });
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
    setCount(prev => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    await fetch(`${BASE}/api/notifications/read-all`, { method: "PATCH", headers });
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    setCount(0);
  };

  const deleteNotif = async (id: number, wasRead: boolean) => {
    await fetch(`${BASE}/api/notifications/${id}`, { method: "DELETE", headers });
    setNotifications(prev => prev.filter(n => n.id !== id));
    if (!wasRead) setCount(prev => Math.max(0, prev - 1));
  };

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={handleOpen}
        className={cn(
          "relative flex items-center justify-center w-9 h-9 rounded-lg transition-all duration-200",
          "text-muted-foreground hover:text-primary hover:bg-primary/10",
          open && "text-primary bg-primary/10"
        )}
        aria-label="Notifications"
      >
        {count > 0 ? <BellRing className="w-5 h-5 animate-pulse" /> : <Bell className="w-5 h-5" />}
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-primary text-black text-[10px] font-bold rounded-full flex items-center justify-center px-0.5">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-11 w-80 z-50 bg-card border border-card-border rounded-xl shadow-2xl shadow-black/40 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="font-mono font-bold text-sm uppercase tracking-wider text-foreground flex items-center gap-2">
              <Bell className="w-4 h-4 text-primary" /> Notifications
              {count > 0 && (
                <span className="bg-primary/20 text-primary text-[10px] font-bold rounded-full px-1.5 py-0.5">{count}</span>
              )}
            </span>
            <div className="flex items-center gap-1">
              {notifications.some(n => !n.isRead) && (
                <button onClick={markAllRead} title="Mark all as read"
                  className="text-muted-foreground hover:text-primary p-1 rounded transition-colors">
                  <CheckCheck className="w-4 h-4" />
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Notification list */}
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="py-8 text-center text-muted-foreground font-mono text-xs">Loading...</div>
            ) : notifications.length === 0 ? (
              <div className="py-10 text-center flex flex-col items-center gap-2 text-muted-foreground">
                <Bell className="w-6 h-6 opacity-20" />
                <span className="font-mono text-xs">No notifications yet</span>
              </div>
            ) : (
              notifications.map(n => (
                <div key={n.id}
                  className={cn(
                    "group flex items-start gap-3 px-4 py-3 border-b border-border/50 last:border-0 transition-colors cursor-pointer",
                    !n.isRead ? "bg-primary/5 hover:bg-primary/8" : "hover:bg-muted/30"
                  )}
                  onClick={() => !n.isRead && markRead(n.id)}
                >
                  <span className="text-base shrink-0 pt-0.5">{TYPE_ICON[n.type] ?? "🔔"}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1">
                      <p className={cn("font-mono text-xs font-semibold leading-tight", !n.isRead ? "text-foreground" : "text-muted-foreground")}>
                        {n.title}
                      </p>
                      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        {!n.isRead && (
                          <button onClick={(e) => { e.stopPropagation(); markRead(n.id); }}
                            className="text-primary hover:text-primary/80 p-0.5 rounded" title="Mark read">
                            <Check className="w-3 h-3" />
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); deleteNotif(n.id, n.isRead); }}
                          className="text-muted-foreground hover:text-red-400 p-0.5 rounded" title="Delete">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    {n.message && (
                      <p className="font-mono text-[11px] text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{n.message}</p>
                    )}
                    <p className="font-mono text-[10px] text-muted-foreground/50 mt-1">{timeAgo(n.createdAt)}</p>
                  </div>
                  {!n.isRead && (
                    <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-1.5" />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
