import { useState, useRef } from "react";
import { usePlugins, type Plugin } from "@/hooks/use-plugins";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  FolderGit2, CheckSquare, Vault, Wallet, Mail, AtSign, ShieldCheck,
  Trophy, Share2, HelpCircle, Send, Zap, Radio, Puzzle, Settings,
  Loader2, ChevronRight, Download, Upload, RefreshCw,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface PluginDef {
  slug: string;
  name: string;
  description: string;
  icon: React.ElementType;
  category: string;
  configFields?: { key: string; label: string; placeholder: string; type?: string }[];
}

const PLUGIN_DEFS: PluginDef[] = [
  { slug: "projects",      name: "Projects",          icon: FolderGit2,   category: "Core Protocols",    description: "Airdrop project management and tracking dashboard" },
  { slug: "tasks",         name: "Tasks",             icon: CheckSquare,  category: "Core Protocols",    description: "Task submission, verification, and reward system" },
  { slug: "vault",         name: "Vault",             icon: Vault,        category: "Core Protocols",    description: "Encrypted credential storage for identities and wallets" },
  { slug: "wallets",       name: "Wallets",           icon: Wallet,       category: "Tools & Assets",    description: "Multi-chain wallet address manager" },
  { slug: "email-manager", name: "Email Manager",     icon: Mail,         category: "Tools & Assets",    description: "IMAP/SMTP multi-account email client" },
  { slug: "ayzen-email",   name: "AYZEN Email",       icon: AtSign,       category: "Tools & Assets",    description: "Platform email aliases and smart routing" },
  { slug: "authenticator", name: "2FA Authenticator", icon: ShieldCheck,  category: "Tools & Assets",    description: "TOTP code generator for 2FA accounts" },
  { slug: "leaderboard",   name: "Leaderboard",       icon: Trophy,       category: "Social & Growth",   description: "User rankings and points leaderboard" },
  { slug: "referrals",     name: "Referrals",         icon: Share2,       category: "Social & Growth",   description: "Referral program with reward tracking" },
  { slug: "support",       name: "Support",           icon: HelpCircle,   category: "Social & Growth",   description: "Help desk and support ticket system" },
  { slug: "broadcast",     name: "Broadcast",         icon: Radio,        category: "Platform Services", description: "Send platform-wide announcements to all users" },
  {
    slug: "telegram", name: "Telegram Bot", icon: Send, category: "Integrations",
    description: "Bot notifications, command handling, and user linking via Telegram",
    configFields: [
      { key: "botToken",    label: "Bot Token",     placeholder: "123456789:AAF..." },
      { key: "webhookUrl",  label: "Webhook URL",   placeholder: "https://your-domain/api/telegram/webhook" },
      { key: "botUsername", label: "Bot Username",  placeholder: "@YourBot" },
    ],
  },
  {
    slug: "firebase", name: "Firebase Auth", icon: Zap, category: "Integrations",
    description: "Enable Google and social login via Firebase Authentication",
    configFields: [
      { key: "projectId",  label: "Project ID",   placeholder: "my-firebase-project" },
      { key: "apiKey",     label: "Web API Key",  placeholder: "AIzaSy..." },
      { key: "authDomain", label: "Auth Domain",  placeholder: "project.firebaseapp.com" },
    ],
  },
  {
    slug: "smtp", name: "SMTP Email", icon: Mail, category: "Platform Services",
    description: "Platform transactional email via custom SMTP server",
    configFields: [
      { key: "host",     label: "SMTP Host", placeholder: "smtp.gmail.com" },
      { key: "port",     label: "Port",      placeholder: "587" },
      { key: "user",     label: "Username",  placeholder: "noreply@domain.com" },
      { key: "password", label: "Password",  placeholder: "App password", type: "password" },
    ],
  },
  {
    slug: "cloudflare-email", name: "Cloudflare Email", icon: AtSign, category: "Integrations",
    description: "Route inbound emails via Cloudflare Email Routing to AYZEN platform addresses",
    configFields: [
      { key: "apiKey",        label: "Cloudflare API Key",  placeholder: "CF API key with Email Routing permissions" },
      { key: "zoneId",        label: "Zone ID",             placeholder: "Zone ID from Cloudflare dashboard" },
      { key: "domain",        label: "Email Domain",        placeholder: "ayzen.tech" },
      { key: "routeEmail",    label: "Forward-to Email",    placeholder: "support@yourdomain.com" },
    ],
  },
];

const CATEGORIES = ["Core Protocols", "Tools & Assets", "Social & Growth", "Integrations", "Platform Services"];

function PluginCard({ def, plugin, onToggle, onConfigure }: {
  def: PluginDef;
  plugin: Plugin | undefined;
  onToggle: (slug: string, enabled: boolean) => void;
  onConfigure: (def: PluginDef) => void;
}) {
  const enabled = plugin ? plugin.enabled : true;
  const Icon = def.icon;
  const [toggling, setToggling] = useState(false);

  const handleToggle = async (v: boolean) => {
    setToggling(true);
    await onToggle(def.slug, v);
    setToggling(false);
  };

  return (
    <Card className="bg-card border-card-border shadow-none hover:border-primary/30 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded border shrink-0 ${enabled ? "bg-primary/10 border-primary/30 text-primary" : "bg-muted/30 border-border text-muted-foreground"}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-mono font-semibold text-sm">{def.name}</span>
              <Badge variant={enabled ? "default" : "secondary"} className="text-[9px] px-1.5 py-0 h-4 font-mono">
                {enabled ? "ACTIVE" : "DISABLED"}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">{def.description}</p>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0 ml-2">
            {toggling
              ? <Loader2 className="w-4 h-4 animate-spin text-primary" />
              : <Switch checked={enabled} onCheckedChange={handleToggle} className="scale-90" />
            }
            {def.configFields && (
              <button
                onClick={() => onConfigure(def)}
                className="text-[10px] font-mono text-muted-foreground hover:text-primary flex items-center gap-0.5 transition-colors"
              >
                <Settings className="w-3 h-3" /> Config <ChevronRight className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfigModal({ def, plugin, onClose, onSave }: {
  def: PluginDef;
  plugin: Plugin | undefined;
  onClose: () => void;
  onSave: (slug: string, config: Record<string, unknown>) => Promise<void>;
}) {
  const existingConfig = (() => {
    try { return plugin?.config ? JSON.parse(plugin.config) : {}; }
    catch { return {}; }
  })();
  const [form, setForm] = useState<Record<string, string>>(existingConfig);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(def.slug, form);
      toast({ title: `${def.name} configuration saved` });
      onClose();
    } catch {
      toast({ variant: "destructive", title: "Failed to save configuration" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="bg-card border-card-border font-mono max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm uppercase tracking-widest flex items-center gap-2">
            <Settings className="w-4 h-4 text-primary" /> Configure {def.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          {def.configFields?.map(field => (
            <div key={field.key} className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">{field.label}</Label>
              <Input
                type={field.type ?? "text"}
                value={form[field.key] ?? ""}
                onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                className="font-mono text-xs h-9 bg-input border-border"
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" size="sm" onClick={onClose} className="font-mono text-xs">Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="font-mono text-xs gap-1.5">
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            Save Config
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminPlugins() {
  const { plugins, isLoading, toggle, updateConfig } = usePlugins();
  const { token } = useAuth();
  const [configuringDef, setConfiguringDef] = useState<PluginDef | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleToggle = async (slug: string, enabled: boolean) => {
    await toggle(slug, enabled);
    const def = PLUGIN_DEFS.find(d => d.slug === slug);
    toast({
      title: `${def?.name ?? slug} ${enabled ? "enabled" : "disabled"}`,
      description: enabled ? "Plugin is now active for all users" : "Plugin is hidden from user navigation",
    });
  };

  // Export all plugin configs as a JSON file
  const handleExport = async () => {
    try {
      const res = await fetch(`${BASE}/api/admin/plugins`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch plugins");
      const data = await res.json();
      const blob = new Blob([JSON.stringify({ version: 1, exported: new Date().toISOString(), plugins: data }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ayzen-plugins-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Plugins exported", description: "JSON configuration file downloaded." });
    } catch {
      toast({ variant: "destructive", title: "Export failed" });
    }
  };

  // Import plugin configs from a JSON file
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const pluginsToImport: any[] = parsed.plugins ?? (Array.isArray(parsed) ? parsed : []);
      if (!pluginsToImport.length) {
        toast({ variant: "destructive", title: "No plugins found in file" }); return;
      }

      let applied = 0;
      for (const p of pluginsToImport) {
        if (!p.slug) continue;
        const payload: Record<string, unknown> = {};
        if (p.enabled !== undefined) payload.enabled = p.enabled;
        if (p.config) payload.config = p.config;
        if (Object.keys(payload).length === 0) continue;

        const r = await fetch(`${BASE}/api/admin/plugins/${p.slug}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        if (r.ok) applied++;
      }

      toast({ title: `Imported ${applied} plugin config${applied !== 1 ? "s" : ""}`, description: "Reload to see changes." });
    } catch {
      toast({ variant: "destructive", title: "Import failed — invalid JSON file" });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (isLoading) return (
    <div className="flex items-center justify-center h-48 text-muted-foreground font-mono text-xs">
      <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading modules...
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Puzzle className="w-6 h-6 text-primary" /> Plugin Manager
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">
            Enable, disable, and configure platform modules. Import or export plugin configs as JSON.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="font-mono text-xs gap-2"
          >
            {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Import JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            className="font-mono text-xs gap-2"
          >
            <Download className="w-3.5 h-3.5" />
            Export JSON
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Total Modules", value: PLUGIN_DEFS.length },
          { label: "Active", value: PLUGIN_DEFS.filter(d => (plugins.find(p => p.slug === d.slug)?.enabled ?? true)).length },
          { label: "Disabled", value: PLUGIN_DEFS.filter(d => !(plugins.find(p => p.slug === d.slug)?.enabled ?? true)).length },
        ].map(({ label, value }) => (
          <Card key={label} className="bg-card border-card-border shadow-none">
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold font-mono text-primary">{value}</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-widest mt-0.5">{label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {CATEGORIES.map(category => {
        const defs = PLUGIN_DEFS.filter(d => d.category === category);
        return (
          <div key={category}>
            <h2 className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
              <span className="h-px flex-1 bg-border" />
              {category}
              <span className="h-px flex-1 bg-border" />
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {defs.map(def => (
                <PluginCard
                  key={def.slug}
                  def={def}
                  plugin={plugins.find(p => p.slug === def.slug)}
                  onToggle={handleToggle}
                  onConfigure={setConfiguringDef}
                />
              ))}
            </div>
          </div>
        );
      })}

      {configuringDef && (
        <ConfigModal
          def={configuringDef}
          plugin={plugins.find(p => p.slug === configuringDef.slug)}
          onClose={() => setConfiguringDef(null)}
          onSave={updateConfig}
        />
      )}
    </div>
  );
}
