import { Link } from "wouter";
import { useEffect, useRef, useState } from "react";
import { Terminal, Zap, ShieldCheck, Wallet, BarChart3, Mail, Bot, ArrowRight, ChevronRight, Globe, Lock, Layers, Users, Coins, TrendingUp, Star } from "lucide-react";
import { Button } from "@/components/ui/button";

const CHAIN_TICKER = ["ETH", "ARB", "OP", "BASE", "zkSync", "Linea", "Scroll", "Blast", "Polygon", "BNB", "Avax", "Celo", "Mode", "Manta", "zkEVM", "Taiko", "Starknet", "Sui", "SOL", "TON"];

function ChainTicker() {
  const items = [...CHAIN_TICKER, ...CHAIN_TICKER];
  return (
    <div className="relative overflow-hidden border-y border-primary/10 bg-background/50 py-2.5" style={{ maskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)" }}>
      <div className="flex gap-6 whitespace-nowrap" style={{ animation: "ticker 22s linear infinite" }}>
        {items.map((chain, i) => (
          <span key={i} className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary/40 flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-primary/30 inline-block" />
            {chain}
          </span>
        ))}
      </div>
    </div>
  );
}

function GlitchText({ text }: { text: string }) {
  const [glitch, setGlitch] = useState(false);
  useEffect(() => {
    const id = setInterval(() => { setGlitch(true); setTimeout(() => setGlitch(false), 140); }, 4500);
    return () => clearInterval(id);
  }, []);
  return (
    <span className={`relative inline-block transition-all${glitch ? " glitch-active" : ""}`} data-text={text}>{text}</span>
  );
}

function ScanLine() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-[1]">
      <div className="w-full h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent"
        style={{ animation: "scanLine 6s ease-in-out infinite", top: 0, position: "absolute" }} />
    </div>
  );
}

const features = [
  { icon: BarChart3, title: "Airdrop Intelligence", desc: "Track every project's ROI, task completion, and rewards in one unified dashboard. Never miss a claim again.", color: "text-cyan-400", glow: "shadow-[0_0_20px_rgba(34,211,238,0.08)]", border: "border-cyan-900/40" },
  { icon: Zap, title: "Task Automation Center", desc: "Complete Twitter follows, Discord joins, and on-chain interactions. Submit proofs and track status per project.", color: "text-violet-400", glow: "shadow-[0_0_20px_rgba(167,139,250,0.08)]", border: "border-violet-900/40" },
  { icon: Wallet, title: "Multi-Chain Wallet", desc: "Track wallets across 20+ blockchains. Built-in AZN & USDT wallet. Monitor gas, history, and on-chain footprint.", color: "text-cyan-400", glow: "shadow-[0_0_20px_rgba(34,211,238,0.08)]", border: "border-cyan-900/40" },
  { icon: Lock, title: "Encrypted Vault", desc: "Store seed phrases, private keys, and backup codes in your encrypted vault. AES-256 encrypted. Your keys, your control.", color: "text-violet-400", glow: "shadow-[0_0_20px_rgba(167,139,250,0.08)]", border: "border-violet-900/40" },
  { icon: Mail, title: "AYZEN Email", desc: "Get your own @ayzen.io email address. Forward airdrop confirmations, whitelist notices, and alerts.", color: "text-cyan-400", glow: "shadow-[0_0_20px_rgba(34,211,238,0.08)]", border: "border-cyan-900/40" },
  { icon: Users, title: "Team Collaboration", desc: "Form crews with shared vaults, team leaderboards, project tracking, and real-time team chat.", color: "text-violet-400", glow: "shadow-[0_0_20px_rgba(167,139,250,0.08)]", border: "border-violet-900/40" },
  { icon: Bot, title: "AI Airdrop Assistant", desc: "Ask our AI anything — which projects to prioritize, how to optimize gas, or what tasks are still pending.", color: "text-cyan-400", glow: "shadow-[0_0_20px_rgba(34,211,238,0.08)]", border: "border-cyan-900/40" },
  { icon: Coins, title: "AZN Token Economy", desc: "Earn AZN tokens by completing tasks and farming projects. Use AZN to unlock premium features and rewards.", color: "text-violet-400", glow: "shadow-[0_0_20px_rgba(167,139,250,0.08)]", border: "border-violet-900/40" },
];

const stats = [
  { value: "20+", label: "Blockchains Supported" },
  { value: "100%", label: "On-Chain Verified" },
  { value: "0", label: "Hidden Fees" },
  { value: "24/7", label: "Airdrop Monitoring" },
];

function useInView(ref: React.RefObject<Element | null>, threshold = 0.15) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setInView(true); }, { threshold });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [ref, threshold]);
  return inView;
}

function AnimSection({ children, className = "", delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref as any);
  return (
    <div ref={ref} className={className} style={{ opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(32px)", transition: `opacity 0.65s ease ${delay}ms, transform 0.65s ease ${delay}ms` }}>
      {children}
    </div>
  );
}

function Counter({ target, suffix = "" }: { target: number | string; suffix?: string }) {
  const [val, setVal] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref as any);
  const num = typeof target === "number" ? target : parseInt(target) || 0;
  useEffect(() => {
    if (!inView || typeof target === "string") return;
    let start = 0;
    const step = Math.ceil(num / 40);
    const timer = setInterval(() => { start = Math.min(start + step, num); setVal(start); if (start >= num) clearInterval(timer); }, 30);
    return () => clearInterval(timer);
  }, [inView, num, target]);
  const display = typeof target === "string" ? target : `${val}${suffix}`;
  return <div ref={ref} className="text-3xl font-mono font-bold text-primary mb-1">{display}</div>;
}

function HeroParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    let raf: number;
    const W = canvas.offsetWidth; const H = canvas.offsetHeight;
    canvas.width = W; canvas.height = H;
    const pts = Array.from({ length: 60 }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35, r: Math.random() * 1.4 + 0.3, a: Math.random() }));
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,255,255,${p.a * 0.4})`; ctx.fill();
      }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x; const dy = pts[i].y - pts[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 110) { ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.strokeStyle = `rgba(0,255,255,${(1 - dist / 110) * 0.07})`; ctx.lineWidth = 0.5; ctx.stroke(); }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}

function Typewriter({ texts }: { texts: string[] }) {
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    const target = texts[idx % texts.length];
    let timer: ReturnType<typeof setTimeout>;
    if (!deleting && text.length < target.length) { timer = setTimeout(() => setText(target.slice(0, text.length + 1)), 50); }
    else if (!deleting && text.length === target.length) { timer = setTimeout(() => setDeleting(true), 2200); }
    else if (deleting && text.length > 0) { timer = setTimeout(() => setText(text.slice(0, -1)), 25); }
    else if (deleting && text.length === 0) { setDeleting(false); setIdx(i => i + 1); }
    return () => clearTimeout(timer);
  }, [text, deleting, idx, texts]);
  return (
    <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-violet-500">
      {text}<span className="animate-pulse text-primary">|</span>
    </span>
  );
}

// ─── Token showcase ────────────────────────────────────────────────────────────
function TokenCard({ symbol, name, color, amount, change }: { symbol: string; name: string; color: string; amount: string; change: string }) {
  return (
    <div className={`bg-card border rounded-xl p-4 flex items-center gap-4 hover:scale-[1.02] transition-all duration-300 border-${color}-900/30`}>
      <div className={`w-10 h-10 rounded-full bg-${color}-500/10 border border-${color}-500/20 flex items-center justify-center font-mono font-bold text-${color}-400 text-sm flex-shrink-0`}>
        {symbol[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-sm font-bold text-foreground">{symbol}</div>
        <div className="font-mono text-[10px] text-muted-foreground">{name}</div>
      </div>
      <div className="text-right">
        <div className="font-mono text-sm font-bold text-foreground">{amount}</div>
        <div className={`font-mono text-[10px] text-emerald-400`}>{change}</div>
      </div>
    </div>
  );
}

// ─── Dashboard preview ─────────────────────────────────────────────────────────
function DashboardPreview() {
  return (
    <div className="relative bg-card border border-border/50 rounded-xl overflow-hidden shadow-2xl">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40 bg-muted/5">
        <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
        <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
        <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
        <div className="flex-1 mx-4">
          <div className="bg-muted/30 rounded-md h-5 w-40 mx-auto flex items-center justify-center">
            <span className="font-mono text-[9px] text-muted-foreground/50">app.ayzen.io/dashboard</span>
          </div>
        </div>
      </div>
      {/* Content */}
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Total ROI", value: "+$2,847", c: "text-emerald-400" },
            { label: "AZN Earned", value: "1,204 AZN", c: "text-cyan-400" },
            { label: "Projects", value: "14 Active", c: "text-violet-400" },
          ].map(s => (
            <div key={s.label} className="bg-muted/20 rounded-lg p-2.5 text-center">
              <div className={`font-mono text-sm font-bold ${s.c}`}>{s.value}</div>
              <div className="font-mono text-[9px] text-muted-foreground/50 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          {["Arbitrum Airdrop ✓", "zkSync Era Task +12 AZN", "Linea Mainnet ⏳"].map((t, i) => (
            <div key={i} className="flex items-center gap-2 bg-muted/10 rounded px-3 py-2">
              <div className="w-1.5 h-1.5 rounded-full bg-primary/60" />
              <span className="font-mono text-[10px] text-muted-foreground">{t}</span>
            </div>
          ))}
        </div>
        <div className="h-16 bg-muted/10 rounded-lg relative overflow-hidden">
          <svg viewBox="0 0 200 50" className="w-full h-full" preserveAspectRatio="none">
            <polyline points="0,40 30,32 60,20 90,28 120,15 150,10 200,18" fill="none" stroke="rgba(0,255,255,0.4)" strokeWidth="1.5" />
            <polyline points="0,40 30,32 60,20 90,28 120,15 150,10 200,18 200,50 0,50" fill="rgba(0,255,255,0.05)" />
          </svg>
        </div>
      </div>
    </div>
  );
}

// ─── Boot intro ─────────────────────────────────────────────────────────────
// A one-time terminal-boot splash shown before the landing page reveals
// itself — fits the existing cyberpunk/terminal identity (Terminal icon,
// GlitchText, ScanLine, monospace everything). Session-gated via
// sessionStorage so it plays once per browser session, not on every visit
// back to "/". Skippable, and respects prefers-reduced-motion.
const BOOT_LINES = [
  "INITIALIZING AYZEN CORE...",
  "CONNECTING 20+ CHAINS...",
  "DECRYPTING VAULT PROTOCOL...",
  "SYNCING AIRDROP INTELLIGENCE...",
];
const BOOT_SEEN_KEY = "ayzen_boot_seen";

function BootIntro({ onDone }: { onDone: () => void }) {
  const [lineIdx, setLineIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<"boot" | "granted" | "exit">("boot");

  useEffect(() => {
    const lineTimer = setInterval(() => {
      setLineIdx(i => {
        if (i >= BOOT_LINES.length - 1) { clearInterval(lineTimer); return i; }
        return i + 1;
      });
    }, 320);
    const progressRaf = setTimeout(() => setProgress(100), 60);
    const grantedTimer = setTimeout(() => setPhase("granted"), 1500);
    const exitTimer = setTimeout(() => setPhase("exit"), 2050);
    const doneTimer = setTimeout(() => { sessionStorage.setItem(BOOT_SEEN_KEY, "1"); onDone(); }, 2500);
    return () => { clearInterval(lineTimer); clearTimeout(progressRaf); clearTimeout(grantedTimer); clearTimeout(exitTimer); clearTimeout(doneTimer); };
  }, [onDone]);

  const skip = () => { sessionStorage.setItem(BOOT_SEEN_KEY, "1"); onDone(); };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background transition-opacity duration-500"
      style={{ opacity: phase === "exit" ? 0 : 1, pointerEvents: phase === "exit" ? "none" : "auto" }}
    >
      <div className="absolute inset-0 opacity-[0.03]"
        style={{ backgroundImage: "linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)", backgroundSize: "40px 40px" }} />
      <button onClick={skip} className="absolute top-6 right-6 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 hover:text-foreground transition-colors">
        Skip →
      </button>
      <div className="relative w-full max-w-sm px-6 text-center">
        <div className="flex items-center justify-center gap-2 mb-8" style={{ animation: "fadeUp 0.5s ease both" }}>
          <Terminal className="w-7 h-7 text-primary" style={{ animation: "glowPulse 1.8s ease-in-out infinite" }} />
          <span className="font-mono font-bold text-2xl tracking-tight text-foreground">AYZEN</span>
        </div>
        <div className="space-y-1.5 mb-6 h-24 text-left font-mono text-[11px]">
          {BOOT_LINES.slice(0, lineIdx + 1).map((line, i) => (
            <div key={line} className="flex items-center gap-2" style={{ animation: "fadeUp 0.3s ease both" }}>
              <span className="text-emerald-400">{i < lineIdx || phase !== "boot" ? "✓" : "›"}</span>
              <span className="text-muted-foreground">{line}</span>
            </div>
          ))}
        </div>
        <div className="h-1 rounded-full bg-muted/20 overflow-hidden mb-3">
          <div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-all duration-[1400ms] ease-out" style={{ width: `${progress}%` }} />
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] h-4">
          {phase === "boot" ? (
            <span className="text-muted-foreground/60">Booting command center…</span>
          ) : (
            <span className="text-emerald-400" style={{ animation: "fadeUp 0.3s ease both" }}>Access Granted</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const [booting, setBooting] = useState(() => {
    if (typeof window === "undefined") return false;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
    return sessionStorage.getItem(BOOT_SEEN_KEY) !== "1";
  });

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">
      {booting && <BootIntro onDone={() => setBooting(false)} />}
      {/* Grid texture */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-[0.02]"
        style={{ backgroundImage: "linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

      {/* Nav */}
      <header className="relative z-10 border-b border-border/50 backdrop-blur-sm" style={{ animation: "fadeDown 0.6s ease both" }}>
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-primary" />
            <span className="font-mono font-bold text-base tracking-tight text-foreground">AYZEN</span>
            <span className="font-mono text-[9px] text-primary/50 border border-primary/20 rounded-full px-2 py-0.5 hidden sm:block">v2.0</span>
          </div>
          <div className="hidden md:flex items-center gap-6">
            {["Features", "Tokens", "Teams", "Pricing"].map(n => (
              <a key={n} href="#" className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors">{n}</a>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Link href="/login"><Button variant="ghost" className="font-mono text-xs h-8 px-4 text-muted-foreground hover:text-foreground">Sign In</Button></Link>
            <Link href="/login"><Button className="font-mono text-xs h-8 px-4 bg-primary text-primary-foreground hover:bg-primary/90 gap-1">Get Started <ArrowRight className="w-3 h-3" /></Button></Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 pt-20 pb-16 px-6 text-center overflow-hidden">
        <HeroParticles />
        <div className="max-w-5xl mx-auto relative">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 border border-primary/20 bg-primary/5 rounded-full px-4 py-1.5 mb-8" style={{ animation: "fadeUp 0.6s ease 0.1s both" }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-primary">Airdrop Command Center · Live</span>
          </div>

          <h1 className="text-5xl sm:text-6xl md:text-7xl font-mono font-bold tracking-tighter text-foreground mb-6 leading-[1.05]" style={{ animation: "fadeUp 0.65s ease 0.2s both" }}>
            <GlitchText text="Dominate" /> Every{" "}
            <Typewriter texts={["Airdrop", "Protocol", "Campaign", "Chain", "Airdrop"]} />
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground font-mono max-w-2xl mx-auto leading-relaxed mb-10" style={{ animation: "fadeUp 0.65s ease 0.3s both" }}>
            AYZEN is the professional operator platform for tracking crypto airdrops, completing tasks, analyzing wallets across 20+ chains, and maximizing your ROI — all in one encrypted command center.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-16" style={{ animation: "fadeUp 0.65s ease 0.4s both" }}>
            <Link href="/login">
              <Button className="h-12 px-8 font-mono font-bold uppercase tracking-widest text-sm bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_30px_rgba(0,255,255,0.25)] hover:shadow-[0_0_50px_rgba(0,255,255,0.35)] transition-shadow">
                Launch Dashboard <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
            <Link href="/login">
              <Button variant="outline" className="h-12 px-8 font-mono text-sm border-border hover:border-primary/40 hover:text-primary uppercase tracking-widest transition-all">
                Try Demo
              </Button>
            </Link>
          </div>

          {/* Dashboard preview */}
          <div style={{ animation: "fadeUp 0.75s ease 0.5s both" }} className="max-w-2xl mx-auto">
            <DashboardPreview />
          </div>

          {/* Floating chain badges */}
          <div className="absolute -left-4 top-12 hidden lg:flex flex-col gap-2" style={{ animation: "floatLeft 3s ease-in-out infinite" }}>
            {["ETH", "ARB", "OP", "BASE"].map(n => (
              <div key={n} className="px-2 py-1 bg-card border border-card-border rounded font-mono text-[10px] text-primary/60">{n}</div>
            ))}
          </div>
          <div className="absolute -right-4 top-20 hidden lg:flex flex-col gap-2" style={{ animation: "floatRight 3.5s ease-in-out infinite" }}>
            {["zkSync", "Linea", "Scroll", "Blast"].map(n => (
              <div key={n} className="px-2 py-1 bg-card border border-card-border rounded font-mono text-[10px] text-violet-400/60">{n}</div>
            ))}
          </div>
        </div>
        <ScanLine />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] bg-cyan-500/4 rounded-full blur-3xl pointer-events-none" style={{ animation: "heroGlow 5s ease-in-out infinite" }} />
        <div className="absolute top-1/3 right-1/4 w-[350px] h-[350px] bg-violet-500/5 rounded-full blur-3xl pointer-events-none" style={{ animation: "heroGlow 7s ease-in-out infinite 2s" }} />
      </section>

      {/* Chain ticker */}
      <div className="relative z-10"><ChainTicker /></div>

      {/* Stats */}
      <section className="relative z-10 border-y border-border/40 bg-card/30">
        <div className="max-w-4xl mx-auto px-6 py-8 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          {stats.map((s, i) => (
            <AnimSection key={s.label} delay={i * 80}>
              <Counter target={s.value} />
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{s.label}</div>
            </AnimSection>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="relative z-10 py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <AnimSection className="text-center mb-16">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary/70 mb-3">Platform Features</div>
            <h2 className="text-3xl sm:text-4xl font-mono font-bold tracking-tight text-foreground">Everything an operator needs</h2>
            <p className="text-sm text-muted-foreground font-mono mt-3 max-w-xl mx-auto">A complete suite of tools built for professional airdrop operators — from vault to wallet to team.</p>
          </AnimSection>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {features.map((f, i) => (
              <AnimSection key={f.title} delay={i * 60}>
                <div className={`bg-card border ${f.border} rounded-xl p-5 ${f.glow} hover:border-primary/30 hover:scale-[1.02] transition-all duration-300 group cursor-default h-full`}>
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center bg-background border ${f.border} mb-3 group-hover:border-primary/30 transition-all`}>
                    <f.icon className={`w-4 h-4 ${f.color}`} />
                  </div>
                  <h3 className="font-mono font-bold text-xs text-foreground mb-1.5">{f.title}</h3>
                  <p className="text-[11px] text-muted-foreground font-mono leading-relaxed">{f.desc}</p>
                </div>
              </AnimSection>
            ))}
          </div>
        </div>
      </section>

      {/* Token Section */}
      <section className="relative z-10 py-20 px-6 border-t border-border/40">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            <AnimSection>
              <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary/70 mb-3">Built-in Token Economy</div>
              <h2 className="text-3xl font-mono font-bold tracking-tight text-foreground mb-4">
                AZN & USDT — <br/>
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-violet-500">Built Right In</span>
              </h2>
              <p className="text-sm text-muted-foreground font-mono leading-relaxed mb-6">
                Every AYZEN account comes with a built-in wallet that holds AZN tokens and USDT. Earn AZN by completing tasks, use USDT for protocol fees, and track all balances in real-time.
              </p>
              <div className="flex flex-col gap-3">
                {[
                  { icon: Coins, text: "Earn AZN by completing airdrop tasks and farming projects", color: "text-cyan-400" },
                  { icon: TrendingUp, text: "Real-time token balance tracking across all networks", color: "text-violet-400" },
                  { icon: ShieldCheck, text: "Encrypted wallet storage with seed phrase backup", color: "text-emerald-400" },
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className={`w-7 h-7 rounded-lg bg-primary/5 border border-border/40 flex items-center justify-center flex-shrink-0 mt-0.5`}>
                      <item.icon className={`w-3.5 h-3.5 ${item.color}`} />
                    </div>
                    <p className="text-sm text-muted-foreground font-mono leading-relaxed">{item.text}</p>
                  </div>
                ))}
              </div>
            </AnimSection>
            <AnimSection delay={150}>
              <div className="space-y-3">
                <TokenCard symbol="AZN" name="AYZEN Token" color="cyan" amount="1,204.50" change="+12.4% this week" />
                <TokenCard symbol="USDT" name="Tether USD" color="emerald" amount="$47.20" change="Stable · Pegged" />
                <TokenCard symbol="ETH" name="Ethereum" color="violet" amount="0.024 ETH" change="Multi-chain tracked" />
                <div className="bg-card border border-border/30 rounded-xl p-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[10px] text-muted-foreground">Next Reward</span>
                      <span className="font-mono text-[10px] text-primary">+50 AZN</span>
                    </div>
                    <div className="h-1.5 bg-muted/20 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 rounded-full" style={{ width: "73%" }} />
                    </div>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap">73% done</span>
                </div>
              </div>
            </AnimSection>
          </div>
        </div>
      </section>

      {/* Teams Section */}
      <section className="relative z-10 py-20 px-6 border-t border-border/40 bg-card/20">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            <AnimSection delay={100}>
              <div className="space-y-3">
                {/* Team panel preview */}
                <div className="bg-card border border-border/40 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2">
                    <Users className="w-3.5 h-3.5 text-primary" />
                    <span className="font-mono text-xs text-foreground font-semibold">Alpha Squad</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">5 members</span>
                  </div>
                  <div className="p-4 space-y-2">
                    {[
                      { name: "0x_hunter", roi: "+$1.2k", rank: 1 },
                      { name: "airdrop_pro", roi: "+$840", rank: 2 },
                      { name: "defi_ghost", roi: "+$620", rank: 3 },
                    ].map(m => (
                      <div key={m.name} className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground/50 w-4">#{m.rank}</span>
                        <div className="w-5 h-5 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-[8px] font-mono text-primary font-bold">{m.name[0].toUpperCase()}</div>
                        <span className="font-mono text-[10px] text-foreground flex-1">{m.name}</span>
                        <span className="font-mono text-[10px] text-emerald-400 font-bold">{m.roi}</span>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 py-2 border-t border-border/20 bg-muted/5">
                    <div className="font-mono text-[9px] text-muted-foreground/50">💬 defi_ghost: just joined the Scroll campaign</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[{ v: "5", l: "Members" }, { v: "14", l: "Projects" }, { v: "$2.6k", l: "Team ROI" }].map(s => (
                    <div key={s.l} className="bg-card border border-border/30 rounded-lg p-2.5 text-center">
                      <div className="font-mono text-sm font-bold text-primary">{s.v}</div>
                      <div className="font-mono text-[9px] text-muted-foreground">{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>
            </AnimSection>
            <AnimSection>
              <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary/70 mb-3">Team Collaboration</div>
              <h2 className="text-3xl font-mono font-bold tracking-tight text-foreground mb-4">Farm Together.<br />Win Together.</h2>
              <p className="text-sm text-muted-foreground font-mono leading-relaxed mb-6">
                Create or join a team and collaborate on airdrop campaigns. Share vault entities, track team performance on a live leaderboard, and coordinate in real-time team chat.
              </p>
              <div className="flex flex-col gap-3">
                {[
                  { t: "Team Leaderboard", d: "Rank members by ROI, tasks completed, and AZN earned" },
                  { t: "Shared Projects", d: "Assign airdrop projects to teams for coordinated farming" },
                  { t: "Real-time Chat", d: "Team chat with live messages — no 3rd party needed" },
                ].map((item, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <p className="font-mono text-xs font-semibold text-foreground">{item.t}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{item.d}</p>
                    </div>
                  </div>
                ))}
              </div>
            </AnimSection>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="relative z-10 py-20 px-6 border-t border-border/40">
        <div className="max-w-4xl mx-auto">
          <AnimSection className="text-center mb-14">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary/70 mb-3">How It Works</div>
            <h2 className="text-3xl font-mono font-bold tracking-tight text-foreground">Up and running in minutes</h2>
          </AnimSection>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              { step: "01", icon: ShieldCheck, title: "Create Account", desc: "Sign up with email. Get a built-in wallet, @ayzen.io email, and AZN tokens automatically on registration." },
              { step: "02", icon: Layers, title: "Browse Projects", desc: "Explore live airdrop projects. Join the ones that fit your strategy and wallet profile." },
              { step: "03", icon: Globe, title: "Complete & Earn", desc: "Finish tasks, submit proofs, earn AZN tokens, track your ROI, and collect rewards when airdrops drop." },
            ].map((item, i) => (
              <AnimSection key={item.step} delay={i * 120}>
                <div className="flex gap-4 group">
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 rounded-full border border-primary/30 bg-primary/5 flex items-center justify-center group-hover:border-primary/60 group-hover:bg-primary/10 transition-all">
                      <span className="font-mono text-[10px] text-primary font-bold">{item.step}</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-2"><item.icon className="w-4 h-4 text-primary" /><h3 className="font-mono font-bold text-sm text-foreground">{item.title}</h3></div>
                    <p className="text-xs text-muted-foreground font-mono leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              </AnimSection>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 py-24 px-6 border-t border-border/40">
        <AnimSection className="max-w-2xl mx-auto text-center">
          <div className="bg-card border border-primary/20 rounded-xl p-10 shadow-[0_0_60px_rgba(0,255,255,0.06)] relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-60" />
            <div className="absolute bottom-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-violet-500 to-transparent opacity-40" />
            <Terminal className="w-10 h-10 text-primary mx-auto mb-5 opacity-80" />
            <h2 className="text-2xl font-mono font-bold tracking-tight text-foreground mb-3">Ready to start operating?</h2>
            <p className="text-sm text-muted-foreground font-mono mb-8 leading-relaxed">
              Join AYZEN and get a complete command center — including a built-in AZN wallet, @ayzen.io email, and team collaboration tools — for every airdrop campaign you run.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link href="/login">
                <Button className="h-11 px-8 font-mono font-bold uppercase tracking-widest text-sm bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_rgba(0,255,255,0.15)] hover:shadow-[0_0_35px_rgba(0,255,255,0.25)] transition-shadow">
                  Get Started Free <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
              <Link href="/login">
                <Button variant="outline" className="h-11 px-8 font-mono text-sm border-border hover:border-primary/40 hover:text-primary uppercase tracking-widest transition-all">
                  Demo Login
                </Button>
              </Link>
            </div>
          </div>
        </AnimSection>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border/40 py-10 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6 mb-8">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-mono text-sm font-bold text-foreground">AYZEN</span>
              <span className="font-mono text-xs text-muted-foreground ml-1">Airdrop Command Center</span>
            </div>
            <div className="flex items-center gap-6">
              {["Features", "Tokens", "Teams", "Dashboard"].map(n => (
                <a key={n} href="#" className="font-mono text-[10px] text-muted-foreground hover:text-foreground uppercase tracking-widest transition-colors">{n}</a>
              ))}
            </div>
          </div>
          <div className="border-t border-border/30 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">© 2026 AYZEN. All rights reserved.</div>
              <Link href="/status" className="font-mono text-[10px] text-muted-foreground/60 hover:text-emerald-400 uppercase tracking-widest transition-colors flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" /> Status
              </Link>
            </div>
            <div className="flex items-center gap-4">
              <span className="font-mono text-[10px] text-muted-foreground/50">Built for operators.</span>
              <span className="font-mono text-[10px] text-primary/60">20+ chains supported</span>
            </div>
          </div>
        </div>
      </footer>

      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(24px) } to { opacity:1; transform:translateY(0) } }
        @keyframes fadeDown { from { opacity:0; transform:translateY(-16px) } to { opacity:1; transform:translateY(0) } }
        @keyframes floatLeft { 0%,100% { transform:translateX(0) translateY(0) } 50% { transform:translateX(6px) translateY(-8px) } }
        @keyframes floatRight { 0%,100% { transform:translateX(0) translateY(0) } 50% { transform:translateX(-6px) translateY(-6px) } }
        @keyframes ticker { from { transform:translateX(0) } to { transform:translateX(-50%) } }
        @keyframes scanLine { 0% { top:0%;opacity:0 } 5% { opacity:1 } 95% { opacity:1 } 100% { top:100%;opacity:0 } }
        @keyframes glitchClip1 { 0%,100% { clip-path:inset(0 0 100% 0) } 10% { clip-path:inset(20% 0 60% 0);transform:translateX(-4px) } 20% { clip-path:inset(60% 0 20% 0);transform:translateX(4px) } 30% { clip-path:inset(0 0 100% 0) } }
        .glitch-active::before,.glitch-active::after { content:attr(data-text);position:absolute;inset:0;animation:glitchClip1 0.14s steps(1) both }
        .glitch-active::before { color:#00ffff;left:-2px }
        .glitch-active::after { color:#8b5cf6;left:2px }
        @keyframes heroGlow { 0%,100% { opacity:0.03;transform:scale(1) } 50% { opacity:0.07;transform:scale(1.08) } }
      `}</style>
    </div>
  );
}
