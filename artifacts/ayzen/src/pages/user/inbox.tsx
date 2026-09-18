import { useState, useEffect, useRef, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquare, Send, Search, User, ArrowLeft, MessageCircle,
  CheckCheck, Check, Inbox, RefreshCw,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface Conversation {
  other_user_id: number;
  other_username: string;
  other_avatar?: string;
  other_role: string;
  last_message?: string;
  last_message_at: string;
  unread_count: number;
}

interface Message {
  id: number;
  from_user_id: number;
  to_user_id: number;
  content: string;
  is_read: boolean;
  created_at: string;
  from_username?: string;
}

interface SearchUser {
  id: number;
  username: string;
  avatar_url?: string;
  role: string;
}

export default function UserInbox() {
  const { user } = useAuth();
  const token = localStorage.getItem("ayzen_token") || "";

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [activeUserId, setActiveUserId] = useState<number | null>(null);
  const [activeUsername, setActiveUsername] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/messages/conversations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setConversations(await res.json());
    } catch {} finally { setLoadingConvs(false); }
  }, [token]);

  const loadMessages = useCallback(async (otherId: number) => {
    setLoadingMsgs(true);
    try {
      const res = await fetch(`${BASE}/api/messages/${otherId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setMessages(await res.json());
        // Remove unread badge for this conversation
        setConversations(prev => prev.map(c =>
          c.other_user_id === otherId ? { ...c, unread_count: 0 } : c
        ));
      }
    } catch {} finally { setLoadingMsgs(false); }
  }, [token]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  useEffect(() => {
    if (activeUserId) loadMessages(activeUserId);
  }, [activeUserId, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // SSE for new messages
  useEffect(() => {
    const es = new EventSource(`${BASE}/api/events?token=${encodeURIComponent(token)}`);
    sseRef.current = es;
    es.addEventListener("new_message", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (activeUserId === data.fromUserId) {
        setMessages(prev => [...prev, {
          id: data.id, from_user_id: data.fromUserId, to_user_id: user?.id ?? 0,
          content: data.content, is_read: false, created_at: data.createdAt,
        }]);
      } else {
        setConversations(prev => {
          const existing = prev.find(c => c.other_user_id === data.fromUserId);
          if (existing) {
            return prev.map(c => c.other_user_id === data.fromUserId
              ? { ...c, unread_count: c.unread_count + 1, last_message: data.content, last_message_at: data.createdAt }
              : c
            );
          }
          return prev;
        });
        loadConversations();
      }
    });
    return () => es.close();
  }, [activeUserId, token, user?.id, loadConversations]);

  const searchUsers = useCallback(async (q: string) => {
    if (!q.trim()) { setSearchResults([]); return; }
    try {
      const res = await fetch(`${BASE}/api/messages/users/search?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setSearchResults(await res.json());
    } catch {}
  }, [token]);

  useEffect(() => {
    const t = setTimeout(() => searchUsers(searchQ), 300);
    return () => clearTimeout(t);
  }, [searchQ, searchUsers]);

  const sendMessage = async () => {
    if (!input.trim() || !activeUserId || sending) return;
    const content = input.trim();
    setInput("");
    setSending(true);
    try {
      const res = await fetch(`${BASE}/api/messages/${activeUserId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        const msg = await res.json();
        setMessages(prev => [...prev, msg]);
        setConversations(prev => prev.map(c =>
          c.other_user_id === activeUserId
            ? { ...c, last_message: content, last_message_at: msg.created_at }
            : c
        ));
      }
    } catch {} finally { setSending(false); }
  };

  const openConversation = (otherId: number, username: string) => {
    setActiveUserId(otherId);
    setActiveUsername(username);
    setShowSearch(false);
    setSearchQ("");
    setSearchResults([]);
  };

  const totalUnread = conversations.reduce((a, c) => a + c.unread_count, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Inbox className="w-6 h-6 text-primary" />
            Messages
            {totalUnread > 0 && (
              <Badge className="font-mono text-[10px] bg-primary/20 text-primary border-primary/30">{totalUnread}</Badge>
            )}
          </h1>
          <p className="text-muted-foreground font-mono text-sm">Direct operator communications</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowSearch(v => !v)}
          className="font-mono text-xs gap-2 uppercase"
        >
          <MessageCircle className="w-3.5 h-3.5" /> New Message
        </Button>
      </div>

      {/* New Message search */}
      {showSearch && (
        <Card className="bg-card border-card-border p-4 space-y-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Search operators to message</div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
            <Input
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Type username..."
              className="pl-8 font-mono text-xs h-8 bg-input"
              autoFocus
            />
          </div>
          {searchResults.length > 0 && (
            <div className="space-y-1">
              {searchResults.map(u => (
                <button
                  key={u.id}
                  onClick={() => openConversation(u.id, u.username)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/20 transition-colors text-left"
                >
                  <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                    <User className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <div>
                    <div className="font-mono text-sm font-bold">{u.username}</div>
                    <div className="font-mono text-[9px] text-muted-foreground/50 uppercase">{u.role}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {searchQ && searchResults.length === 0 && (
            <div className="text-center font-mono text-xs text-muted-foreground py-2">No operators found</div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 h-[calc(100vh-280px)] min-h-[400px]">
        {/* Conversations list */}
        <div className="bg-card border border-card-border rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Conversations</span>
            <button onClick={loadConversations} className="text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingConvs ? (
              <div className="p-3 space-y-2">
                {[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground p-4">
                <MessageSquare className="w-8 h-8 opacity-30" />
                <p className="font-mono text-xs text-center">No conversations yet. Start one!</p>
              </div>
            ) : (
              conversations.map(conv => (
                <button
                  key={conv.other_user_id}
                  onClick={() => openConversation(conv.other_user_id, conv.other_username)}
                  className={cn(
                    "w-full flex items-start gap-3 px-4 py-3 border-b border-card-border/50 hover:bg-muted/10 transition-colors text-left",
                    activeUserId === conv.other_user_id && "bg-primary/5 border-l-2 border-l-primary"
                  )}
                >
                  <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <User className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-bold truncate">{conv.other_username}</span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {conv.unread_count > 0 && (
                          <Badge className="font-mono text-[9px] h-4 px-1.5 bg-primary/20 text-primary border-primary/30">{conv.unread_count}</Badge>
                        )}
                        <span className="font-mono text-[9px] text-muted-foreground/40">
                          {format(new Date(conv.last_message_at), "HH:mm")}
                        </span>
                      </div>
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground/50 truncate mt-0.5">
                      {conv.last_message ?? "No messages yet"}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Chat window */}
        <div className="md:col-span-2 bg-card border border-card-border rounded-xl flex flex-col overflow-hidden">
          {!activeUserId ? (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
              <MessageSquare className="w-12 h-12 opacity-20" />
              <p className="font-mono text-sm">Select a conversation to start chatting</p>
            </div>
          ) : (
            <>
              {/* Chat header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-card-border bg-card/50">
                <button
                  onClick={() => setActiveUserId(null)}
                  className="md:hidden text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <User className="w-3.5 h-3.5 text-primary" />
                </div>
                <div>
                  <div className="font-mono font-bold text-sm">{activeUsername}</div>
                  <div className="font-mono text-[9px] text-emerald-400">Online</div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {loadingMsgs ? (
                  <div className="space-y-2">
                    {[1,2,3].map(i => <Skeleton key={i} className="h-10 w-2/3" />)}
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                    <p className="font-mono text-xs">No messages yet. Say hi!</p>
                  </div>
                ) : (
                  messages.map(msg => {
                    const isMine = msg.from_user_id === user?.id;
                    return (
                      <div key={msg.id} className={cn("flex gap-2", isMine ? "flex-row-reverse" : "flex-row")}>
                        {!isMine && (
                          <div className="w-6 h-6 rounded-full bg-muted border border-card-border flex items-center justify-center flex-shrink-0 mt-auto">
                            <User className="w-3 h-3 text-muted-foreground" />
                          </div>
                        )}
                        <div className={cn(
                          "max-w-[75%] rounded-2xl px-3 py-2 font-mono text-sm leading-relaxed",
                          isMine
                            ? "bg-primary/15 border border-primary/20 text-foreground rounded-tr-sm"
                            : "bg-muted/40 border border-card-border text-foreground rounded-tl-sm"
                        )}>
                          <p className="break-words">{msg.content}</p>
                          <div className={cn("flex items-center gap-1 mt-1", isMine ? "justify-end" : "justify-start")}>
                            <span className="text-[9px] text-muted-foreground/40">
                              {format(new Date(msg.created_at), "HH:mm")}
                            </span>
                            {isMine && (
                              msg.is_read
                                ? <CheckCheck className="w-2.5 h-2.5 text-primary/60" />
                                : <Check className="w-2.5 h-2.5 text-muted-foreground/40" />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input */}
              <form
                onSubmit={e => { e.preventDefault(); sendMessage(); }}
                className="flex gap-2 p-3 border-t border-card-border"
              >
                <Input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder={`Message ${activeUsername}...`}
                  disabled={sending}
                  className="flex-1 font-mono text-sm h-9 bg-input"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!input.trim() || sending}
                  className="gap-1.5 font-mono text-xs uppercase h-9"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
