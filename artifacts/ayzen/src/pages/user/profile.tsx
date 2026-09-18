import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import {
  Camera, Twitter, Globe, MessageCircle, Edit3, Save, X,
  Trophy, Zap, FolderGit2, CheckSquare, User, Link2,
  Sparkles, Shield, Star, Phone, Facebook, MapPin,
  BadgeCheck, Lock, CheckCircle2, Circle, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ProfileData {
  id: number;
  username: string;
  email: string;
  role: string;
  status: string;
  avatarUrl: string | null;
  bio: string | null;
  twitterHandle: string | null;
  discordHandle: string | null;
  websiteUrl: string | null;
  telegramHandle: string | null;
  telegramChatId: string | null;
  whatsappNumber: string | null;
  facebookUrl: string | null;
  location: string | null;
  kycLevel: number;
  kycVerified: boolean;
  kycStatus: string;
  kycSubmittedAt: string | null;
  kycReviewedAt: string | null;
  kycRejectionReason: string | null;
  totalRoi: number;
  streak: number;
  longestStreak: number;
  projectCount: number;
  tasksCompleted: number;
  createdAt: string;
}

function AnimatedCounter({ value, suffix = "" }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let start = 0;
    const end = value;
    if (end === 0) { setDisplay(0); return; }
    const duration = 1200;
    const step = end / (duration / 16);
    const timer = setInterval(() => {
      start += step;
      if (start >= end) { setDisplay(end); clearInterval(timer); }
      else setDisplay(Math.floor(start));
    }, 16);
    return () => clearInterval(timer);
  }, [value]);
  return <span>{display.toLocaleString()}{suffix}</span>;
}

function Particle({ style }: { style: React.CSSProperties }) {
  return (
    <div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: 3, height: 3,
        background: "hsl(180 100% 45% / 0.6)",
        animation: `particle-drift ${4 + Math.random() * 4}s ease-in-out infinite`,
        ...style,
      }}
    />
  );
}

export default function ProfilePage() {
  const { user, token } = useAuth() as any;
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  const [form, setForm] = useState({
    username: "",
    bio: "",
    twitterHandle: "",
    discordHandle: "",
    websiteUrl: "",
    telegramHandle: "",
    whatsappNumber: "",
    facebookUrl: "",
    location: "",
    avatarUrl: "",
  });
  const [kycSubmitting, setKycSubmitting] = useState(false);
  const [tgBotUsername, setTgBotUsername] = useState<string | null>(null);
  const [tgCode, setTgCode] = useState("");
  const [tgConnecting, setTgConnecting] = useState(false);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/profile", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load profile");
      const data = await res.json();
      setProfile(data);
      setForm({
        username: data.username ?? "",
        bio: data.bio ?? "",
        twitterHandle: data.twitterHandle ?? "",
        discordHandle: data.discordHandle ?? "",
        websiteUrl: data.websiteUrl ?? "",
        telegramHandle: data.telegramHandle ?? "",
        whatsappNumber: data.whatsappNumber ?? "",
        facebookUrl: data.facebookUrl ?? "",
        location: data.location ?? "",
        avatarUrl: data.avatarUrl ?? "",
      });
      setAvatarPreview(data.avatarUrl ?? null);
    } catch {
      toast({ title: "Failed to load profile", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token, toast]);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  useEffect(() => {
    fetch("/api/telegram/status")
      .then(r => r.json())
      .then(d => { if (d.online && d.username) setTgBotUsername(d.username); })
      .catch(() => {});
  }, []);

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Max 2MB", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      // Resize via canvas to 256×256 JPEG
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext("2d")!;
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        ctx.drawImage(img, sx, sy, size, size, 0, 0, 256, 256);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        setAvatarPreview(dataUrl);
        setForm(f => ({ ...f, avatarUrl: dataUrl }));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error("Save failed");
      const updated = await res.json();
      setProfile(prev => prev ? { ...prev, ...updated } : null);
      setEditing(false);
      toast({ title: "Profile updated", description: "Changes saved successfully." });
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const KYC_V1_FIELDS: { key: keyof ProfileData; label: string }[] = [
    { key: "avatarUrl", label: "Profile picture" },
    { key: "twitterHandle", label: "Twitter / X link" },
    { key: "discordHandle", label: "Discord link" },
    { key: "telegramHandle", label: "Telegram username" },
    { key: "telegramChatId", label: "Telegram bot connected" },
    { key: "whatsappNumber", label: "WhatsApp number" },
    { key: "location", label: "Location" },
  ];
  const kycMissingFields = profile
    ? KYC_V1_FIELDS.filter(f => !profile[f.key])
    : KYC_V1_FIELDS;
  const kycEligible = kycMissingFields.length === 0;
  const kycPending = profile?.kycStatus === "pending";
  const kycApproved = profile?.kycStatus === "approved";
  const kycRejected = profile?.kycStatus === "rejected";

  const handleKycSubmit = async () => {
    setKycSubmitting(true);
    try {
      const res = await fetch("/api/profile/kyc/submit", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: "KYC submission failed",
          description: data.missingFields ? `Missing: ${data.missingFields.join(", ")}` : data.error,
          variant: "destructive",
        });
        return;
      }
      setProfile(prev => prev ? { ...prev, ...data } : null);
      toast({ title: "KYC submitted", description: "Awaiting admin review — you'll be notified once it's checked." });
    } catch {
      toast({ title: "KYC submission failed", variant: "destructive" });
    } finally {
      setKycSubmitting(false);
    }
  };

  const handleTelegramVerify = async () => {
    if (!tgCode.trim()) return;
    setTgConnecting(true);
    try {
      const res = await fetch("/api/telegram/connect/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: tgCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Telegram link failed", description: data.error, variant: "destructive" });
        return;
      }
      setTgCode("");
      toast({ title: "Telegram bot connected" });
      await fetchProfile();
    } catch {
      toast({ title: "Telegram link failed", variant: "destructive" });
    } finally {
      setTgConnecting(false);
    }
  };

  const cancelEdit = () => {
    if (profile) {
      setForm({
        username: profile.username ?? "",
        bio: profile.bio ?? "",
        twitterHandle: profile.twitterHandle ?? "",
        discordHandle: profile.discordHandle ?? "",
        websiteUrl: profile.websiteUrl ?? "",
        telegramHandle: profile.telegramHandle ?? "",
        whatsappNumber: profile.whatsappNumber ?? "",
        facebookUrl: profile.facebookUrl ?? "",
        location: profile.location ?? "",
        avatarUrl: profile.avatarUrl ?? "",
      });
      setAvatarPreview(profile.avatarUrl ?? null);
    }
    setEditing(false);
  };

  const particles = Array.from({ length: 12 }, (_, i) => ({
    top: `${10 + Math.random() * 80}%`,
    left: `${5 + Math.random() * 90}%`,
    animationDelay: `${i * 0.4}s`,
  }));

  const joinDate = profile
    ? new Date(profile.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : "";

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-16 h-16">
            <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-spin-slow" />
            <div className="absolute inset-2 rounded-full border border-primary/40 animate-spin-reverse" />
            <div className="absolute inset-4 rounded-full bg-primary/10 animate-glow-pulse" />
          </div>
          <p className="font-mono text-xs text-muted-foreground tracking-widest uppercase">Loading profile…</p>
        </div>
      </div>
    );
  }

  if (!profile) return null;

  const displayAvatar = avatarPreview || profile.avatarUrl;
  const initials = profile.username.slice(0, 2).toUpperCase();

  return (
    <div className="max-w-4xl mx-auto space-y-6 page-enter">

      {/* ── Hero Banner ─────────────────────────────────────────── */}
      <div className="relative rounded-xl overflow-hidden h-48 md:h-56">
        {/* Aurora background */}
        <div
          className="absolute inset-0 animate-aurora"
          style={{
            background: "linear-gradient(135deg, hsl(220 16% 7%), hsl(180 100% 12%), hsl(270 100% 10%), hsl(220 16% 7%))",
            backgroundSize: "300% 300%",
          }}
        />
        {/* Grid overlay */}
        <div className="absolute inset-0 opacity-10"
          style={{ backgroundImage: "linear-gradient(to right, hsl(180 100% 45%) 1px, transparent 1px), linear-gradient(to bottom, hsl(180 100% 45%) 1px, transparent 1px)", backgroundSize: "40px 40px" }} />
        {/* Floating particles */}
        {particles.map((p, i) => (
          <Particle key={i} style={{ top: p.top, left: p.left, animationDelay: p.animationDelay }} />
        ))}
        {/* Gradient fade bottom */}
        <div className="absolute bottom-0 inset-x-0 h-24 bg-gradient-to-t from-background to-transparent" />
        {/* Corner accent */}
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <div className="px-2 py-1 bg-primary/10 border border-primary/20 rounded text-[10px] font-mono text-primary tracking-widest uppercase">
            {profile.role}
          </div>
          {profile.status === "active" && (
            <div className="flex items-center gap-1 px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] font-mono text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Online
            </div>
          )}
        </div>
        {/* Member since */}
        <div className="absolute bottom-6 right-4 text-[10px] font-mono text-muted-foreground/50 tracking-widest">
          MEMBER SINCE {joinDate.toUpperCase()}
        </div>
      </div>

      {/* ── Avatar + Name Row ────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-end gap-6 -mt-20 px-2 relative z-10">
        {/* Avatar */}
        <div className="relative group animate-fade-up">
          {/* Outer glow ring */}
          <div className="absolute -inset-1 rounded-full animate-glow-pulse opacity-60" />
          {/* Spinning border */}
          <div className="absolute -inset-2 rounded-full border border-primary/20 animate-spin-slow" />
          <div className="absolute -inset-3 rounded-full border border-secondary/10 animate-spin-reverse" />
          {/* Avatar */}
          <div className="relative w-28 h-28 rounded-full overflow-hidden border-2 border-primary/40 bg-card">
            {displayAvatar ? (
              <img src={displayAvatar} alt={profile.username} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-secondary/20">
                <span className="text-3xl font-mono font-bold text-primary">{initials}</span>
              </div>
            )}
            {/* Upload overlay */}
            {editing && (
              <button
                onClick={() => fileRef.current?.click()}
                className="absolute inset-0 bg-background/70 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 cursor-pointer"
              >
                <Camera className="w-5 h-5 text-primary" />
                <span className="text-[9px] font-mono text-primary uppercase tracking-wider">Upload</span>
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarFile} />
        </div>

        {/* Name + actions */}
        <div className="flex-1 flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-1 animate-fade-up delay-100">
          <div>
            {editing ? (
              <input
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                maxLength={30}
                className="bg-transparent border-b border-primary/40 text-2xl font-mono font-bold text-foreground focus:border-primary outline-none w-full max-w-xs transition-colors"
              />
            ) : (
              <h1 className="text-2xl md:text-3xl font-mono font-bold text-foreground tracking-tight">
                {profile.username}
              </h1>
            )}
            <p className="text-sm font-mono text-muted-foreground mt-0.5">{profile.email}</p>
          </div>

          {/* Edit / Save / Cancel */}
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <button
                  onClick={cancelEdit}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-muted-foreground font-mono text-sm hover:border-destructive/40 hover:text-destructive transition-all duration-200 hover-lift"
                >
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-mono text-sm font-bold hover:bg-primary/90 transition-all duration-200 hover-lift animate-glow-pulse disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary/30 text-primary font-mono text-sm hover:bg-primary/10 hover:border-primary/60 transition-all duration-200 hover-lift hover-shimmer"
              >
                <Edit3 className="w-3.5 h-3.5" /> Edit Profile
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Stats Row ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 animate-fade-up delay-200">
        {[
          { icon: Zap, label: "Total ROI", value: profile.totalRoi, suffix: " $", color: "primary" },
          { icon: Star, label: "Streak", value: profile.streak, suffix: " days", color: "secondary" },
          { icon: FolderGit2, label: "Projects", value: profile.projectCount, suffix: "", color: "primary" },
          { icon: CheckSquare, label: "Tasks Done", value: profile.tasksCompleted, suffix: "", color: "secondary" },
        ].map(({ icon: Icon, label, value, suffix, color }, i) => (
          <div
            key={label}
            className={cn(
              "glass-card rounded-xl p-4 hover-lift hover-shimmer cursor-default",
              "border transition-all duration-300",
              `animate-fade-up delay-${(i + 2) * 100}`
            )}
          >
            <div className={cn("flex items-center gap-2 mb-3", color === "primary" ? "text-primary" : "text-secondary")}>
              <Icon className="w-4 h-4" />
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</span>
            </div>
            <div className={cn("text-2xl font-mono font-bold", color === "primary" ? "text-primary" : "text-secondary")}>
              <AnimatedCounter value={value} suffix={suffix} />
            </div>
          </div>
        ))}
      </div>

      {/* ── Bio ──────────────────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-5 hover-glow transition-all duration-300 border animate-fade-up delay-300">
        <div className="flex items-center gap-2 mb-3">
          <User className="w-4 h-4 text-primary" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">About</span>
        </div>
        {editing ? (
          <div className="relative">
            <textarea
              value={form.bio}
              onChange={e => setForm(f => ({ ...f, bio: e.target.value.slice(0, 300) }))}
              placeholder="Describe yourself — your strategy, chains you operate on, goals…"
              rows={4}
              className="w-full bg-input/50 border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground resize-none focus:border-primary/60 outline-none transition-colors"
            />
            <span className="absolute bottom-2 right-3 text-[10px] font-mono text-muted-foreground/40">
              {form.bio.length}/300
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground font-mono leading-relaxed">
            {profile.bio || (
              <span className="text-muted-foreground/30 italic">No bio yet — click Edit Profile to add one.</span>
            )}
          </p>
        )}
      </div>

      {/* ── Social Links ─────────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-5 border animate-fade-up delay-400">
        <div className="flex items-center gap-2 mb-4">
          <Link2 className="w-4 h-4 text-primary" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Social Links</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            {
              key: "twitterHandle" as const,
              icon: Twitter,
              label: "Twitter / X",
              placeholder: "username",
              prefix: "x.com/",
              color: "text-sky-400",
              href: (v: string) => `https://x.com/${v}`,
            },
            {
              key: "discordHandle" as const,
              icon: MessageCircle,
              label: "Discord",
              placeholder: "username#0000",
              prefix: "",
              color: "text-indigo-400",
              href: null,
            },
            {
              key: "websiteUrl" as const,
              icon: Globe,
              label: "Website",
              placeholder: "https://yoursite.com",
              prefix: "",
              color: "text-emerald-400",
              href: (v: string) => v,
            },
            {
              key: "telegramHandle" as const,
              icon: MessageCircle,
              label: "Telegram",
              placeholder: "username",
              prefix: "t.me/",
              color: "text-cyan-400",
              href: (v: string) => `https://t.me/${v}`,
            },
            {
              key: "whatsappNumber" as const,
              icon: Phone,
              label: "WhatsApp",
              placeholder: "+1 555 000 0000",
              prefix: "",
              color: "text-green-400",
              href: (v: string) => `https://wa.me/${v.replace(/[^0-9]/g, "")}`,
            },
            {
              key: "facebookUrl" as const,
              icon: Facebook,
              label: "Facebook (optional)",
              placeholder: "https://facebook.com/yourprofile",
              prefix: "",
              color: "text-blue-400",
              href: (v: string) => v,
            },
            {
              key: "location" as const,
              icon: MapPin,
              label: "Location",
              placeholder: "City, Country",
              prefix: "",
              color: "text-amber-400",
              href: null,
            },
          ].map(({ key, icon: Icon, label, placeholder, prefix, color, href }) => {
            const val = editing ? form[key] : profile[key];
            return (
              <div key={key} className="flex items-center gap-3 p-3 rounded-lg bg-muted/20 border border-border/50 hover-lift hover-glow group transition-all duration-200">
                <Icon className={cn("w-4 h-4 flex-shrink-0", color)} />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-wider mb-0.5">{label}</p>
                  {editing ? (
                    <div className="flex items-center gap-1">
                      {prefix && <span className="text-xs font-mono text-muted-foreground/40">{prefix}</span>}
                      <input
                        value={form[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                        placeholder={placeholder}
                        className="flex-1 bg-transparent text-sm font-mono text-foreground border-b border-border focus:border-primary/60 outline-none transition-colors"
                      />
                    </div>
                  ) : val ? (
                    href ? (
                      <a
                        href={href(val)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn("text-sm font-mono truncate hover:underline transition-colors", color)}
                      >
                        {prefix}{val}
                      </a>
                    ) : (
                      <span className={cn("text-sm font-mono truncate", color)}>{val}</span>
                    )
                  ) : (
                    <span className="text-xs font-mono text-muted-foreground/30 italic">Not set</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── KYC Verification ─────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-5 border animate-fade-up delay-450">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {kycApproved ? (
              <BadgeCheck className="w-4 h-4 text-emerald-400" />
            ) : (
              <Shield className="w-4 h-4 text-primary" />
            )}
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              KYC Verification
            </span>
          </div>
          {kycApproved ? (
            <span className="flex items-center gap-1 px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] font-mono text-emerald-400 uppercase tracking-widest">
              <BadgeCheck className="w-3 h-3" /> Verified · Level {profile.kycLevel}
            </span>
          ) : kycPending ? (
            <span className="flex items-center gap-1 px-2 py-1 bg-amber-400/10 border border-amber-400/20 rounded text-[10px] font-mono text-amber-400 uppercase tracking-widest">
              <Loader2 className="w-3 h-3 animate-spin" /> Pending Admin Review
            </span>
          ) : kycRejected ? (
            <span className="flex items-center gap-1 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-[10px] font-mono text-red-400 uppercase tracking-widest">
              <X className="w-3 h-3" /> Rejected
            </span>
          ) : (
            <span className="px-2 py-1 bg-muted/30 border border-border rounded text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
              Unverified
            </span>
          )}
        </div>

        {/* Level v1 */}
        <div className="rounded-lg border border-border/50 bg-muted/10 p-4 mb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-mono font-bold text-foreground">Level 1 — Basic Profile</span>
            {kycApproved && (
              <span className="text-[10px] font-mono text-emerald-400">
                Verified {profile.kycReviewedAt ? new Date(profile.kycReviewedAt).toLocaleDateString() : ""}
              </span>
            )}
          </div>

          {kycRejected && profile.kycRejectionReason && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/20 text-xs font-mono text-red-400">
              Rejected by admin: {profile.kycRejectionReason}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
            {KYC_V1_FIELDS.map(f => {
              const filled = Boolean(profile[f.key]);
              return (
                <div key={f.key} className="flex items-center gap-2 text-xs font-mono">
                  {filled ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-muted-foreground/30 flex-shrink-0" />
                  )}
                  <span className={cn(filled ? "text-foreground" : "text-muted-foreground/50")}>{f.label}</span>
                </div>
              );
            })}
          </div>

          {/* Telegram bot connect — required step */}
          {!profile.telegramChatId && !kycApproved && (
            <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3 mb-4">
              <p className="text-xs font-mono text-cyan-400 mb-2 flex items-center gap-1.5">
                <MessageCircle className="w-3.5 h-3.5" /> Connect the AYZEN Telegram bot
              </p>
              <p className="text-[11px] font-mono text-muted-foreground/70 mb-2">
                Open {tgBotUsername ? (
                  <a
                    href={`https://t.me/${tgBotUsername}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-cyan-400 hover:underline"
                  >@{tgBotUsername}</a>
                ) : "the AYZEN bot"} on Telegram, send <span className="text-foreground">/connect</span>, then paste the 6-digit code below.
              </p>
              <div className="flex items-center gap-2">
                <input
                  value={tgCode}
                  onChange={e => setTgCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  maxLength={6}
                  className="flex-1 bg-input/50 border border-border rounded-lg px-3 py-1.5 text-sm font-mono text-foreground focus:border-cyan-400/60 outline-none transition-colors"
                />
                <button
                  onClick={handleTelegramVerify}
                  disabled={tgConnecting || tgCode.length !== 6}
                  className="px-3 py-1.5 rounded-lg bg-cyan-400/10 border border-cyan-400/30 text-cyan-400 font-mono text-xs hover:bg-cyan-400/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {tgConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Verify"}
                </button>
              </div>
            </div>
          )}

          {kycPending && (
            <p className="text-xs font-mono text-amber-400/80 mb-1">
              Your submission is with an admin for review. You'll get an in-app and Telegram alert once it's decided.
            </p>
          )}

          {!kycApproved && !kycPending && (
            <>
              {!kycEligible && (
                <p className="text-xs font-mono text-muted-foreground/60 mb-3">
                  Complete and save your profile fields above (edit profile), then submit for Level 1 review.
                </p>
              )}
              <button
                onClick={handleKycSubmit}
                disabled={!kycEligible || kycSubmitting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-mono text-sm font-bold hover:bg-primary/90 transition-all duration-200 hover-lift disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {kycSubmitting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <BadgeCheck className="w-3.5 h-3.5" />
                )}
                {kycSubmitting ? "Submitting…" : kycRejected ? "Resubmit for Review" : "Submit for Review"}
              </button>
            </>
          )}
        </div>

        {/* Level v2 — upcoming */}
        <div className="rounded-lg border border-border/30 bg-muted/5 p-4 flex items-center justify-between opacity-60">
          <div>
            <span className="text-sm font-mono font-bold text-foreground">Level 2 — Document Verification</span>
            <p className="text-xs font-mono text-muted-foreground/50 mt-0.5">ID document & advanced checks</p>
          </div>
          <span className="flex items-center gap-1 px-2 py-1 bg-muted/30 border border-border rounded text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
            <Lock className="w-3 h-3" /> Upcoming
          </span>
        </div>
      </div>

      {/* ── Achievements ─────────────────────────────────────────── */}
      <div className="glass-card rounded-xl p-5 border animate-fade-up delay-500">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Achievements</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { label: "Early Operator", icon: Shield, condition: true, color: "border-primary/30 text-primary bg-primary/5" },
            { label: "Streak 7+", icon: Zap, condition: profile.streak >= 7, color: "border-secondary/30 text-secondary bg-secondary/5" },
            { label: "Streak 30+", icon: Zap, condition: profile.streak >= 30, color: "border-amber-400/30 text-amber-400 bg-amber-400/5" },
            { label: "10+ Tasks", icon: CheckSquare, condition: profile.tasksCompleted >= 10, color: "border-emerald-400/30 text-emerald-400 bg-emerald-400/5" },
            { label: "50+ Tasks", icon: CheckSquare, condition: profile.tasksCompleted >= 50, color: "border-orange-400/30 text-orange-400 bg-orange-400/5" },
            { label: "Project Veteran", icon: FolderGit2, condition: profile.projectCount >= 5, color: "border-cyan-400/30 text-cyan-400 bg-cyan-400/5" },
            { label: "ROI 1K+", icon: Star, condition: profile.totalRoi >= 1000, color: "border-violet-400/30 text-violet-400 bg-violet-400/5" },
            { label: "Admin", icon: Shield, condition: profile.role === "admin", color: "border-red-400/30 text-red-400 bg-red-400/5" },
          ].map(({ label, icon: Icon, condition, color }) => (
            <div
              key={label}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-mono font-medium transition-all duration-300",
                condition ? cn(color, "hover-lift") : "border-border/20 text-muted-foreground/20 opacity-40 grayscale"
              )}
            >
              <Icon className="w-3 h-3" />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* ── Decorative bottom line ───────────────────────────────── */}
      <div className="flex items-center gap-4 py-2 animate-fade-up delay-600">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
        <span className="text-[10px] font-mono text-muted-foreground/30 tracking-widest">AYZEN PROTOCOL</span>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
      </div>
    </div>
  );
}
