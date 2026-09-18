import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { User } from "@workspace/api-client-react";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { clearAllVaultLocks } from "@/lib/vault-lock";

/**
 * Multi-account switching ("Google-style" account chooser)
 * ─────────────────────────────────────────────────────────────────────────
 * AYZEN's Mail/Vault/Finance/Marketplace surfaces are all one SPA sharing a
 * single login token, so logging in once already grants access to every
 * module — that's the SSO part. What Google-style account switching adds on
 * top is letting a browser hold *several* signed-in AYZEN accounts at once
 * (e.g. a personal + a team account) and instantly flip between them
 * without re-entering a password each time, the way clicking your avatar
 * in Gmail and picking another account does.
 *
 * `ayzen_accounts` in localStorage is that saved list: { id, username,
 * email, avatarUrl, role, token }, upserted on every "keep me signed in"
 * login. Switching is just re-pointing ayzen_user/ayzen_token at one of
 * those entries — no network round-trip needed, exactly like Google's
 * picker. The server is still the source of truth for whether a token is
 * actually valid: if a saved token has since expired or been revoked from
 * the Security → Sessions & Devices page, the very next API call 401s and
 * the normal auth-required redirect takes over, so this is a UX
 * convenience layer, not a new trust boundary.
 *
 * Ephemeral ("keep me signed in" OFF) logins are intentionally never added
 * here — they stay in sessionStorage only, matching the existing
 * readStorage/clearStorage split below.
 */

export interface SavedAccount {
  id: number;
  username: string;
  email: string;
  avatarUrl?: string | null;
  role: string;
  token: string;
  addedAt: number;
}

const ACCOUNTS_KEY = "ayzen_accounts";

function readAccounts(): SavedAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: SavedAccount[]) {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch { /* storage full/unavailable — account switcher just won't persist */ }
}

function upsertAccount(u: User, token: string, accounts: SavedAccount[]): SavedAccount[] {
  const entry: SavedAccount = {
    id: (u as any).id,
    username: (u as any).username,
    email: (u as any).email,
    avatarUrl: (u as any).avatarUrl ?? null,
    role: (u as any).role,
    token,
    addedAt: Date.now(),
  };
  const next = accounts.filter(a => a.id !== entry.id);
  next.unshift(entry);
  return next;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (user: User, token: string, keepSignedIn?: boolean) => void;
  logout: () => void;
  isAdmin: boolean;
  isDev: boolean;
  isModerator: boolean;
  isTeamLeader: boolean;
  isLoading: boolean;
  /** Other AYZEN accounts saved on this browser (Google-style account chooser), most recently used first. Never includes the currently active account. */
  accounts: SavedAccount[];
  /** Instantly switch the active session to a saved account — no re-login, no network call (see module docblock). */
  switchAccount: (id: number) => void;
  /** Forget a saved account. If it's the active one, also logs out. */
  removeAccount: (id: number) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

function readStorage(key: string): string | null {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key);
}

function clearStorage(key: string) {
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);

  const doLogout = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStorage("ayzen_user");
    clearStorage("ayzen_token");
    setAuthTokenGetter(null);
    // Phase 5 — Vault Security: a fresh login should never inherit a
    // previous session's unlocked Vault/entity-view state.
    clearAllVaultLocks();
  }, []);

  useEffect(() => {
    setAuthTokenGetter(() => readStorage("ayzen_token"));

    const storedUser = readStorage("ayzen_user");
    const storedToken = readStorage("ayzen_token");
    let activeId: number | null = null;
    if (storedUser && storedToken) {
      try {
        const parsedUser = JSON.parse(storedUser);
        setUser(parsedUser);
        setToken(storedToken);
        activeId = parsedUser?.id ?? null;
      } catch { }
    }

    setAccounts(readAccounts().filter(a => a.id !== activeId));
    setIsLoading(false);
  }, []);

  const login = useCallback((u: User, t: string, keepSignedIn = true) => {
    setUser(u);
    setToken(t);
    const storage = keepSignedIn ? localStorage : sessionStorage;
    clearStorage("ayzen_user");
    clearStorage("ayzen_token");
    storage.setItem("ayzen_user", JSON.stringify(u));
    storage.setItem("ayzen_token", t);
    setAuthTokenGetter(() => t);

    if (keepSignedIn) {
      const next = upsertAccount(u, t, readAccounts());
      writeAccounts(next);
      setAccounts(next.filter(a => a.id !== (u as any).id));
    }
  }, []);

  const logout = useCallback(() => {
    doLogout();
    // Sign-out only ends the *active* session — other saved accounts stay
    // available in the switcher, mirroring Google's account chooser
    // appearing again after you sign out of one account.
    setAccounts(readAccounts());
  }, [doLogout]);

  const switchAccount = useCallback((id: number) => {
    const saved = readAccounts();
    const target = saved.find(a => a.id === id);
    if (!target) return;

    // The account currently active (if any) goes back into the saved list
    // before we swap, so switching A → B → A doesn't lose A.
    const currentUser = user as any;
    let list = saved;
    if (currentUser && token) {
      list = upsertAccount(currentUser, token, saved);
    }
    writeAccounts(list);

    const nextUser: User = { id: target.id, username: target.username, email: target.email, avatarUrl: target.avatarUrl, role: target.role } as unknown as User;
    setUser(nextUser);
    setToken(target.token);
    clearStorage("ayzen_user");
    clearStorage("ayzen_token");
    localStorage.setItem("ayzen_user", JSON.stringify(nextUser));
    localStorage.setItem("ayzen_token", target.token);
    setAuthTokenGetter(() => target.token);
    clearAllVaultLocks();

    setAccounts(list.filter(a => a.id !== target.id));
  }, [user, token]);

  const removeAccount = useCallback((id: number) => {
    const remaining = readAccounts().filter(a => a.id !== id);
    writeAccounts(remaining);
    if ((user as any)?.id === id) {
      doLogout();
      setAccounts(remaining);
    } else {
      setAccounts(remaining.filter(a => a.id !== (user as any)?.id));
    }
  }, [user, doLogout]);

  return (
    <AuthContext.Provider value={{
      user, token, login, logout,
      isAdmin: user?.role === "admin",
      isDev: user?.role === "dev",
      isModerator: user?.role === "moderator",
      isTeamLeader: user?.role === "teamleader",
      isLoading,
      accounts,
      switchAccount,
      removeAccount,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
