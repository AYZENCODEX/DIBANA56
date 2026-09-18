import { useState, useEffect, useCallback } from "react";
import { useSearch, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck, KeyRound, Eye, EyeOff, Lock, Key, Copy, Trash2, Plus,
  AlertTriangle, Zap, Loader2, Smartphone, Mail, QrCode, CheckCircle2, XCircle,
  Terminal, RefreshCw, Ban, ChevronDown, ChevronUp, Fingerprint, Pencil,
  Monitor, LogOut, MapPin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { listPasskeys, registerPasskey, renamePasskey, deletePasskey, browserSupportsWebAuthn, type PasskeySummary } from "@/lib/passkey-api";
import { getVaultSecurityStatus } from "@/lib/vault-security-api";
import { useVaultPinPrompt } from "@/components/vault/vault-pin-prompt";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const SECURITY_SIDEBAR = [
  { id: "password", label: "Password",       icon: KeyRound },
  { id: "sessions", label: "Sessions & Devices", icon: Monitor },
  { id: "passkeys",  label: "Passkeys",       icon: Fingerprint },
  { id: "2fa",       label: "2FA / TOTP",     icon: QrCode },
  { id: "backup",    label: "Backup Codes",   icon: Key },
  { id: "magic",     label: "Magic Codes",    icon: Zap },
  { id: "recovery",  label: "Recovery Email", icon: Mail },
  { id: "apikeys",   label: "Developer API",  icon: Terminal },
] as const;

type SecuritySection = typeof SECURITY_SIDEBAR[number]["id"];

export default function UserSecurity() {
  const { token, user } = useAuth() as any;
  const search = useSearch();
  const [, navigate] = useLocation();
  const urlTab = new URLSearchParams(search).get("tab") as SecuritySection | null;
  const [section, setSectionState] = useState<SecuritySection>(
    urlTab && SECURITY_SIDEBAR.some(s => s.id === urlTab) ? urlTab : "password"
  );
  const setSection = (id: SecuritySection) => {
    setSectionState(id);
    navigate(`/security?tab=${id}`, { replace: true });
  };
  useEffect(() => {
    if (urlTab && SECURITY_SIDEBAR.some(s => s.id === urlTab) && urlTab !== section) {
      setSectionState(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary" /> Security
        </h1>
        <p className="text-muted-foreground font-mono text-xs mt-1">
          Account: <span className="text-primary">{user?.username ?? "..."}</span> · {user?.email ?? ""}
        </p>
      </div>

      <div className="flex flex-col md:flex-row border border-card-border rounded-xl overflow-hidden min-h-[560px] bg-card">
        {/* ── Mobile nav: scrollable pill bar ──────────────────────────── */}
        <div className="md:hidden flex gap-1 overflow-x-auto border-b border-card-border bg-card/60 px-3 py-2 shrink-0 no-scrollbar">
          {SECURITY_SIDEBAR.map(item => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono font-medium whitespace-nowrap transition-all shrink-0",
                section === item.id
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "text-muted-foreground border border-transparent hover:bg-muted/30 hover:text-foreground"
              )}
            >
              <item.icon className="w-3.5 h-3.5 shrink-0" />
              {item.label}
            </button>
          ))}
        </div>

        {/* ── Desktop sidebar ───────────────────────────────────────────── */}
        <nav className="hidden md:flex w-52 shrink-0 border-r border-card-border bg-card/60 flex-col py-2">
          {SECURITY_SIDEBAR.map(item => (
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

        {/* ── Content ────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-auto p-4 md:p-5 min-w-0">
          {section === "password" && <PasswordPanel token={token} />}
          {section === "sessions" && <SessionsPanel token={token} />}
          {section === "passkeys" && <PasskeysPanel token={token} />}
          {section === "2fa" && <TwoFactorPanel token={token} />}
          {section === "backup" && <BackupCodesPanel token={token} />}
          {section === "magic" && <MagicCodesPanel token={token} />}
          {section === "recovery" && <RecoveryEmailPanel token={token} user={user} />}
          {section === "apikeys" && <ApiKeysPanel token={token} />}
        </div>
      </div>
    </div>
  );
}

function Panel({ title, sub, icon: Icon, iconClass, children }: { title: string; sub?: string; icon: React.ElementType; iconClass?: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden">
      <div className="bg-primary/5 border-b border-card-border px-5 py-4 flex items-center gap-3">
        <div className={cn("w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center", iconClass)}>
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div>
          <div className="font-mono font-bold text-sm text-foreground">{title}</div>
          {sub && <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{sub}</div>}
        </div>
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}

// ─── Password ─────────────────────────────────────────────────────────────────
function PasswordPanel({ token }: { token: string }) {
  const { toast } = useToast();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleChangePassword = async () => {
    if (!oldPw || !newPw) { toast({ variant: "destructive", title: "Fill both fields" }); return; }
    if (newPw.length < 6) { toast({ variant: "destructive", title: "New password too short", description: "Minimum 6 characters." }); return; }
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/users/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "✅ Password changed", description: "Your passphrase has been updated." });
        setOldPw(""); setNewPw("");
      } else {
        toast({ variant: "destructive", title: "Password change failed", description: data.error ?? "Wrong current password?" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setLoading(false);
  };

  return (
    <Panel title="Change Password" sub="Update your account passphrase" icon={KeyRound}>
      <div className="max-w-md space-y-4">
        <div className="space-y-2">
          <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Current Password</label>
          <div className="relative">
            <Input
              type={showOld ? "text" : "password"}
              value={oldPw}
              onChange={e => setOldPw(e.target.value)}
              placeholder="Current passphrase"
              className="font-mono h-10 text-sm bg-input border-border pr-9 focus-visible:ring-primary/50"
            />
            <button type="button" onClick={() => setShowOld(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              {showOld ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div className="space-y-2">
          <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">New Password</label>
          <div className="relative">
            <Input
              type={showNew ? "text" : "password"}
              value={newPw}
              onChange={e => setNewPw(e.target.value)}
              placeholder="New passphrase (min 6 chars)"
              className="font-mono h-10 text-sm bg-input border-border pr-9 focus-visible:ring-primary/50"
            />
            <button type="button" onClick={() => setShowNew(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <Button
          className="font-mono text-xs gap-2 h-10"
          onClick={handleChangePassword}
          disabled={loading || !oldPw || !newPw}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
          {loading ? "Updating..." : "Update Password"}
        </Button>
      </div>
    </Panel>
  );
}

// ─── Sessions & Devices ─────────────────────────────────────────────────────
// AYZEN's Mail/Vault/Finance/Marketplace surfaces are all one SPA sharing a
// single login token — so "single sign-on across AYZEN" already happens
// automatically the moment you log in once. This panel is what makes that
// shared session *manageable*, the same way Google's "Manage your devices"
// page works: see every device currently signed in to the account, and
// revoke one (e.g. a lost phone) or everything-but-this-device, without
// touching the account password.
interface AccountSession {
  id: number;
  deviceLabel: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function SessionsPanel({ token }: { token: string }) {
  const { toast } = useToast();
  const { logout } = useAuth() as any;
  const [, navigate] = useLocation();
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setSessions(res.ok ? (data.sessions ?? []) : []);
    } catch { setSessions([]); }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleRevoke = async (s: AccountSession) => {
    setRevokingId(s.id);
    try {
      const res = await fetch(`${BASE}/api/auth/sessions/${s.id}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({ variant: "destructive", title: "Could not sign out that session", description: data.error });
        setRevokingId(null);
        return;
      }
      if (s.isCurrent) {
        // Revoking the session you're using right now — mirror what
        // happened on the server by ending the local session too, instead
        // of leaving a stale "logged in" UI that 401s on the next request.
        toast({ title: "Signed out of this device" });
        logout();
        navigate("/login");
        return;
      }
      toast({ title: "Device signed out" });
      load();
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setRevokingId(null);
  };

  const handleRevokeOthers = async () => {
    setRevokingOthers(true);
    try {
      const res = await fetch(`${BASE}/api/auth/sessions/revoke-others`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ variant: "destructive", title: "Failed", description: data.error });
      } else {
        toast({ title: `Signed out of ${data.revoked ?? "other"} other session${data.revoked === 1 ? "" : "s"}` });
        load();
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setRevokingOthers(false);
  };

  const otherCount = sessions.filter(s => !s.isCurrent).length;

  return (
    <Panel
      title="Sessions & Devices"
      sub="Every device currently signed in to your AYZEN account — one login covers Mail, Vault, Finance, and Marketplace"
      icon={Monitor}
    >
      <div className="space-y-4 max-w-xl">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-mono"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
        ) : sessions.length === 0 ? (
          <div className="bg-muted/20 border border-border/30 rounded-lg p-3 text-xs font-mono text-muted-foreground">
            No active sessions found.
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3 bg-muted/10 border border-border/30 rounded-md px-3 py-2.5">
                <Monitor className="w-4 h-4 text-primary flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-foreground truncate flex items-center gap-2">
                    {s.deviceLabel}
                    {s.isCurrent && (
                      <Badge variant="outline" className="text-[9px] font-mono border-primary/40 text-primary py-0 px-1.5">
                        This device
                      </Badge>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>Active {timeAgo(s.lastSeenAt)}</span>
                    {s.ip && (
                      <span className="flex items-center gap-0.5"><MapPin className="w-2.5 h-2.5" />{s.ip}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(s)}
                  disabled={revokingId === s.id}
                  className="text-muted-foreground hover:text-red-400 flex-shrink-0 disabled:opacity-50"
                  title={s.isCurrent ? "Sign out this device" : "Sign out this device"}
                >
                  {revokingId === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
                </button>
              </div>
            ))}
          </div>
        )}

        <Button
          variant="outline"
          onClick={handleRevokeOthers}
          disabled={revokingOthers || otherCount === 0}
          className="font-mono text-xs gap-2 h-10 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
        >
          {revokingOthers ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
          Sign out of all other sessions{otherCount > 0 ? ` (${otherCount})` : ""}
        </Button>
      </div>
    </Panel>
  );
}


// Passkeys double as Vault re-auth step 1, so creating/removing one is now
// gated by the Vault Security PIN too — see vault-security.tsx's identical
// PasskeysCard and lib/vault-pin-guard.ts on the backend. The prompt is
// skipped until that PIN has ever been set (askVaultPin(pinSetupDone)) so
// this stays a no-op for accounts that haven't gone through Vault →
// Security's setup wizard yet.
function PasskeysPanel({ token }: { token: string }) {
  const { toast } = useToast();
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pinSetupDone, setPinSetupDone] = useState(false);
  const supported = browserSupportsWebAuthn();
  const vaultPinPrompt = useVaultPinPrompt();

  const load = useCallback(async () => {
    setLoading(true);
    try { setPasskeys(await listPasskeys(token)); } catch { setPasskeys([]); }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    getVaultSecurityStatus().then(s => setPinSetupDone(s.vaultPinMandatorySetupDone)).catch(() => {});
  }, []);

  const handleAdd = async () => {
    setRegistering(true);
    try {
      const vaultPin = await vaultPinPrompt.askVaultPin(pinSetupDone);
      const label = typeof navigator !== "undefined" && /iphone|ipad/i.test(navigator.userAgent) ? "iPhone"
        : /android/i.test(navigator.userAgent) ? "Android device"
        : /mac/i.test(navigator.userAgent) ? "Mac" : "This device";
      await registerPasskey(token, label, vaultPin);
      toast({ title: "✅ Passkey added" });
      load();
    } catch (e: any) {
      if (e?.name !== "NotAllowedError" && e?.message !== "cancelled") {
        toast({ variant: "destructive", title: "Could not add passkey", description: e.message });
      }
    }
    setRegistering(false);
  };

  const handleRename = async (id: number) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    try {
      await renamePasskey(token, id, renameValue.trim());
      setRenamingId(null);
      load();
    } catch (e: any) { toast({ variant: "destructive", title: "Rename failed", description: e.message }); }
  };

  const handleDelete = async (id: number) => {
    try {
      const vaultPin = await vaultPinPrompt.askVaultPin(pinSetupDone);
      await deletePasskey(token, id, vaultPin);
      toast({ title: "Passkey removed" });
      load();
    } catch (e: any) {
      if (e?.message !== "cancelled") toast({ variant: "destructive", title: "Failed", description: e.message });
    }
  };

  return (
    <Panel title="Passkeys" sub="Sign in with your device's fingerprint, face, or screen lock — no password needed" icon={Fingerprint}>
      {!supported ? (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2 max-w-md">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs font-mono text-amber-400">This browser doesn't support passkeys.</p>
        </div>
      ) : (
        <div className="space-y-4 max-w-md">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs font-mono"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
          ) : passkeys.length === 0 ? (
            <div className="bg-muted/20 border border-border/30 rounded-lg p-3 text-xs font-mono text-muted-foreground">
              No passkeys yet. Add one to sign in without a password.
            </div>
          ) : (
            <div className="space-y-2">
              {passkeys.map((pk) => (
                <div key={pk.id} className="flex items-center gap-3 bg-muted/10 border border-border/30 rounded-md px-3 py-2.5">
                  <Fingerprint className="w-4 h-4 text-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    {renamingId === pk.id ? (
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleRename(pk.id)}
                        onBlur={() => handleRename(pk.id)}
                        className="h-7 text-xs font-mono bg-input border-border"
                      />
                    ) : (
                      <div className="font-mono text-xs text-foreground truncate">{pk.name}</div>
                    )}
                    <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                      {pk.lastUsedAt ? `Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}` : `Added ${new Date(pk.createdAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <button
                    onClick={() => { setRenamingId(pk.id); setRenameValue(pk.name); }}
                    className="text-muted-foreground hover:text-primary flex-shrink-0"
                    title="Rename"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(pk.id)}
                    className="text-muted-foreground hover:text-red-400 flex-shrink-0"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Button onClick={handleAdd} disabled={registering} className="font-mono text-xs gap-2 h-10">
            {registering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Add Passkey
          </Button>
        </div>
      )}
      {vaultPinPrompt.element}
    </Panel>
  );
}

// ─── 2FA / TOTP ────────────────────────────────────────────────────────────────
function TwoFactorPanel({ token }: { token: string }) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupData, setSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/security/2fa/status`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      setEnabled(!!d.enabled);
    } catch { setEnabled(false); }
    setLoading(false);
  }, [token]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const startSetup = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${BASE}/api/security/2fa/setup`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setSetupData(d);
    } catch (e: any) { toast({ variant: "destructive", title: "Setup failed", description: e.message }); }
    setBusy(false);
  };

  const confirmSetup = async () => {
    if (verifyCode.trim().length !== 6) { toast({ variant: "destructive", title: "Enter the 6-digit code" }); return; }
    setBusy(true);
    try {
      const r = await fetch(`${BASE}/api/security/2fa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ token: verifyCode.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "✅ 2FA enabled", description: "Your account now requires an authenticator code." });
      setEnabled(true);
      setSetupData(null);
      setVerifyCode("");
    } catch (e: any) { toast({ variant: "destructive", title: "Verification failed", description: e.message }); }
    setBusy(false);
  };

  const disable2fa = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${BASE}/api/security/2fa/disable`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "2FA disabled" });
      setEnabled(false);
    } catch (e: any) { toast({ variant: "destructive", title: "Failed", description: e.message }); }
    setBusy(false);
  };

  return (
    <Panel title="Two-Factor Authentication" sub="Protect your account with a TOTP authenticator app" icon={QrCode}>
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs font-mono"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
      ) : enabled ? (
        <div className="space-y-4 max-w-md">
          <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-md px-4 py-3 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
            <div>
              <div className="font-mono text-sm text-emerald-400 font-medium">2FA is active</div>
              <div className="font-mono text-xs text-muted-foreground mt-0.5">Codes are required from your authenticator app.</div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="font-mono text-xs border-red-500/20 text-red-400 hover:bg-red-500/10 hover:border-red-500/30 gap-2"
            onClick={disable2fa}
            disabled={busy}
          >
            <XCircle className="w-3.5 h-3.5" />
            {busy ? "Disabling..." : "Disable 2FA"}
          </Button>
        </div>
      ) : setupData ? (
        <div className="space-y-4 max-w-md">
          <div className="flex flex-col items-center gap-3 bg-muted/20 border border-border/30 rounded-lg p-4">
            <img src={setupData.qrDataUrl} alt="2FA QR code" className="w-40 h-40 rounded-md bg-white p-2" />
            <p className="text-[10px] font-mono text-muted-foreground text-center">Scan with Google Authenticator, Authy, or any TOTP app</p>
            <div className="flex items-center gap-2 bg-background border border-border/40 rounded px-3 py-1.5">
              <span className="font-mono text-xs tracking-widest text-primary">{setupData.secret}</span>
              <button onClick={() => { navigator.clipboard.writeText(setupData.secret); toast({ title: "Copied!" }); }} className="text-muted-foreground hover:text-primary">
                <Copy className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Enter 6-digit code to confirm</label>
            <div className="flex gap-2">
              <Input
                value={verifyCode}
                onChange={e => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                maxLength={6}
                className="font-mono tracking-[0.4em] text-center text-lg h-11 bg-input border-border focus-visible:ring-primary/50 focus-visible:border-primary max-w-[160px]"
                onKeyDown={e => e.key === "Enter" && confirmSetup()}
              />
              <Button onClick={confirmSetup} disabled={busy || verifyCode.length !== 6} className="font-mono text-xs h-11">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Confirm & Enable"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4 max-w-md">
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs font-mono text-amber-400">2FA is not enabled. Add an extra layer of protection.</p>
          </div>
          <Button onClick={startSetup} disabled={busy} className="font-mono text-xs gap-2 h-10">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Smartphone className="w-3.5 h-3.5" />}
            Set Up 2FA
          </Button>
        </div>
      )}
    </Panel>
  );
}

// ─── Backup Codes ───────────────────────────────────────────────────────────────
function BackupCodesPanel({ token }: { token: string }) {
  const { toast } = useToast();
  const [backupCodes, setBackupCodes] = useState<{ id: number; code: string; is_used: boolean }[]>([]);
  const [genLoading, setGenLoading] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const loadCodes = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/security/backup-codes`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setBackupCodes(await r.json());
    } catch { }
  }, [token]);

  useEffect(() => { loadCodes(); }, [loadCodes]);

  const generateBackupCodes = async () => {
    setGenLoading(true);
    try {
      const r = await fetch(`${BASE}/api/security/backup-codes/generate`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "✅ 10 backup codes generated! Save them now." });
      await loadCodes();
      setRevealed(true);
    } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
    setGenLoading(false);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => toast({ title: "Copied!" })).catch(() => {});
  };
  const copyAllBackupCodes = () => copyToClipboard(unusedBackup.map(c => c.code).join("\n"));

  const unusedBackup = backupCodes.filter(c => !c.is_used);
  const usedBackup = backupCodes.filter(c => c.is_used);

  return (
    <Panel title="Backup Codes" sub="One-time codes to access your account if you lose access" icon={Key}>
      <div className="space-y-4">
        {unusedBackup.length === 0 && backupCodes.length === 0 && (
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs font-mono text-amber-400">No backup codes yet. Generate them to protect your account.</p>
          </div>
        )}
        {unusedBackup.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Active Codes ({unusedBackup.length})</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setRevealed(r => !r)} className="h-7 text-xs gap-1">
                  {revealed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />} {revealed ? "Hide" : "Show"}
                </Button>
                <Button variant="ghost" size="sm" onClick={copyAllBackupCodes} className="h-7 text-xs gap-1">
                  <Copy className="w-3 h-3" /> Copy All
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5 max-w-md">
              {unusedBackup.map(c => (
                <div key={c.id} className="flex items-center gap-2 bg-muted/30 border border-border/30 rounded-lg px-3 py-2">
                  <span className={cn("font-mono text-xs font-bold flex-1 tracking-widest transition-all", revealed ? "text-primary" : "text-muted-foreground/30 blur-sm")}>
                    {c.code}
                  </span>
                  <button onClick={() => copyToClipboard(c.code)} className="text-muted-foreground hover:text-primary flex-shrink-0">
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
            {usedBackup.length > 0 && (
              <p className="text-[10px] font-mono text-muted-foreground/40">{usedBackup.length} code{usedBackup.length > 1 ? "s" : ""} already used</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" onClick={generateBackupCodes} disabled={genLoading} className="text-xs gap-1.5 h-9">
            {genLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
            {backupCodes.length > 0 ? "Regenerate Codes" : "Generate 10 Codes"}
          </Button>
          {backupCodes.length > 0 && (
            <p className="text-[10px] font-mono text-muted-foreground/50">Regenerating will invalidate existing unused codes.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ─── Magic Codes ────────────────────────────────────────────────────────────────
function MagicCodesPanel({ token }: { token: string }) {
  const { toast } = useToast();
  const [magicCodes, setMagicCodes] = useState<{ id: number; code: string; label?: string; is_used: boolean; expires_at?: string }[]>([]);
  const [magicLoading, setMagicLoading] = useState(false);
  const [magicLabel, setMagicLabel] = useState("");

  const loadCodes = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/security/magic-codes`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setMagicCodes(await r.json());
    } catch { }
  }, [token]);

  useEffect(() => { loadCodes(); }, [loadCodes]);

  const createMagicCode = async () => {
    setMagicLoading(true);
    try {
      const r = await fetch(`${BASE}/api/security/magic-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: magicLabel.trim() || "Magic Code" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "Magic code created!" });
      setMagicLabel("");
      await loadCodes();
    } catch (e: any) { toast({ title: e.message, variant: "destructive" }); }
    setMagicLoading(false);
  };

  const deleteMagicCode = async (id: number) => {
    try {
      await fetch(`${BASE}/api/security/magic-codes/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      setMagicCodes(prev => prev.filter(c => c.id !== id));
      toast({ title: "Code deleted" });
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => toast({ title: "Copied!" })).catch(() => {});
  };

  return (
    <Panel title="Magic Login Codes" sub="One-time codes for instant login — share with trusted devices" icon={Zap}>
      <div className="space-y-4 max-w-md">
        <div className="flex gap-2">
          <Input
            value={magicLabel}
            onChange={e => setMagicLabel(e.target.value)}
            placeholder="Label (e.g. Phone, Office PC)"
            className="font-mono text-xs h-9 flex-1"
            onKeyDown={e => e.key === "Enter" && createMagicCode()}
          />
          <Button size="sm" onClick={createMagicCode} disabled={magicLoading} className="text-xs gap-1 h-9">
            {magicLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Create
          </Button>
        </div>
        {magicCodes.length === 0 ? (
          <p className="text-xs font-mono text-muted-foreground/40">No magic codes yet. Create one to enable one-tap login.</p>
        ) : (
          <div className="space-y-2">
            {magicCodes.map(c => (
              <div key={c.id} className={cn(
                "flex items-center gap-3 p-3 rounded-lg border",
                c.is_used ? "bg-muted/10 border-border/20 opacity-50" : "bg-muted/20 border-border/40"
              )}>
                <Zap className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs font-bold text-foreground">{c.label || "Magic Code"}</div>
                  <div className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">
                    {c.is_used ? "Used" : c.expires_at ? `Expires ${new Date(c.expires_at).toLocaleDateString()}` : "No expiry"}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {!c.is_used && (
                    <button onClick={() => copyToClipboard(c.code)} className="p-1.5 rounded hover:bg-muted/40 text-muted-foreground hover:text-primary">
                      <Copy className="w-3 h-3" />
                    </button>
                  )}
                  <button onClick={() => deleteMagicCode(c.id)} className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="bg-muted/20 border border-border/30 rounded-lg p-3">
          <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed">
            Magic codes are single-use. Share one with a trusted device for instant login without password.
            Use them carefully — anyone with the code can log in to your account.
          </p>
        </div>
      </div>
    </Panel>
  );
}

// ─── Recovery Email ─────────────────────────────────────────────────────────────
function RecoveryEmailPanel({ token, user }: { token: string; user: any }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/security/recovery-email`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      setSaved(d.recoveryEmail ?? null);
      setEmail(d.recoveryEmail ?? "");
    } catch { }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/security/recovery-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: email.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "✅ Recovery email updated" });
      setSaved(d.recoveryEmail);
    } catch (e: any) { toast({ variant: "destructive", title: "Failed", description: e.message }); }
    setSaving(false);
  };

  const remove = async () => {
    setEmail("");
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/security/recovery-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: "" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "Recovery email removed" });
      setSaved(null);
    } catch (e: any) { toast({ variant: "destructive", title: "Failed", description: e.message }); }
    setSaving(false);
  };

  return (
    <Panel title="Recovery Email" sub="A secondary email used to help you regain access to your account" icon={Mail}>
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs font-mono"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
      ) : (
        <div className="max-w-md space-y-4">
          {saved && (
            <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-md px-4 py-3 flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
              <div>
                <div className="font-mono text-sm text-emerald-400 font-medium">Recovery email set</div>
                <div className="font-mono text-xs text-muted-foreground mt-0.5">{saved}</div>
              </div>
            </div>
          )}
          <div className="space-y-2">
            <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Recovery Email Address</label>
            <Input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="font-mono h-10 text-sm bg-input border-border focus-visible:ring-primary/50"
            />
            <p className="text-[10px] font-mono text-muted-foreground/50">Must be different from your primary login email ({user?.email ?? "—"}).</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || !email.trim() || email.trim() === saved} className="font-mono text-xs gap-2 h-10">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
              Save
            </Button>
            {saved && (
              <Button variant="outline" onClick={remove} disabled={saving} className="font-mono text-xs gap-2 h-10 border-red-500/20 text-red-400 hover:bg-red-500/10">
                <Trash2 className="w-3.5 h-3.5" /> Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ─── Developer API Keys ─────────────────────────────────────────────────────────
interface ApiKeyRow {
  id: number;
  name: string;
  keyPrefix: string;
  type: "full" | "scoped";
  scopes?: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}
interface ApiScope { id: string; label: string; }

function ApiKeysPanel({ token }: { token: string }) {
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"full" | "scoped">("scoped");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [showScopePicker, setShowScopePicker] = useState(false);
  const [justCreated, setJustCreated] = useState<{ id: number; key: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [keysRes, scopesRes] = await Promise.all([
        fetch(`${BASE}/api/api-keys`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${BASE}/api/api-keys/scopes`),
      ]);
      const keysData = await keysRes.json();
      const scopesData = await scopesRes.json();
      if (keysRes.ok) setKeys(keysData.keys ?? []);
      if (scopesRes.ok) setScopes(scopesData.scopes ?? []);
    } catch { toast({ variant: "destructive", title: "Failed to load API keys" }); }
    setLoading(false);
  }, [token, toast]);

  useEffect(() => { load(); }, [load]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => toast({ title: "Copied!" })).catch(() => {});
  };

  const createKey = async () => {
    const name = newName.trim();
    if (!name) { toast({ variant: "destructive", title: "Name required" }); return; }
    if (newType === "scoped" && selectedScopes.length === 0) {
      toast({ variant: "destructive", title: "Pick at least one scope", description: "Or switch to a full-access key." });
      return;
    }
    setCreating(true);
    try {
      const r = await fetch(`${BASE}/api/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, type: newType, scopes: newType === "scoped" ? selectedScopes : undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "✅ API key created", description: "Copy it now — it won't be shown again." });
      setJustCreated({ id: d.id, key: d.key });
      setNewName(""); setSelectedScopes([]);
      await load();
    } catch (e: any) { toast({ variant: "destructive", title: "Failed to create key", description: e.message }); }
    setCreating(false);
  };

  const rotateKey = async (id: number) => {
    setBusyId(id);
    try {
      const r = await fetch(`${BASE}/api/api-keys/${id}/rotate`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast({ title: "Key rotated", description: "The old key stopped working. Copy the new one now." });
      setJustCreated({ id: d.id, key: d.key });
      await load();
    } catch (e: any) { toast({ variant: "destructive", title: "Rotate failed", description: e.message }); }
    setBusyId(null);
  };

  const revokeKey = async (id: number) => {
    setBusyId(id);
    try {
      const r = await fetch(`${BASE}/api/api-keys/${id}/revoke`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json()).error);
      toast({ title: "Key revoked" });
      await load();
    } catch (e: any) { toast({ variant: "destructive", title: "Revoke failed", description: e.message }); }
    setBusyId(null);
  };

  const deleteKey = async (id: number) => {
    setBusyId(id);
    try {
      const r = await fetch(`${BASE}/api/api-keys/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json()).error);
      toast({ title: "Key deleted" });
      if (justCreated?.id === id) setJustCreated(null);
      await load();
    } catch (e: any) { toast({ variant: "destructive", title: "Delete failed", description: e.message }); }
    setBusyId(null);
  };

  const toggleScope = (id: string) => setSelectedScopes(p => p.includes(id) ? p.filter(s => s !== id) : [...p, id]);

  return (
    <Panel
      title="Developer API Keys"
      sub="Call the AYZEN API from your own bots/scripts with Authorization: Bearer <key> — no login session needed"
      icon={Terminal}
    >
      <div className="space-y-6 max-w-2xl">
        {justCreated && (
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-emerald-400 font-mono text-xs font-bold">
              <CheckCircle2 className="w-4 h-4" /> Save this key now — it won't be shown again
            </div>
            <div className="flex items-center gap-2 bg-background border border-border/40 rounded px-3 py-2 overflow-x-auto">
              <code className="font-mono text-xs text-primary whitespace-nowrap">{justCreated.key}</code>
              <button onClick={() => copyToClipboard(justCreated.key)} className="ml-auto text-muted-foreground hover:text-primary flex-shrink-0">
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground/60">
              Use it as <code className="text-primary/80">Authorization: Bearer {"<key>"}</code> against any existing AYZEN API endpoint your account can already reach.
            </p>
          </div>
        )}

        {/* ── Create a new key ─────────────────────────────────────────── */}
        <div className="bg-muted/10 border border-border/30 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Key name (e.g. Telegram Bot)"
              className="font-mono text-xs h-9 flex-1"
            />
            <Button size="sm" onClick={createKey} disabled={creating} className="text-xs gap-1.5 h-9 flex-shrink-0">
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setNewType("scoped")}
              className={cn(
                "px-2.5 py-1 rounded font-mono text-[10px] uppercase tracking-wider border transition-all",
                newType === "scoped" ? "border-primary/40 bg-primary/10 text-primary font-bold" : "border-border/30 text-muted-foreground/50"
              )}
            >
              Scoped (recommended)
            </button>
            <button
              onClick={() => setNewType("full")}
              className={cn(
                "px-2.5 py-1 rounded font-mono text-[10px] uppercase tracking-wider border transition-all",
                newType === "full" ? "border-amber-400/40 bg-amber-400/10 text-amber-400 font-bold" : "border-border/30 text-muted-foreground/50"
              )}
            >
              Full access
            </button>
            {newType === "scoped" && (
              <button onClick={() => setShowScopePicker(p => !p)} className="ml-auto flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-primary">
                {selectedScopes.length > 0 ? `${selectedScopes.length} scope${selectedScopes.length > 1 ? "s" : ""} selected` : "Pick scopes"}
                {showScopePicker ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            )}
          </div>
          {newType === "full" && (
            <p className="text-[10px] font-mono text-amber-400/80">Full-access keys can do anything your account can. Prefer a scoped key when possible.</p>
          )}
          {newType === "scoped" && showScopePicker && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto pr-1">
              {scopes.map(s => (
                <label key={s.id} className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground hover:text-foreground cursor-pointer">
                  <input type="checkbox" checked={selectedScopes.includes(s.id)} onChange={() => toggleScope(s.id)} className="accent-primary" />
                  {s.label}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* ── Existing keys ────────────────────────────────────────────── */}
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-mono"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>
        ) : keys.length === 0 ? (
          <p className="text-xs font-mono text-muted-foreground/40">No API keys yet. Create one above to call the AYZEN API from a bot or script.</p>
        ) : (
          <div className="space-y-2">
            {keys.map(k => (
              <div key={k.id} className={cn(
                "flex items-center gap-3 p-3 rounded-lg border",
                k.revoked ? "bg-muted/10 border-border/20 opacity-50" : "bg-muted/20 border-border/40"
              )}>
                <Terminal className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs font-bold text-foreground flex items-center gap-2">
                    {k.name}
                    <Badge variant="outline" className={cn(
                      "font-mono text-[8px] px-1 py-0",
                      k.type === "full" ? "text-amber-400 border-amber-400/30" : "text-primary border-primary/30"
                    )}>
                      {k.type}
                    </Badge>
                    {k.revoked && <Badge variant="outline" className="font-mono text-[8px] px-1 py-0 text-red-400 border-red-400/30">revoked</Badge>}
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">
                    {k.keyPrefix}••••••• · {k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "never used"}
                  </div>
                  {k.type === "scoped" && k.scopes && k.scopes.length > 0 && (
                    <div className="text-[9px] font-mono text-muted-foreground/40 mt-0.5 truncate">{k.scopes.join(", ")}</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {!k.revoked && (
                    <>
                      <button onClick={() => rotateKey(k.id)} disabled={busyId === k.id} title="Rotate" className="p-1.5 rounded hover:bg-muted/40 text-muted-foreground hover:text-primary disabled:opacity-40">
                        <RefreshCw className="w-3 h-3" />
                      </button>
                      <button onClick={() => revokeKey(k.id)} disabled={busyId === k.id} title="Revoke" className="p-1.5 rounded hover:bg-amber-500/10 text-muted-foreground hover:text-amber-400 disabled:opacity-40">
                        <Ban className="w-3 h-3" />
                      </button>
                    </>
                  )}
                  <button onClick={() => deleteKey(k.id)} disabled={busyId === k.id} title="Delete" className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 disabled:opacity-40">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="bg-muted/20 border border-border/30 rounded-lg p-3">
          <p className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed">
            Creating, renaming, rotating, and revoking keys always requires a real login session — a leaked key can never be used to mint itself more access.
            Full-access keys share your account's own access; scoped keys are limited to the features you pick. Max 20 active keys.
          </p>
        </div>
      </div>
    </Panel>
  );
}
