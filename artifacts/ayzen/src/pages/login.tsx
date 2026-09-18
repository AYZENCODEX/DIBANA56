import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Terminal, ArrowRight, Loader2, Mail, User, Eye, EyeOff, Sparkles, Check, RefreshCw, KeyRound, Fingerprint, X as XIcon, UserRound } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { SuccessAnimation } from "@/components/success-animation";
import { loginWithPasskey, browserSupportsWebAuthn } from "@/lib/passkey-api";
// OIDC Roadmap — Season 3, Phase 5d-c: cutover-redirect effect (see below,
// near oidcReturnTo).
import { getCurrentSubdomainApp } from "@/lib/subdomain-app";
import { getSyloOidcRolloutFlag } from "@/lib/sylo-oidc-rollout-flag";
import { startSyloOidcLogin } from "@/lib/sylo-oidc-login";

import { getApiBase } from "@/lib/api-base";
const BASE = getApiBase();


async function backendLogin(email: string, password: string): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function backendRegister(username: string, email: string, password: string, emailOtp: string, refCode?: string): Promise<{ token: string; user: any; error?: string } | null> {
  try {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password, emailOtp, ...(refCode ? { refCode } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) return { token: "", user: null, error: data.error ?? "Registration failed" };
    return data;
  } catch {
    return null;
  }
}

function makeCaptcha() {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const ops = [
    { q: `${a} + ${b}`, ans: a + b },
    { q: `${a + b} − ${b}`, ans: a },
    { q: `${a} × ${b > 5 ? 2 : b}`, ans: a * (b > 5 ? 2 : b) },
  ];
  return ops[Math.floor(Math.random() * ops.length)];
}

export default function Login() {
  const [, setLocation] = useLocation();
  const { login: setAuthContext, accounts, switchAccount, removeAccount, user: authedUser } = useAuth() as any;
  const { toast } = useToast();

  // OIDC Roadmap — Season 2, Phase 3b-b/3b-c: central-login redirect target.
  // `routes/oidc-authorize.ts` sends an unauthenticated user here with
  // `?return_to=/oidc/authorize?...` (that route's own `req.originalUrl` —
  // server-constructed, never a client-supplied value) when 3b-a finds no
  // existing session. Read once on mount; only ever a same-origin
  // `/oidc/authorize` path is honored (belt-and-suspenders — the actual
  // trust boundary is that this value was never accepted from anywhere
  // except that one server redirect in the first place, same as any other
  // `return_to`/`next` pattern that must not become an open redirect).
  //
  // UPDATE — Season 4, Phase 7b: `/oidc/consent` (the consent screen,
  // `pages/oidc-consent.tsx`) added to this same allow-list, for the
  // identical reason. That page does its own "am I signed in" check
  // (`useAuth()`) on mount and, when there's no session, bounces here the
  // same way — `?return_to=/oidc/consent?...` — with the exact same
  // trust boundary: server-constructed by that page from
  // `window.location.pathname + search`, never accepted from any other
  // source. Both prefixes share this one allow-list rather than each
  // page inventing its own, so there's exactly one place that decides
  // what `return_to` is allowed to point at.
  const OIDC_RETURN_TO_PREFIXES = ["/oidc/authorize", "/oidc/consent"];
  const [oidcReturnTo] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const value = new URLSearchParams(window.location.search).get("return_to");
    return value && OIDC_RETURN_TO_PREFIXES.some((prefix) => value.startsWith(prefix)) ? value : null;
  });

  // OIDC Roadmap — Season 3, Phase 5d-c: cutover-redirect effect.
  //
  // App.tsx's ProtectedRoute (5c-c) only starts the OIDC redirect for
  // routes IT guards — but `/login` itself is mounted OUTSIDE
  // ProtectedRoute (same tier as the OIDC callback route, see App.tsx's
  // own router), precisely so it keeps working as the credential-entry
  // fallback while the flag is off (5c-b). That means a direct hit on
  // `sylo.ayzen.tech/login` — a bookmark, a stale link, someone typing the
  // URL — was always a loophole around 5c-c's gate: once the rollout flag
  // is ON for an app, this page should not just remain reachable as a
  // second, parallel way to authenticate into it. This effect closes that
  // loophole the same way ProtectedRoute closes it for every OTHER route:
  // ask the identical rollout flag, and if it's on, hand off to
  // `startSyloOidcLogin()` instead of ever rendering the form below.
  //
  // Conditions, all required:
  //   - `subdomainApp` resolved (never runs on the main domain — ayzen.tech
  //     keeps `/login` as its only login mechanism, unchanged).
  //   - No `oidcReturnTo` — a request already carrying `?return_to=` came
  //     FROM `/oidc/authorize` itself (3b-a's own redirect for "no
  //     session"), so redirecting it right back into `startSyloOidcLogin()`
  //     would just loop; this page's job for that visitor is showing the
  //     credential form so `redirectAfterLogin()` above can resume the
  //     transaction on success.
  //   - Not already authenticated — `useAuth()`'s `user` below covers a
  //     signed-in visitor who navigated to `/login` directly; nothing to
  //     redirect through OIDC for someone who already has a session.
  //
  // Same `null` = "still checking" discipline ProtectedRoute's own
  // `oidcRolloutEnabled` state uses, and the identical loader is shown
  // while unresolved so this page never flashes the credential form for a
  // visitor who's about to be redirected away from it.
  const [cutoverRedirectState, setCutoverRedirectState] = useState<"checking" | "redirecting" | "done">(() => {
    if (typeof window === "undefined") return "done";
    return getCurrentSubdomainApp() && !oidcReturnTo ? "checking" : "done";
  });
  useEffect(() => {
    if (cutoverRedirectState !== "checking") return;
    if (authedUser) { setCutoverRedirectState("done"); return; }
    const subdomainApp = getCurrentSubdomainApp();
    if (!subdomainApp) { setCutoverRedirectState("done"); return; }
    let cancelled = false;
    void getSyloOidcRolloutFlag(subdomainApp.id).then((enabled) => {
      if (cancelled) return;
      if (enabled) {
        setCutoverRedirectState("redirecting");
        void startSyloOidcLogin();
      } else {
        setCutoverRedirectState("done");
      }
    });
    return () => { cancelled = true; };
  }, [cutoverRedirectState, authedUser]);

  // 3b-c, applied: every existing post-login navigation in this file
  // ("go to /dashboard or /admin/dashboard") now funnels through here so
  // an in-flight `/oidc/authorize` transaction is resumed instead of
  // dropped. A full navigation (`window.location.href`), not `setLocation`
  // — `return_to` targets a server route (`/oidc/authorize`), not an SPA
  // route wouter knows how to render, and the whole point of resuming it
  // is a fresh request that now carries the just-set `ayzen_session`
  // cookie so 3b-a's session check succeeds this time.
  function redirectAfterLogin(role: string) {
    if (oidcReturnTo) {
      window.location.href = oidcReturnTo;
      return;
    }
    if (role === "admin") setLocation("/admin/dashboard");
    else setLocation("/dashboard");
  }

  const [tab, setTab] = useState<"signin" | "signup" | "magic">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [refCode, setRefCode] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [magicCode, setMagicCode] = useState("");
  const [magicVerifyLoading, setMagicVerifyLoading] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  const [captcha, setCaptcha] = useState(makeCaptcha);
  const [captchaInput, setCaptchaInput] = useState("");
  const [captchaError, setCaptchaError] = useState(false);

  // Google-style "choose an account" screen — only relevant when this
  // browser already has other AYZEN accounts saved (see hooks/use-auth.tsx).
  // Defaults to showing the picker when there's something to pick from;
  // "Use another account" drops straight to the normal sign-in form below.
  const [showChooser, setShowChooser] = useState(true);

  // signup OTP flow
  const [signupStep, setSignupStep] = useState<"form" | "otp">("form");
  const [signupOtp, setSignupOtp] = useState("");
  const [signupSendingOtp, setSignupSendingOtp] = useState(false);
  const [signupCountdown, setSignupCountdown] = useState(0);

  // signin OTP flow (2-step: credentials → email OTP)
  const [signinStep, setSigninStep] = useState<"form" | "otp" | "stepup">("form");
  const [signinOtp, setSigninOtp] = useState("");
  const [signinCountdown, setSigninCountdown] = useState(0);
  const [tempSigninData, setTempSigninData] = useState<{ token: string; user: any } | null>(null);
  const [signinOtpSending, setSigninOtpSending] = useState(false);
  const [signinOtpLoading, setSigninOtpLoading] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);

  // Anomalous-IP step-up chain (see lib/login-security.ts on the server):
  // every configured factor listed in requiredMethods must be individually
  // verified — tracked here in completedMethods — before a session opens.
  const [stepUp, setStepUp] = useState<{ challengeToken: string; requiredMethods: string[]; completedMethods: string[] } | null>(null);
  const [stepUpEmailCode, setStepUpEmailCode] = useState("");
  const [stepUpTotpCode, setStepUpTotpCode] = useState("");
  const [stepUpBackupCode, setStepUpBackupCode] = useState("");
  const [stepUpBusy, setStepUpBusy] = useState<string | null>(null);

  useEffect(() => {
    if (signupCountdown <= 0) return;
    const t = setTimeout(() => setSignupCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [signupCountdown]);

  useEffect(() => {
    if (signinCountdown <= 0) return;
    const t = setTimeout(() => setSigninCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [signinCountdown]);

  const handleSendSignupOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !email || !password) {
      toast({ variant: "destructive", title: "Fill all fields", description: "Username, email and password are required." });
      return;
    }
    if (password.length < 6) {
      toast({ variant: "destructive", title: "Password too short", description: "Minimum 6 characters." });
      return;
    }
    if (parseInt(captchaInput) !== captcha.ans) {
      setCaptchaError(true);
      setCaptcha(makeCaptcha());
      setCaptchaInput("");
      toast({ variant: "destructive", title: "Captcha failed" });
      return;
    }
    setCaptchaError(false);
    setSignupSendingOtp(true);
    try {
      const res = await fetch(`${BASE}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "Code sent!", description: `6-digit code sent to ${email}` });
        setSignupStep("otp");
        setSignupCountdown(60);
      } else {
        toast({ variant: "destructive", title: "Failed to send code", description: data.error ?? "Try again." });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setSignupSendingOtp(false);
  };

  const handleResendSignupOtp = async () => {
    if (signupCountdown > 0) return;
    setSignupSendingOtp(true);
    try {
      const res = await fetch(`${BASE}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        toast({ title: "Code resent!" });
        setSignupCountdown(60);
      }
    } catch {}
    setSignupSendingOtp(false);
  };


  const handleMagicVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!magicCode.trim()) return;
    setMagicVerifyLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/magic-link/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: magicCode.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setAuthContext(data.user, data.token);
        setSuccessMsg(`Access granted, ${data.user.username}!`);
        setShowSuccess(true);
        setTimeout(() => redirectAfterLogin(data.user.role), 1600);
      } else {
        toast({ variant: "destructive", title: data.error ?? "Invalid code" });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setMagicVerifyLoading(false);
  };

  const DEMO_EMAILS = ["demoadmin@ayzen.io", "demo@ayzen.io"];

  const [passkeyLoading, setPasskeyLoading] = useState(false);

  const handlePasskeySignIn = async () => {
    setPasskeyLoading(true);
    try {
      const data = await loginWithPasskey(email.trim() || undefined);
      if (data.requiresStepUp) {
        setStepUp({ challengeToken: data.challengeToken!, requiredMethods: data.requiredMethods ?? [], completedMethods: data.completedMethods ?? [] });
        setSigninStep("stepup");
        toast({ title: "New sign-in location detected", description: "Passkey confirmed — finish the remaining steps below to continue." });
        setPasskeyLoading(false);
        return;
      }
      setAuthContext(data.user, data.token!, keepSignedIn);
      setSuccessMsg(`Welcome back, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => redirectAfterLogin(data.user.role), 1600);
    } catch (err: any) {
      if (err?.name !== "NotAllowedError") {
        toast({ variant: "destructive", title: "Passkey sign-in failed", description: err?.message ?? "Try again." });
      }
    }
    setPasskeyLoading(false);
  };

  // "Login with AYZEN" — the main domain's own first-party OIDC login
  // button (see `WORKSPACE_OIDC_CLIENT_ID`, sylo-oidc-config.ts). Reuses
  // Season 3's generic `startSyloOidcLogin()` as-is: on the main domain
  // `resolveSyloOidcClientId()` now resolves to `"workspace"`, so the same
  // Authorization Code + PKCE round-trip Sylo/Ryft/etc. use for their
  // auto-cutover works here too — just started by an explicit button click
  // instead of an automatic redirect, and only ever offered as one option
  // alongside the existing credential form, never replacing it.
  // `"/dashboard"` is passed explicitly (matching every other sign-in
  // path's own post-login destination below) rather than defaulting to the
  // current path, since a click starting from `/login` itself has no
  // more-specific "where was the user headed" to preserve.
  const [workspaceOidcLoading, setWorkspaceOidcLoading] = useState(false);
  const handleWorkspaceOidcSignIn = async () => {
    setWorkspaceOidcLoading(true);
    try {
      await startSyloOidcLogin("/dashboard");
      // Never resolves on success — the tab navigates away.
    } catch (err: any) {
      toast({ variant: "destructive", title: "Sign-in with AYZEN failed", description: err?.message ?? "Try again." });
      setWorkspaceOidcLoading(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    try {
      const data = await backendLogin(email, password);
      if (data) {
        // Anomalous-IP login pattern: password checked out, but this IP
        // hasn't succeeded on this account before — every configured
        // factor must clear before a session opens.
        if (data.requiresStepUp) {
          setStepUp({ challengeToken: data.challengeToken, requiredMethods: data.requiredMethods, completedMethods: data.completedMethods });
          setSigninStep("stepup");
          toast({ title: "New sign-in location detected", description: "We've sent a confirmation code to your email — please clear every step below to continue." });
          setLoading(false);
          return;
        }
        // Demo accounts: skip OTP entirely
        if (DEMO_EMAILS.includes(email.toLowerCase().trim())) {
          setAuthContext(data.user, data.token, keepSignedIn);
          setSuccessMsg(`Welcome back, ${data.user.username}!`);
          setShowSuccess(true);
          setTimeout(() => redirectAfterLogin(data.user.role), 1600);
          setLoading(false);
          return;
        }
        // Step 1: credentials valid — send OTP
        setTempSigninData(data);
        setSigninOtpSending(true);
        try {
          const otpRes = await fetch(`${BASE}/api/auth/send-otp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
          });
          const otpData = await otpRes.json();
          if (otpRes.ok) {
            toast({ title: "Code sent!", description: `Verification code sent to ${email}` });
            setSigninStep("otp");
            setSigninCountdown(60);
          } else {
            toast({ variant: "destructive", title: "Failed to send code", description: otpData.error ?? "Try again." });
          }
        } catch {
          toast({ variant: "destructive", title: "Connection error sending OTP" });
        }
        setSigninOtpSending(false);
      } else {
        toast({ variant: "destructive", title: "Access denied", description: "Invalid credentials. Check email and password." });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error", description: "Could not reach server. Try again." });
    }
    setLoading(false);
  };

  const handleSigninOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signinOtp.trim() || signinOtp.length !== 6 || !tempSigninData) return;
    setSigninOtpLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: signinOtp.trim() }),
      });
      const result = await res.json();
      if (res.ok && result.valid) {
        setAuthContext(tempSigninData.user, tempSigninData.token, keepSignedIn);
        setSuccessMsg(`Welcome back, ${tempSigninData.user.username}!`);
        setShowSuccess(true);
        setTimeout(() => {
          redirectAfterLogin(tempSigninData.user.role);
        }, 1600);
      } else {
        toast({ variant: "destructive", title: result.error ?? "Invalid code" });
        setSigninOtp("");
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setSigninOtpLoading(false);
  };

  const handleResendSigninOtp = async () => {
    if (signinCountdown > 0) return;
    setSigninOtpSending(true);
    try {
      const res = await fetch(`${BASE}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) { toast({ title: "Code resent!" }); setSigninCountdown(60); }
    } catch {}
    setSigninOtpSending(false);
  };

  // ─── Anomalous-IP step-up chain ───────────────────────────────────────────
  // Fires when POST /auth/login (or a fresh passkey login) comes back with
  // requiresStepUp — every factor in stepUp.requiredMethods must clear
  // individually before a session opens. See lib/login-security.ts on the
  // server for the full design note.
  const grantStepUpSession = (data: any) => {
    setAuthContext(data.user, data.token, keepSignedIn);
    setSuccessMsg(`Welcome back, ${data.user.username}!`);
    setShowSuccess(true);
    setStepUp(null);
    setTimeout(() => {
      redirectAfterLogin(data.user.role);
    }, 1600);
  };

  const submitStepUpMethod = async (method: "email_otp" | "totp" | "backup_code", code: string) => {
    if (!stepUp || !code.trim()) return;
    setStepUpBusy(method);
    try {
      const res = await fetch(`${BASE}/api/auth/login/step-up/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: stepUp.challengeToken, method, code: code.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          toast({ variant: "destructive", title: "Sign-in confirmation locked", description: data.error ?? "Too many failed attempts. Please log in again." });
          setStepUp(null);
          setSigninStep("form");
          setStepUpEmailCode(""); setStepUpTotpCode(""); setStepUpBackupCode("");
          return;
        }
        toast({ variant: "destructive", title: data.error ?? "Verification failed" });
        return;
      }
      if (data.verified) {
        grantStepUpSession(data);
      } else {
        setStepUp(prev => prev ? { ...prev, completedMethods: data.completedMethods } : prev);
        toast({ title: "Verified", description: "Continue with the remaining steps below." });
        if (method === "email_otp") setStepUpEmailCode("");
        if (method === "totp") setStepUpTotpCode("");
        if (method === "backup_code") setStepUpBackupCode("");
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    } finally {
      setStepUpBusy(null);
    }
  };

  const submitStepUpPasskey = async () => {
    if (!stepUp) return;
    setStepUpBusy("passkey");
    try {
      const data = await loginWithPasskey(email.trim() || undefined, stepUp.challengeToken);
      if (data.verified) {
        grantStepUpSession(data);
      } else {
        setStepUp(prev => prev ? { ...prev, completedMethods: data.completedMethods ?? prev.completedMethods } : prev);
        toast({ title: "Passkey verified", description: "Continue with the remaining steps below." });
      }
    } catch (err: any) {
      if (err?.name !== "NotAllowedError") {
        toast({ variant: "destructive", title: "Passkey verification failed", description: err?.message ?? "Try again." });
      }
    } finally {
      setStepUpBusy(null);
    }
  };

  const stepUpMethodLabel: Record<string, string> = {
    email_otp: "Email code",
    totp: "Authenticator app (2FA)",
    backup_code: "Backup code",
    passkey: "Passkey",
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signupOtp.trim() || signupOtp.length !== 6) {
      toast({ variant: "destructive", title: "Enter the 6-digit code" });
      return;
    }
    setLoading(true);
    try {
      const data = await backendRegister(username, email, password, signupOtp.trim());
      if (!data) {
        toast({ variant: "destructive", title: "Registration failed", description: "Server error. Try again." });
        setLoading(false);
        return;
      }
      if (data.error) {
        toast({ variant: "destructive", title: "Registration failed", description: data.error });
        if (data.error.toLowerCase().includes("code")) setSignupOtp("");
        setLoading(false);
        return;
      }
      setAuthContext(data.user, data.token);
      setSuccessMsg("Welcome to AYZEN, Operator!");
      setShowSuccess(true);
      setTimeout(() => setLocation("/dashboard"), 1800);
    } catch {
      toast({ variant: "destructive", title: "Registration failed", description: "Try again." });
    }
    setLoading(false);
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) { toast({ variant: "destructive", title: "Enter your email" }); return; }
    setMagicLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ variant: "destructive", title: data.error ?? "Failed to send magic link" });
      } else {
        setMagicSent(true);
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to send magic link" });
    }
    setMagicLoading(false);
  };

  const handleDemoAdmin = async () => {
    setLoading(true);
    const data = await backendLogin("demoadmin@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/admin/dashboard"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo admin login failed" });
    }
    setLoading(false);
  };

  const handleDemoDev = async () => {
    setLoading(true);
    const data = await backendLogin("demodev@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/admin/developer"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo developer login failed" });
    }
    setLoading(false);
  };

  const handleDemoModerator = async () => {
    setLoading(true);
    const data = await backendLogin("demomod@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/dashboard"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo moderator login failed" });
    }
    setLoading(false);
  };

  const handleDemoTeamLeader = async () => {
    setLoading(true);
    const data = await backendLogin("demoteam@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/teams"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo team leader login failed" });
    }
    setLoading(false);
  };

  const handleDemoUser = async () => {
    setLoading(true);
    const data = await backendLogin("demo@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/dashboard"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo user login failed" });
    }
    setLoading(false);
  };

  const isLoading = loading;

  // 5d-c: while the cutover check is in flight, or once it's decided to
  // hand off to startSyloOidcLogin(), render the same full-screen loader
  // ProtectedRoute uses for the identical situation rather than this
  // page's own credential form — see the effect above for why.
  if (cutoverRedirectState !== "done") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-primary font-mono">
        INITIALIZING...
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <SuccessAnimation
        show={showSuccess}
        message={tab === "signup" ? "Account Created!" : "Access Granted!"}
        subMessage={successMsg}
        type={tab === "signup" ? "success" : "login"}
      />
      <div className="absolute inset-0 z-0 opacity-[0.02]"
        style={{ backgroundImage: "linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)", backgroundSize: "40px 40px" }}
      />

      <div className="w-full max-w-md space-y-8 relative z-10">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-primary/10 rounded-xl flex items-center justify-center border border-primary/20 shadow-[0_0_20px_rgba(0,255,255,0.08)]">
              <Terminal className="w-8 h-8 text-primary" />
            </div>
          </div>
          <h1 className="text-4xl font-mono font-bold tracking-tighter text-foreground mb-2">AYZEN</h1>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-[0.3em]">Airdrop Command Center</p>
        </div>

        {accounts?.length > 0 && showChooser ? (
          <div className="bg-card border border-card-border p-6 shadow-2xl relative">
            <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-60" />
            <p className="text-center text-xs font-mono text-muted-foreground uppercase tracking-widest mb-4">Choose an account</p>
            <div className="space-y-1.5">
              {accounts.map((acc: any) => (
                <div
                  key={acc.id}
                  className="group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/30 hover:border-primary/40 hover:bg-primary/5 transition-all"
                >
                  <button
                    onClick={() => { switchAccount(acc.id); setLocation("/"); }}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  >
                    <div className="w-8 h-8 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center font-bold text-xs uppercase text-primary flex-shrink-0">
                      {acc.username?.[0] || "U"}
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-foreground truncate">{acc.username}</div>
                      <div className="font-mono text-[10px] text-muted-foreground truncate">{acc.email}</div>
                    </div>
                  </button>
                  <button
                    onClick={() => removeAccount(acc.id)}
                    title="Remove from this browser"
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-opacity flex-shrink-0 p-1"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowChooser(false)}
              className="w-full mt-4 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-mono text-primary border border-border/30 hover:border-primary/40 hover:bg-primary/5 transition-all"
            >
              <UserRound className="w-3.5 h-3.5" /> Use another account
            </button>
          </div>
        ) : (
        <div className="bg-card border border-card-border p-8 shadow-2xl relative">
          {accounts?.length > 0 && (
            <button
              onClick={() => setShowChooser(true)}
              className="absolute -top-3 right-3 text-[10px] font-mono text-muted-foreground hover:text-primary bg-card border border-border/40 rounded-full px-2.5 py-1 flex items-center gap-1"
            >
              <UserRound className="w-3 h-3" /> Switch account
            </button>
          )}
          <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-60" />

          <div className="flex mb-6 border border-border rounded overflow-hidden">
            <button
              onClick={() => setTab("signin")}
              className={`flex-1 py-2 text-xs font-mono uppercase tracking-widest transition-colors ${tab === "signin" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
            >Sign In</button>
            <button
              onClick={() => setTab("signup")}
              className={`flex-1 py-2 text-xs font-mono uppercase tracking-widest transition-colors ${tab === "signup" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
            >Sign Up</button>
            <button
              onClick={() => { setTab("magic"); setMagicSent(false); }}
              className={`flex-1 py-2 text-xs font-mono uppercase tracking-widest transition-colors flex items-center justify-center gap-1 ${tab === "magic" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
            ><Sparkles className="w-3 h-3" /> Magic</button>
          </div>

          {tab === "magic" ? (
            <div className="space-y-4">
              {magicSent ? (
                <div className="space-y-4">
                  <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-center">
                    <div className="font-mono text-xs text-muted-foreground">Code sent to</div>
                    <div className="font-mono text-sm text-foreground font-bold">{email}</div>
                  </div>
                  <form onSubmit={handleMagicVerify} className="space-y-4">
                    <div className="space-y-2">
                      <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Enter 6-Digit Code</Label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder="000000"
                        maxLength={6}
                        value={magicCode}
                        onChange={e => setMagicCode(e.target.value.replace(/\D/g, ""))}
                        className="bg-input border-border font-mono h-14 text-center text-2xl tracking-[0.5em] focus-visible:ring-primary/50"
                        autoFocus required
                      />
                    </div>
                    <Button type="submit" disabled={magicCode.length !== 6 || magicVerifyLoading} className="w-full h-11 font-mono font-bold uppercase tracking-widest">
                      {magicVerifyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="flex items-center gap-2">Verify & Enter <Sparkles className="w-4 h-4" /></span>}
                    </Button>
                  </form>
                  <Button variant="ghost" size="sm" className="w-full font-mono text-xs text-muted-foreground" onClick={() => { setMagicSent(false); setMagicCode(""); setEmail(""); }}>
                    ← Try different email
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleMagicLink} className="space-y-4">
                  <div className="text-center pb-2">
                    <div className="flex justify-center mb-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Sparkles className="w-5 h-5 text-primary" />
                      </div>
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      Enter your email — we'll send you a 6-digit code. No password needed.
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input type="email" placeholder="operator@command.io" value={email} onChange={e => setEmail(e.target.value)}
                        className="bg-input border-border font-mono h-11 pl-9 focus-visible:ring-primary/50 focus-visible:border-primary" required />
                    </div>
                  </div>
                  <Button type="submit" className="w-full h-11 font-mono font-bold uppercase tracking-widest" disabled={magicLoading}>
                    {magicLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="flex items-center gap-2">Send Code <Sparkles className="w-4 h-4" /></span>}
                  </Button>
                </form>
              )}
            </div>
          ) : tab === "signin" && signinStep === "stepup" && stepUp ? (
            <div className="space-y-4">
              <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-4 text-center">
                <Fingerprint className="w-7 h-7 text-red-400 mx-auto mb-2" />
                <p className="font-mono text-xs font-bold text-foreground">New sign-in location detected</p>
                <p className="font-mono text-[10px] text-muted-foreground/60 mt-1">
                  Clear every step below to continue — this protects your account if someone else has your password.
                </p>
              </div>

              <div className="space-y-2.5">
                {stepUp.requiredMethods.map((method) => {
                  const done = stepUp.completedMethods.includes(method);
                  const busy = stepUpBusy === method;
                  return (
                    <div key={method} className={`rounded-lg border px-3 py-2.5 transition-colors ${done ? "border-emerald-400/30 bg-emerald-400/5" : "border-border bg-card"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-semibold flex items-center gap-1.5">
                          {done && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                          {stepUpMethodLabel[method] ?? method}
                        </span>
                        {done && <span className="font-mono text-[9px] uppercase tracking-wider text-emerald-400">Verified</span>}
                      </div>

                      {!done && method === "email_otp" && (
                        <div className="flex items-center gap-2 mt-2">
                          <Input
                            type="text" inputMode="numeric" placeholder="000000" maxLength={6}
                            value={stepUpEmailCode}
                            onChange={e => setStepUpEmailCode(e.target.value.replace(/\D/g, ""))}
                            className="bg-input border-border font-mono h-9 text-center tracking-[0.3em]"
                          />
                          <Button type="button" size="sm" className="h-9 font-mono text-xs shrink-0"
                            disabled={busy || stepUpEmailCode.length !== 6}
                            onClick={() => submitStepUpMethod("email_otp", stepUpEmailCode)}>
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Verify"}
                          </Button>
                        </div>
                      )}

                      {!done && method === "totp" && (
                        <div className="flex items-center gap-2 mt-2">
                          <Input
                            type="text" inputMode="numeric" placeholder="000000" maxLength={6}
                            value={stepUpTotpCode}
                            onChange={e => setStepUpTotpCode(e.target.value.replace(/\D/g, ""))}
                            className="bg-input border-border font-mono h-9 text-center tracking-[0.3em]"
                          />
                          <Button type="button" size="sm" className="h-9 font-mono text-xs shrink-0"
                            disabled={busy || stepUpTotpCode.length !== 6}
                            onClick={() => submitStepUpMethod("totp", stepUpTotpCode)}>
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Verify"}
                          </Button>
                        </div>
                      )}

                      {!done && method === "backup_code" && (
                        <div className="flex items-center gap-2 mt-2">
                          <Input
                            type="text" placeholder="XXXX-XXXX"
                            value={stepUpBackupCode}
                            onChange={e => setStepUpBackupCode(e.target.value.toUpperCase())}
                            className="bg-input border-border font-mono h-9 text-center tracking-widest"
                          />
                          <Button type="button" size="sm" className="h-9 font-mono text-xs shrink-0"
                            disabled={busy || !stepUpBackupCode.trim()}
                            onClick={() => submitStepUpMethod("backup_code", stepUpBackupCode)}>
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Verify"}
                          </Button>
                        </div>
                      )}

                      {!done && method === "passkey" && (
                        <Button type="button" size="sm" variant="outline" className="w-full h-9 font-mono text-xs mt-2 gap-1.5"
                          disabled={busy} onClick={submitStepUpPasskey}>
                          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Fingerprint className="w-3.5 h-3.5" /> Verify with passkey</>}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>

              <button type="button" onClick={() => { setStepUp(null); setSigninStep("form"); setStepUpEmailCode(""); setStepUpTotpCode(""); setStepUpBackupCode(""); }}
                className="font-mono text-xs text-muted-foreground hover:text-foreground underline">
                ← Back to login
              </button>
            </div>
          ) : tab === "signin" && signinStep === "otp" ? (
            <form onSubmit={handleSigninOtpVerify} className="space-y-4">
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-center">
                <Mail className="w-7 h-7 text-primary mx-auto mb-2" />
                <p className="font-mono text-xs text-muted-foreground">Verification code sent to</p>
                <p className="font-mono text-sm text-foreground font-bold">{email}</p>
                <p className="font-mono text-[10px] text-muted-foreground/60 mt-1">Check your inbox — code expires in 10 minutes</p>
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">6-Digit Code</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="000000"
                  maxLength={6}
                  value={signinOtp}
                  onChange={e => setSigninOtp(e.target.value.replace(/\D/g, ""))}
                  className="bg-input border-border font-mono h-14 text-center text-2xl tracking-[0.5em] focus-visible:ring-primary/50 focus-visible:border-primary"
                  autoFocus required
                />
              </div>
              <Button type="submit" disabled={signinOtpLoading || signinOtp.length !== 6}
                className="w-full h-11 font-mono font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90">
                {signinOtpLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="flex items-center gap-2">Verify & Enter <ArrowRight className="w-4 h-4" /></span>}
              </Button>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setSigninStep("form"); setSigninOtp(""); setTempSigninData(null); }}
                  className="font-mono text-xs text-muted-foreground hover:text-foreground underline">
                  ← Back to login
                </button>
                <button type="button" onClick={handleResendSigninOtp} disabled={signinCountdown > 0 || signinOtpSending}
                  className="font-mono text-xs text-primary disabled:opacity-40">
                  {signinOtpSending ? "Sending…" : signinCountdown > 0 ? `Resend in ${signinCountdown}s` : "Resend Code"}
                </button>
              </div>
            </form>
          ) : tab === "signup" && signupStep === "otp" ? (
            <form onSubmit={handleSignUp} className="space-y-4">
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-center">
                <Check className="w-7 h-7 text-primary mx-auto mb-2" />
                <p className="font-mono text-xs text-muted-foreground">Verification code sent to</p>
                <p className="font-mono text-sm text-foreground font-bold">{email}</p>
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">6-Digit Code</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="000000"
                  maxLength={6}
                  value={signupOtp}
                  onChange={e => setSignupOtp(e.target.value.replace(/\D/g, ""))}
                  className="bg-input border-border font-mono h-14 text-center text-2xl tracking-[0.5em] focus-visible:ring-primary/50 focus-visible:border-primary"
                  autoFocus required
                />
              </div>
              <Button type="submit" disabled={loading || signupOtp.length !== 6}
                className="w-full h-11 font-mono font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span className="flex items-center gap-2">Create Account <ArrowRight className="w-4 h-4" /></span>}
              </Button>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setSignupStep("form"); setSignupOtp(""); }}
                  className="font-mono text-xs text-muted-foreground hover:text-foreground underline">
                  ← Change details
                </button>
                <button type="button" onClick={handleResendSignupOtp} disabled={signupCountdown > 0 || signupSendingOtp}
                  className="font-mono text-xs text-primary disabled:opacity-40">
                  {signupSendingOtp ? "Sending…" : signupCountdown > 0 ? `Resend in ${signupCountdown}s` : "Resend Code"}
                </button>
              </div>
            </form>
          ) : (
          <form onSubmit={tab === "signin" ? handleSignIn : handleSendSignupOtp} className="space-y-4">
            {tab === "signup" && (
              <div className="space-y-2">
                <Label htmlFor="username" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Username</Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="username"
                    type="text"
                    placeholder="operator_handle"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                    className="bg-input border-border font-mono h-11 pl-9 focus-visible:ring-primary/50 focus-visible:border-primary"
                    required
                  />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {tab === "signin" ? "Email / Identifier" : "Email"}
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="operator@command.io"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-input border-border font-mono h-11 pl-9 focus-visible:ring-primary/50 focus-visible:border-primary"
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Passphrase</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-input border-border font-mono h-11 pr-10 focus-visible:ring-primary/50 focus-visible:border-primary"
                  required
                  minLength={6}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {tab === "signup" && (
              <div className="space-y-2">
                <Label htmlFor="refCode" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                  Referral Code <span className="text-muted-foreground/40">(optional)</span>
                </Label>
                <Input
                  id="refCode"
                  type="text"
                  placeholder="AYZNXXXXXX"
                  value={refCode}
                  onChange={e => setRefCode(e.target.value.toUpperCase())}
                  className="bg-input border-border font-mono h-11 focus-visible:ring-primary/50 focus-visible:border-primary uppercase placeholder:normal-case placeholder:text-muted-foreground"
                />
                {refCode && <p className="text-[10px] font-mono text-primary">✓ Referral code will be applied on registration</p>}
              </div>
            )}
            {tab === "signup" && (
              <div className="space-y-2">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Security Check <span className="text-red-400">*</span>
                </Label>
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 bg-primary/5 border border-primary/20 rounded px-4 py-2 font-mono text-sm font-bold text-primary tracking-widest select-none">
                    {captcha.q} = ?
                  </div>
                  <Input
                    type="number"
                    value={captchaInput}
                    onChange={e => { setCaptchaInput(e.target.value); setCaptchaError(false); }}
                    placeholder="Answer"
                    className={`bg-input border-border font-mono h-11 focus-visible:ring-primary/50 focus-visible:border-primary ${captchaError ? "border-red-400/50" : ""}`}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => { setCaptcha(makeCaptcha()); setCaptchaInput(""); setCaptchaError(false); }}
                    className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0"
                    title="New question"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
                {captchaError && <p className="font-mono text-[10px] text-red-400">Wrong answer. Try the new question.</p>}
              </div>
            )}

            {tab === "signin" && (
              <div className="flex items-center gap-2.5 py-1">
                <button
                  type="button"
                  onClick={() => setKeepSignedIn(p => !p)}
                  className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${keepSignedIn ? "bg-primary border-primary" : "border-border bg-input"}`}
                >
                  {keepSignedIn && <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3} />}
                </button>
                <label className="font-mono text-[10px] text-muted-foreground cursor-pointer select-none" onClick={() => setKeepSignedIn(p => !p)}>
                  Keep me signed in
                </label>
              </div>
            )}
            <Button
              type="submit"
              className="w-full h-11 font-mono font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={isLoading || signupSendingOtp}
            >
              {loading || signupSendingOtp ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <span className="flex items-center gap-2">
                  {tab === "signin" ? "Initialize" : <><Mail className="w-4 h-4" /> Send Code</>}
                  <ArrowRight className="w-4 h-4" />
                </span>
              )}
            </Button>
            {tab === "signin" && (
              <div className="text-right">
                <Link href="/forgot-password" className="font-mono text-[10px] text-muted-foreground hover:text-primary flex items-center justify-end gap-1">
                  <KeyRound className="w-3 h-3" /> Forgot password?
                </Link>
              </div>
            )}
          </form>
          )}

          {tab === "signin" && browserSupportsWebAuthn() && (
            <div className="mt-4">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handlePasskeySignIn}
                disabled={passkeyLoading || loading}
                className="w-full h-11 mt-4 font-mono uppercase tracking-widest border-primary/30 hover:border-primary hover:text-primary"
              >
                {passkeyLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <span className="flex items-center gap-2">
                    <Fingerprint className="w-4 h-4" /> Sign in with Passkey
                  </span>
                )}
              </Button>
            </div>
          )}

          {/* "Login with AYZEN" — only offered on the main domain itself
             (never on a subdomain app, which already has its own
             auto-cutover to this exact flow — see login.tsx's own
             cutoverRedirectState effect above) and never mid-transaction
             for some OTHER client's OIDC attempt (oidcReturnTo set means
             this form IS the credential-entry step of one already). */}
          {tab === "signin" && !getCurrentSubdomainApp() && !oidcReturnTo && (
            <div className="mt-4">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">or</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleWorkspaceOidcSignIn}
                disabled={workspaceOidcLoading || loading}
                className="w-full h-11 mt-4 font-mono uppercase tracking-widest border-primary/30 hover:border-primary hover:text-primary"
              >
                {workspaceOidcLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <span className="flex items-center gap-2">
                    <Terminal className="w-4 h-4" /> Login with AYZEN
                  </span>
                )}
              </Button>
            </div>
          )}

          <div className="mt-6 border-t border-border pt-5">
            <div className="text-[10px] font-mono text-center text-muted-foreground mb-3 uppercase tracking-widest">Demo Override</div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="font-mono text-xs h-9 border-border hover:border-primary/40 hover:text-primary" onClick={handleDemoAdmin} disabled={isLoading}>
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Admin Init"}
              </Button>
              <Button variant="outline" className="font-mono text-xs h-9 border-border hover:border-yellow-500/40 hover:text-yellow-400" onClick={handleDemoDev} disabled={isLoading}>
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Developer Init"}
              </Button>
              <Button variant="outline" className="font-mono text-xs h-9 border-border hover:border-orange-500/40 hover:text-orange-400" onClick={handleDemoModerator} disabled={isLoading}>
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Moderator Init"}
              </Button>
              <Button variant="outline" className="font-mono text-xs h-9 border-border hover:border-emerald-500/40 hover:text-emerald-400" onClick={handleDemoTeamLeader} disabled={isLoading}>
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Team Leader Init"}
              </Button>
            </div>
            <Button variant="outline" className="w-full font-mono text-xs h-9 mt-2 border-border hover:border-sky-500/40 hover:text-sky-400" onClick={handleDemoUser} disabled={isLoading}>
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "User Init"}
            </Button>
          </div>
        </div>
        )}

        <div className="text-center text-sm text-muted-foreground font-mono">
          {tab === "signin" ? (
            <>Unregistered entity?{" "}<button onClick={() => setTab("signup")} className="text-primary hover:underline">Request access</button></>
          ) : tab === "signup" ? (
            <>Already have access?{" "}<button onClick={() => setTab("signin")} className="text-primary hover:underline">Sign in</button></>
          ) : (
            <>Prefer password?{" "}<button onClick={() => setTab("signin")} className="text-primary hover:underline">Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}
