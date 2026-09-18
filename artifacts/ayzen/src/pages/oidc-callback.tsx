/**
 * pages/oidc-callback.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5b-b: Callback Route.
 *
 * "Receive authorization response" — this is the page mounted at
 * `/oidc/callback`, the exact path `sylo-oidc-config.ts`'s
 * `SYLO_OIDC_CALLBACK_PATH` builds into the `redirect_uri` sent at 5b-a,
 * and the exact path `seed-oidc-clients.ts` registered
 * (`https://<client_id>.ayzen.tech/oidc/callback`). Deliberately a thin
 * wrapper: every actual decision (state verification, token exchange,
 * session establishment, error classification) lives in
 * `lib/sylo-oidc-callback.ts` (5b-c/5b-d/5b-e/5b-f) so it's unit-testable
 * without mounting this component — this file's only job is wiring that
 * logic to React lifecycle, `useAuth()`, and navigation.
 *
 * RUNS EXACTLY ONCE PER MOUNT
 * `completeSyloOidcLogin()` consumes the pending transaction and (via
 * `consumeAuthorizationCode()` on the provider side) the authorization
 * code itself — a second attempt with the same URL would fail anyway
 * (`invalid_grant`, the code was already redeemed), so the effect below
 * guards against React 18 Strict Mode's dev-only double-invoke with a
 * ref, not just an empty dependency array.
 *
 * 5b-f, CONCRETELY: three renderable states — `"working"` (spinner,
 * matches `ProtectedRoute`'s own "INITIALIZING..." full-screen style so
 * there's no visual seam between "redirecting for login" and "finishing
 * login"), `"error"` (message from `describeSyloOidcCallbackError()`, a
 * "Try again" button that restarts 5b-a, and a link back to the ordinary
 * `/login` form as a fallback that never depends on OIDC working), and
 * the success case, which never actually renders — it navigates away via
 * `setLocation()` before a frame would show anything.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { getSyloOidcClientConfig } from "@/lib/sylo-oidc-config";
import { getSyloOidcProviderMetadata } from "@/lib/sylo-oidc-discovery";
import { startSyloOidcLogin } from "@/lib/sylo-oidc-login";
import { exchangeCodeForTokens } from "@/lib/oidc-client";
import { exchangeSyloSessionCookie } from "@/lib/sylo-oidc-session-exchange";
import {
  parseSyloOidcCallbackParams,
  readPendingSyloOidcTransaction,
  clearPendingSyloOidcTransaction,
  completeSyloOidcLogin,
  describeSyloOidcCallbackError,
  reportSyloOidcCallbackError,
  SyloOidcCallbackError,
} from "@/lib/sylo-oidc-callback";

type CallbackState = { kind: "working" } | { kind: "error"; title: string; description: string; canRetry: boolean };

export default function OidcCallback() {
  const [, setLocation] = useLocation();
  const { login: setAuthContext } = useAuth() as any;
  const [state, setState] = useState<CallbackState>({ kind: "working" });
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      const params = parseSyloOidcCallbackParams(window.location.search);
      const pending = readPendingSyloOidcTransaction();

      try {
        const config = getSyloOidcClientConfig();
        const metadata = await getSyloOidcProviderMetadata();

        const result = await completeSyloOidcLogin(params, pending, {
          config,
          metadata,
          exchangeCode: exchangeCodeForTokens,
          sessionExchange: exchangeSyloSessionCookie,
        });

        // Sylo's own session model (Phase 5b-e) — same call shape every
        // other login path in this codebase already ends with
        // (login.tsx's backendLogin/handleMagicVerify/passkey sign-in).
        // `keepSignedIn` defaults true here: an OIDC round-trip only ever
        // completes when the shared central cookie was already valid, so
        // there is no separate "remember me" choice being made at this
        // step the way the credential-form login page has to ask for.
        setAuthContext(result.user, result.token, true);

        setLocation(result.returnToPath || "/", { replace: true });
      } catch (err) {
        clearPendingSyloOidcTransaction();
        // Season 3, Phase 5e-b (additive) — best-effort, never blocks
        // rendering the error state below. See
        // reportSyloOidcCallbackError()'s own header for why
        // "provider_error" is deliberately excluded.
        if (err instanceof SyloOidcCallbackError) reportSyloOidcCallbackError(err.code);
        const described = describeSyloOidcCallbackError(err);
        setState({ kind: "error", ...described });
      }
    })();
  }, []);

  if (state.kind === "working") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-primary font-mono gap-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>FINISHING SIGN-IN...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-sm w-full text-center space-y-4">
        <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
        <h1 className="text-lg font-semibold">{state.title}</h1>
        <p className="text-sm text-muted-foreground">{state.description}</p>
        <div className="flex flex-col gap-2 pt-2">
          {state.canRetry && (
            <Button onClick={() => { void startSyloOidcLogin("/"); }}>
              Try again
            </Button>
          )}
          <Button variant="outline" onClick={() => setLocation("/login")}>
            Use the sign-in form instead
          </Button>
        </div>
      </div>
    </div>
  );
}
