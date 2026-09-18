/**
 * App.tsx
 * ─────────────────────────────────────────────
 * Drop this at: artifacts/ayzen/src/App.tsx
 *
 * Router() is now driven by ADMIN_ROUTES / USER_ROUTES arrays.
 * To add a new page: edit lib/route-config.tsx only — this file stays clean.
 */

import { lazy, Suspense, useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { PluginsProvider } from "@/hooks/use-plugins";
import { DevNavProvider } from "@/hooks/use-dev-nav";
import { UiThemeProvider, ThemeRouteSync } from "@/hooks/use-ui-theme";
import { CustomButtonsProvider } from "@/hooks/use-custom-buttons";
import { AppLayout } from "@/components/layout/app-layout";
import { VaultUnlockGate } from "@/components/vault/vault-unlock-gate";
import { useRealtime } from "@/hooks/use-realtime";
import { ScrollToTop } from "@/components/scroll-to-top";
import { ErrorBoundary } from "@/components/error-boundary";
import { ADMIN_ROUTES, USER_ROUTES } from "@/lib/route-config";
import type { RouteConfig } from "@/lib/route-config";
import { getCurrentSubdomainApp, isPathInSubdomainScope } from "@/lib/subdomain-app";
// OIDC Roadmap — Season 3, Phase 5b-a/5b-b.
import { startSyloOidcLogin } from "@/lib/sylo-oidc-login";
// OIDC Roadmap — Season 3, Phase 5c-c: dual-run gate — reads the same
// rollout flag login.tsx's own cutover-redirect effect (5d-c) checks.
import { getSyloOidcRolloutFlag } from "@/lib/sylo-oidc-rollout-flag";

// ─── Overlay components (lazy — not on initial paint) ─────────────────────────

const AiChat          = lazy(() => import("@/components/ai-chat").then(m => ({ default: m.AiChat })));
const CommandSearch   = lazy(() => import("@/components/command-search").then(m => ({ default: m.CommandSearch })));
const KeyboardShortcuts = lazy(() => import("@/components/keyboard-shortcuts").then(m => ({ default: m.KeyboardShortcuts })));
const CustomButtonsOverlay = lazy(() => import("@/components/custom-buttons-overlay").then(m => ({ default: m.CustomButtonsOverlay })));

// ─── Auth pages — eager (users hit these before bundle splits matter) ─────────

import Login          from "@/pages/login";
import StatusPage     from "@/pages/status";
import Register       from "@/pages/register";
import ForgotPassword from "@/pages/forgot-password";
import Landing        from "@/pages/landing";
import NotFound       from "@/pages/not-found";
import EmergencyAccessConfirm from "@/pages/emergency-access/confirm";
import EmergencyAccessView    from "@/pages/emergency-access/view";
import FinanceReceiptPublic   from "@/pages/finance/receipt";
import FinanceInvoicePublic   from "@/pages/finance/invoice-public";
import FinancePaymentAgreementPublic from "@/pages/finance/payment-agreement-public";
import LocalEntityReceiptPublic from "@/pages/receipt/local";
import VaultEntityReceiptPublic from "@/pages/receipt/entity";
import ProjectPnlReceiptPublic  from "@/pages/receipt/project";
import TaskSubmissionReceiptPublic from "@/pages/receipt/task";
import VaultCategoryReceiptPublic  from "@/pages/receipt/vault-category";
// OIDC Roadmap — Season 3, Phase 5b-b: Callback Route.
import OidcCallback from "@/pages/oidc-callback";
import OidcConsent from "@/pages/oidc-consent";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function PageLoader() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="font-mono text-xs text-muted-foreground/50 animate-pulse tracking-widest uppercase">
        Loading...
      </div>
    </div>
  );
}

function ProtectedRoute({
  component: Component,
  adminOnly = false,
  allowedRoles,
  vaultGated = false,
  ...rest
}: Omit<RouteConfig, "path"> & { vaultGated?: boolean; [k: string]: any }) {
  const { user, isAdmin, isDev, isLoading } = useAuth();
  const [location] = useLocation();

  // AYZEN Workspace subdomain scoping (master plan §7 Phase 2 — Sylo
  // split). Read unconditionally, before any early return below, since
  // it's also needed by the OIDC Roadmap Phase 5b-a effect immediately
  // after it — a plain hostname/window.location read, not a hook, so
  // calling it here doesn't affect hook-ordering rules either way.
  const subdomainApp = getCurrentSubdomainApp();

  // OIDC Roadmap — Season 3, Phase 5c-c (dual-run gate, additive to 5b-a
  // below): BEFORE starting the OIDC redirect, ask the rollout flag
  // whether Sylo (or whichever app is scoped) is actually cut over yet.
  // `null` = "still checking" (initial state and the fail-safe-adjacent
  // "don't decide yet" value — never treated as either true or false
  // below); `getSyloOidcRolloutFlag()` itself already fails safe to
  // `false` on any read error/timeout, so this effect never needs its own
  // separate error handling (see that function's own header).
  const [oidcRolloutEnabled, setOidcRolloutEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!subdomainApp || isLoading || user) return;
    let cancelled = false;
    void getSyloOidcRolloutFlag(subdomainApp.id).then((enabled) => {
      if (!cancelled) setOidcRolloutEnabled(enabled);
    });
    return () => { cancelled = true; };
  }, [subdomainApp, isLoading, user]);

  // OIDC Roadmap — Season 3, Phase 5b-a: Login Entry Point, the other half
  // of "connect login action to OIDC authorize" (sylo-oidc-login.ts owns
  // the actual redirect logic). An unauthenticated hit on an in-scope
  // subdomain app (Sylo today) starts a real Authorization Code + PKCE
  // attempt instead of falling through to the generic credential-entry
  // `/login` form below — if the shared `ayzen_session` cookie is already
  // valid (the common case: the user signed in on ayzen.tech or another
  // *.ayzen.tech subdomain earlier), 3b-a's existing-session check on the
  // provider side lets the whole redirect round-trip complete silently,
  // landing the user back here already signed in to Sylo's OWN local
  // session (5b-e) with no credential form ever shown. If there's no
  // valid cookie, `/oidc/authorize` itself bounces through the ordinary
  // `/login` page (3b-b/3b-c, already built) exactly as it does for any
  // other unauthenticated `/oidc/authorize` hit — this is additive, not a
  // second, parallel login mechanism.
  //
  // Never runs on the main domain (`subdomainApp` is null there) — the
  // generic `/login` form below remains the only path for ayzen.tech
  // itself, unchanged from before this phase. As of Phase 5c, also never
  // runs while `oidcRolloutEnabled` is `false` — this is 5c-b's "keep the
  // old cookie path intact" made real: with the flag off, an
  // unauthenticated hit falls straight through to `/login` exactly as it
  // did before Phase 5b existed.
  const shouldStartOidcLogin = !isLoading && !user && !!subdomainApp && oidcRolloutEnabled === true;
  const oidcLoginStartedRef = useRef(false);
  useEffect(() => {
    if (!shouldStartOidcLogin) return;
    if (oidcLoginStartedRef.current) return;
    oidcLoginStartedRef.current = true;
    // No explicit returnToPath — sylo-oidc-login.ts's own default reads
    // window.location.pathname+search directly, which is exactly the
    // route this component is being asked to protect (wouter's `location`
    // here is derived from the same window.location in this codebase's
    // default, non-hash routing setup).
    void startSyloOidcLogin();
  }, [shouldStartOidcLogin, location]);

  if (isLoading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-primary font-mono">
        INITIALIZING...
      </div>
    );
  if (!user) {
    // 5c-c: only take the "OIDC redirect in flight" branch once the flag
    // check has resolved to `true` — `null` (still checking) renders the
    // identical loader below rather than racing ahead to either outcome,
    // and `false` falls through to the plain `/login` redirect exactly as
    // if `subdomainApp` were null, per 5c-b.
    if (subdomainApp && oidcRolloutEnabled !== false) {
      // The OIDC redirect above is in flight (or about to be), or the
      // flag check itself is still in flight — render the same full-screen
      // loader as the isLoading case above rather than a wouter
      // <Redirect>, since the destination here is an absolute,
      // cross-origin provider URL wouter has no notion of, not an SPA
      // route.
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-primary font-mono">
          INITIALIZING...
        </div>
      );
    }
    return <Redirect to="/login" />;
  }
  if (adminOnly && !isAdmin && !isDev) return <Redirect to="/dashboard" />;
  if (allowedRoles && !allowedRoles.includes(user.role)) return <Redirect to="/dashboard" />;

  // AYZEN Workspace subdomain scoping (master plan §7 Phase 2 — Sylo
  // split). On sylo.ayzen.tech (or any recognized subdomain), any route
  // outside that app's scope bounces back to its home page instead of
  // rendering — e.g. hitting /finance on sylo.ayzen.tech lands on /vault.
  // Everything is a no-op on the main domain (getCurrentSubdomainApp()
  // returns null there).
  if (subdomainApp && !isPathInSubdomainScope(location, subdomainApp)) {
    return <Redirect to={subdomainApp.homePath} />;
  }

  const page = (
    <Suspense fallback={<PageLoader />}>
      <Component {...rest} />
    </Suspense>
  );

  return (
    <AppLayout>
      {/* Phase 5 — Vault Security: every /vault/* route unlocks behind the
          vault-login PIN before its page mounts (see route mapping below). */}
      {vaultGated ? <VaultUnlockGate>{page}</VaultUnlockGate> : page}
    </AppLayout>
  );
}

// ─── Router ───────────────────────────────────────────────────────────────────

function Router() {
  const { user, isAdmin, isDev, isModerator, isTeamLeader } = useAuth();
  const subdomainApp = getCurrentSubdomainApp();

  return (
    <Switch>
      {/* Root redirect — role-based, or straight to the subdomain app's
          home when running on a scoped subdomain (e.g. sylo.ayzen.tech). */}
      <Route path="/">
        {user
          ? subdomainApp             ? <Redirect to={subdomainApp.homePath} />
          : (isAdmin || isDev)  ? <Redirect to="/admin/dashboard" />
          : isModerator         ? <Redirect to="/dashboard" />
          : isTeamLeader        ? <Redirect to="/teams" />
                                : <Redirect to="/home" />
          : <Landing />}
      </Route>

      {/* Public */}
      <Route path="/login"           component={Login} />
      <Route path="/register"        component={Register} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/status"          component={StatusPage} />
      {/* OIDC Roadmap — Season 3, Phase 5b-b: Callback Route. Outside
          ProtectedRoute entirely, same tier as /login — the whole point of
          this route is to establish the session, so it can't require one
          first. Also listed in subdomain-app.ts's ALWAYS_ALLOWED_PREFIXES
          so it renders regardless of which subdomain app is scoped. */}
      <Route path="/oidc/callback"   component={OidcCallback} />
      {/* Season 4, Phase 7b — consent screen. Standalone, outside
          ProtectedRoute/AppLayout, same tier as /login and /oidc/callback
          above: see pages/oidc-consent.tsx's own header for why. */}
      <Route path="/oidc/consent"    component={OidcConsent} />

      {/* Feature 16 — Emergency Access. Public, unauthenticated — these
          serve the links mailed to a nominated contact, who may not have
          an AYZEN account at all. Deliberately outside /vault (gated by
          the Vault's own PIN/passkey re-auth) and outside AppLayout/
          ProtectedRoute entirely, same tier as /login. */}
      <Route path="/emergency-access/confirm/:token" component={EmergencyAccessConfirm} />
      <Route path="/emergency-access/view/:token"    component={EmergencyAccessView} />

      {/* Finance — public, unauthenticated receipt link for a single ledger
          entry (routes/finance.ts GET /finance/receipt/:token). Same tier as
          the emergency-access links above — anyone with the link can view
          it, no AYZEN account required. */}
      <Route path="/finance/receipt/:token" component={FinanceReceiptPublic} />
      {/* Phase 5 — Invoices + peer payment gateway + payment agreements.
          Same public, unauthenticated, token-gated tier as the receipt link
          above; the pages themselves prompt for login only at the submit/
          confirm step (see routes/finance-invoices.ts). */}
      <Route path="/finance/invoice/:token" component={FinanceInvoicePublic} />
      <Route path="/finance/payment-agreement/:token" component={FinancePaymentAgreementPublic} />
      {/*
        Same tier as the finance receipt above — public, unauthenticated,
        token-gated "fantastic themed" receipts. See
        routes/local-accounts.ts, routes/vault.ts, routes/projects.ts
        ("Public receipt link" sections) and components/receipt/
        fantastic-receipt-view.tsx for the shared visual shell.
      */}
      <Route path="/receipt/local/:token"   component={LocalEntityReceiptPublic} />
      <Route path="/receipt/entity/:token"  component={VaultEntityReceiptPublic} />
      <Route path="/receipt/project/:token" component={ProjectPnlReceiptPublic} />
      <Route path="/receipt/task/:token"           component={TaskSubmissionReceiptPublic} />
      <Route path="/receipt/vault-category/:token" component={VaultCategoryReceiptPublic} />

      {/* Legacy NFT redirect */}
      <Route path="/nft-marketplace">
        {() => { window.location.replace("/marketplace?tab=nft"); return null; }}
      </Route>

      {/* Admin + Dev routes — from config */}
      {ADMIN_ROUTES.map(({ path, component, adminOnly, allowedRoles }) => (
        <Route key={path} path={path}>
          {() => (
            <ProtectedRoute
              component={component}
              adminOnly={adminOnly}
              allowedRoles={allowedRoles}
            />
          )}
        </Route>
      ))}

      {/* User routes — from config */}
      {USER_ROUTES.map(({ path, component }) => (
        <Route key={path} path={path}>
          {/* Phase 5 — Vault Security: any /vault/* path (the whole Vault
              section — Entity/Wallet/Local/Mail/KYC/Game tabs, and the
              Enroll/Security/Backup/Shared sidebar from Phase 4) unlocks
              behind the vault-login PIN. Note this is a distinct PIN and
              gate from EntityPinGate, which guards individual entity detail
              pages (see components/vault/entity-pin-gate.tsx). */}
          {/* /vault/security is exempt from the gate so users can enable 2FA
              there before the vault gate itself can be satisfied. */}
          {() => <ProtectedRoute component={component} vaultGated={path.startsWith("/vault") && path !== "/vault/security"} />}
        </Route>
      ))}

      <Route component={NotFound} />
    </Switch>
  );
}

// ─── Query client ─────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// ─── Providers ────────────────────────────────────────────────────────────────

function RealtimeProvider({ children }: { children: React.ReactNode }) {
  useRealtime();
  return <>{children}</>;
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  useEffect(() => {
    const saved = localStorage.getItem("ayzen_theme");
    document.documentElement.classList.toggle("dark", saved !== "light");
  }, []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <UiThemeProvider>
              <CustomButtonsProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <ThemeRouteSync />
                <PluginsProvider>
                  <DevNavProvider>
                    <RealtimeProvider>
                      <ErrorBoundary>
                        <Router />
                      </ErrorBoundary>
                      <Suspense fallback={null}>
                        <AiChat />
                        <CommandSearch />
                        <KeyboardShortcuts />
                        <CustomButtonsOverlay />
                      </Suspense>
                      <ScrollToTop />
                    </RealtimeProvider>
                  </DevNavProvider>
                </PluginsProvider>
              </WouterRouter>
              </CustomButtonsProvider>
            </UiThemeProvider>
          </AuthProvider>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
