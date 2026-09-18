import { ReactNode, useState, useEffect, useRef, useCallback } from "react";
import { AppSidebar } from "./app-sidebar";
import { MobileDock } from "./mobile-dock";
import { Menu, Mail, X, RefreshCw, Inbox, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { NotificationBell } from "@/components/notification-bell";
import { GlobalSearch } from "@/components/global-search";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface MailMsg {
  id: number;
  subject: string;
  from_username?: string;
  to_username?: string;
  body: string;
  is_read: boolean;
  created_at: string;
}

function MailDropdown({ token, isAdmin }: { token: string; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [mails, setMails] = useState<MailMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/ayzen-mail?limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const data = await r.json();
        const msgs: MailMsg[] = Array.isArray(data) ? data : (data.messages ?? []);
        setMails(msgs.slice(0, 8));
        setUnread(msgs.filter((m) => !m.is_read).length);
      }
    } catch { /* silent */ }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const markRead = async (id: number) => {
    try {
      await fetch(`${BASE}/api/ayzen-mail/${id}/read`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      setMails(prev => prev.map(m => m.id === id ? { ...m, is_read: true } : m));
      setUnread(prev => Math.max(0, prev - 1));
    } catch { /* silent */ }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(o => !o); if (!open) load(); }}
        className={cn(
          "relative flex items-center justify-center w-8 h-8 rounded-lg transition-all",
          open ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-primary hover:bg-primary/10"
        )}
        title="AYZEN Mail"
      >
        <Mail className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 bg-primary text-primary-foreground text-[9px] font-bold font-mono rounded-full flex items-center justify-center px-1">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-card border border-primary/20 rounded-xl shadow-2xl overflow-hidden z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-card-border">
            <div className="flex items-center gap-2">
              <Inbox className="w-3.5 h-3.5 text-primary" />
              <span className="font-mono text-xs font-bold text-primary">AYZEN Mail</span>
              {unread > 0 && (
                <span className="bg-primary/10 text-primary font-mono text-[9px] font-bold rounded-full px-1.5 py-0.5">
                  {unread} new
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={load}
                disabled={loading}
                className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all"
              >
                <RefreshCw className={cn("w-3 h-3", loading && "animate-spin")} />
              </button>
              <button onClick={() => setOpen(false)} className="p-1 rounded text-muted-foreground hover:text-foreground">
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {loading && mails.length === 0 ? (
              <div className="py-8 text-center">
                <RefreshCw className="w-5 h-5 text-muted-foreground/30 mx-auto animate-spin" />
              </div>
            ) : mails.length === 0 ? (
              <div className="py-8 text-center">
                <Mail className="w-7 h-7 text-muted-foreground/20 mx-auto mb-2" />
                <p className="font-mono text-xs text-muted-foreground/50">No messages yet</p>
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {mails.map((mail) => (
                  <button
                    key={mail.id}
                    className={cn(
                      "w-full text-left px-4 py-3 hover:bg-muted/20 transition-colors",
                      !mail.is_read && "bg-primary/3"
                    )}
                    onClick={() => markRead(mail.id)}
                  >
                    <div className="flex items-start gap-2">
                      {!mail.is_read && <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className={cn("font-mono text-xs truncate", !mail.is_read ? "font-bold text-foreground" : "text-muted-foreground")}>
                            {mail.subject || "(no subject)"}
                          </span>
                          <span className="font-mono text-[9px] text-muted-foreground/50 flex-shrink-0">
                            {new Date(mail.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">
                          From: {mail.from_username ?? "System"}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground/50 truncate mt-0.5">
                          {mail.body?.slice(0, 60)}{mail.body?.length > 60 ? "…" : ""}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="px-4 py-2.5 border-t border-card-border">
            <Link href="/vault?tab=mail&view=overview" onClick={() => setOpen(false)}>
              <button className="w-full flex items-center justify-center gap-1.5 font-mono text-[10px] text-primary hover:text-primary/80 transition-colors py-1">
                <ExternalLink className="w-3 h-3" /> Open Full Mailbox
              </button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, token } = useAuth();
  const isAdmin = user?.role === "admin";

  return (
    <div className="flex h-screen bg-background overflow-hidden selection:bg-primary/30">
      {isMobile ? (
        <>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent side="left" className="p-0 w-64 border-r border-sidebar-border bg-sidebar">
              <AppSidebar onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <AppSidebar />
      )}

      <main className="flex-1 overflow-y-auto relative flex flex-col">
        <div className="absolute inset-0 z-0 opacity-[0.03] pointer-events-none"
          style={{ backgroundImage: 'linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)', backgroundSize: '40px 40px' }}
        />

        {isMobile && (
          <div className="relative z-10 flex items-center gap-3 px-4 py-3 border-b border-border bg-sidebar/80 backdrop-blur-sm sticky top-0">
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="text-primary hover:bg-primary/10">
              <Menu className="w-5 h-5" />
            </Button>
            <span className="font-mono font-bold tracking-tighter text-primary text-lg flex-1">AYZEN</span>
            <GlobalSearch isAdmin={isAdmin} />
            <MailDropdown token={token ?? ""} isAdmin={isAdmin} />
            <NotificationBell />
          </div>
        )}

        {!isMobile && (
          <div className="relative z-10 flex items-center justify-between px-6 py-2 border-b border-border/40 bg-background/40 backdrop-blur-sm sticky top-0">
            <GlobalSearch isAdmin={isAdmin} />
            <div className="flex items-center gap-2">
              <MailDropdown token={token ?? ""} isAdmin={isAdmin} />
              <NotificationBell />
            </div>
          </div>
        )}

        <div className="relative z-10 p-4 md:p-6 lg:p-8 flex-1 pb-24 md:pb-8">
          {children}
        </div>
      </main>
      <MobileDock />
    </div>
  );
}
