/**
 * pages/oidc-consent.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 7b: Consent UI (frontend half).
 *
 * "login-এর পরে একটা consent screen দেখানো: client-এর নাম, কোন কোন
 * scope-এর জন্য কী অ্যাক্সেস পাচ্ছে ..., Allow/Deny বাটন" — this page.
 * Mounted at `/oidc/consent`, same tier as `/login` and `/oidc/callback`:
 * a standalone, full-screen route OUTSIDE `ProtectedRoute`/`AppLayout`
 * (see `App.tsx`'s own router) — this screen's whole job is a single
 * yes/no decision about a login-adjacent transaction, not a page inside
 * the normal app chrome.
 *
 * QUERY CONTRACT: `?returnTo=/oidc/authorize?...` — the exact same
 * "server-observed URL round-trips through the browser instead of a
 * server-side transaction table" mechanism `/login`'s own `return_to`
 * already uses (see that page's own comment for the full rationale).
 * Nothing in THIS pass ever redirects a real `/oidc/authorize` request
 * here with a real `returnTo` — that hook is explicitly Phase 7c's job
 * ("routes/oidc-authorize.ts-এর existing flow-এ hook করা"). This page is
 * fully working and independently reachable (e.g. for manual testing
 * against a real `/oidc/authorize?...` query string) ahead of that wiring
 * existing, the same "build the piece before the wire-up" relationship
 * every earlier phase pair in this roadmap already has
 * (`lib/oidc-authorization-codes.ts` fully worked before
 * `routes/oidc-authorize.ts`'s 3b called it, etc).
 *
 * AUTH: this page does its own "am I signed in" check via `useAuth()` —
 * unlike `/oidc/authorize` (a server route that can inline a redirect
 * before any HTML is even served), an SPA route can't gate on the
 * server's session cookie before it mounts, so the pattern here is: if
 * there's no `user`/`token` yet, bounce to `/login?return_to=<this
 * page's own current URL>`, honored by `login.tsx`'s own widened
 * `OIDC_RETURN_TO_PREFIXES` allow-list (Phase 7b's own update to that
 * file) — after signing in, the user lands right back here with the
 * identical `returnTo` still in the query string. The backend's own
 * `requireAuth` on all three `/oidc/consent/*` endpoints is the real
 * trust boundary either way (this page's own check is only about not
 * flashing a broken screen at a signed-out visitor, never the security
 * control).
 *
 * THREE RENDERABLE STATES, same "working / error / interactive" shape
 * `pages/oidc-callback.tsx` (5b-f) already established for this exact
 * class of full-screen OIDC page:
 *   - "loading"  — fetching `GET /oidc/consent/info`.
 *   - "error"    — the request itself is invalid/expired/not
 *                  consent-eligible (see `describeConsentError()` below)
 *                  — nothing safe to redirect to, so this shows a plain
 *                  message + a link back to `/`, never an auto-redirect.
 *   - "ready"    — the actual consent screen: client name, per-scope
 *                  copy (`lib/oidc-consent-scope-copy.ts`, Phase 7b),
 *                  Allow/Deny buttons.
 * Deny and Allow both end in `window.location.href = <server-verified
 * URL>` — a full navigation, never `setLocation()` — because both
 * targets (the client's own `redirect_uri`, or back to this provider's
 * own `/oidc/authorize`) are server routes outside this SPA's router,
 * the identical reasoning `login.tsx`'s `redirectAfterLogin()` already
 * documents for its own `oidcReturnTo` navigation.
 *
 * UPDATE — Season 4, Phase 7e (Consent Re-Prompt Policy): the "ready"
 * state now branches on `info.isReprompt` (`lib/oidc-consent-api.ts`) for
 * the heading copy ("wants additional access" vs "wants to access"), and
 * each scope row that carries `isNew: true` gets a highlighted border and
 * a small "New" badge — 7e's own roadmap text asks for exactly this
 * ("শুধু নতুন scope-গুলো হাইলাইট করে"), not a different screen or a
 * filtered-down scope list. A scope that was already granted before this
 * re-prompt still renders, just without the highlight, so the user sees
 * the FULL picture of what the app will have access to, not only what's
 * changing.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, AlertTriangle, Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  getOidcConsentInfo,
  allowOidcConsent,
  denyOidcConsent,
  type OidcConsentInfo,
} from "@/lib/oidc-consent-api";

type ConsentState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; info: OidcConsentInfo }
  | { kind: "submitting"; info: OidcConsentInfo; action: "allow" | "deny" };

/**
 * Maps a thrown `authedJson()` error's `.code` (see
 * `lib/oidc-consent-api.ts`, itself echoing `routes/oidc-consent.ts`'s
 * `error` field) to a plain-language message. Deliberately generic for
 * every case — none of these are safe to turn into an auto-redirect (see
 * file header), so all this page can usefully do is explain that the
 * request itself can't be honored and point back to the app.
 */
function describeConsentError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "consent_not_required":
      return "This app doesn't need your explicit permission to sign you in.";
    case "invalid_client":
    case "invalid_redirect_uri":
      return "This sign-in request isn't recognized. It may have expired — please try signing in again from the app that sent you here.";
    default:
      return "This sign-in request is no longer valid. Please try again from the app that sent you here.";
  }
}

export default function OidcConsent() {
  const { user, token } = useAuth() as any;
  const [, setLocation] = useLocation();
  const [state, setState] = useState<ConsentState>({ kind: "loading" });

  // The preserved `/oidc/authorize?...` request — see file header. Read
  // once; this page never mutates its own query string.
  const [returnTo] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("returnTo");
  });

  useEffect(() => {
    if (!user || !token) return; // handled by the redirect-to-login branch below
    if (!returnTo) {
      setState({ kind: "error", message: "This sign-in request is missing required information." });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await getOidcConsentInfo(token, returnTo);
        if (!cancelled) setState({ kind: "ready", info });
      } catch (err) {
        if (!cancelled) setState({ kind: "error", message: describeConsentError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, token, returnTo]);

  // Not signed in yet: bounce to /login, preserving this exact URL —
  // see file header. A full navigation isn't needed here (this page and
  // /login are both SPA routes), so `setLocation` is correct, unlike the
  // post-login/Allow/Deny navigations below.
  if (!user || !token) {
    const here = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/oidc/consent";
    setLocation(`/login?return_to=${encodeURIComponent(here)}`, { replace: true });
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-primary font-mono gap-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>REDIRECTING TO SIGN IN...</span>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-primary font-mono gap-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>LOADING REQUEST...</span>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
          <h1 className="text-lg font-semibold">Can't continue</h1>
          <p className="text-sm text-muted-foreground">{state.message}</p>
          <Button variant="outline" onClick={() => setLocation("/")}>
            Back to AYZEN
          </Button>
        </div>
      </div>
    );
  }

  const { info } = state;
  const busy = state.kind === "submitting";

  async function handleDeny() {
    if (state.kind !== "ready" || !returnTo) return;
    setState({ kind: "submitting", info: state.info, action: "deny" });
    try {
      const { redirectTo } = await denyOidcConsent(token, returnTo);
      window.location.href = redirectTo;
    } catch (err) {
      setState({ kind: "error", message: describeConsentError(err) });
    }
  }

  async function handleAllow() {
    if (state.kind !== "ready" || !returnTo) return;
    setState({ kind: "submitting", info: state.info, action: "allow" });
    try {
      const { resumeUrl } = await allowOidcConsent(token, returnTo);
      window.location.href = resumeUrl;
    } catch (err) {
      setState({ kind: "error", message: describeConsentError(err) });
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-md w-full border border-card-border rounded-xl bg-card p-6 space-y-5">
        <div className="flex flex-col items-center text-center gap-2">
          <ShieldCheck className="h-8 w-8 text-primary" />
          <h1 className="text-lg font-semibold">
            {info.isReprompt ? (
              <>
                <span className="text-primary">{info.clientDisplayName}</span> wants additional access to your AYZEN account
              </>
            ) : (
              <>
                <span className="text-primary">{info.clientDisplayName}</span> wants to access your AYZEN account
              </>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="text-foreground">{user.username ?? user.email}</span>
          </p>
        </div>

        <div className="space-y-3">
          {info.scopes.map((scope) => (
            <div
              key={scope.scope}
              className={
                scope.isNew
                  ? "flex items-start gap-3 rounded-lg border border-primary/50 bg-primary/5 p-3"
                  : "flex items-start gap-3 rounded-lg border border-card-border/60 p-3"
              }
            >
              <Check className={scope.isNew ? "h-4 w-4 text-primary mt-0.5 shrink-0" : "h-4 w-4 text-muted-foreground mt-0.5 shrink-0"} />
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  {scope.label}
                  {scope.isNew && info.isReprompt && (
                    <span className="text-[10px] uppercase tracking-wide font-mono text-primary border border-primary/40 rounded px-1 py-0.5">New</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">{scope.description}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 pt-1">
          <Button onClick={handleAllow} disabled={busy}>
            {busy && state.action === "allow" ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Allow
          </Button>
          <Button variant="outline" onClick={handleDeny} disabled={busy}>
            {busy && state.action === "deny" ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <X className="h-4 w-4 mr-2" />
            )}
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}
