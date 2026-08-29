/**
 * Session and account state.
 *
 * Deliberately small: one context holding who is signed in and what their balance was the last
 * time anything asked. Pages call `refreshAccount()` after a movement, which keeps the number on
 * screen honest without polling.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { endpoints, hasStoredSession, onSessionExpired, setSession, type AccountView } from './api';

export interface CurrentUser {
  id: string;
  phone: string;
  name: string;
}

interface AppState {
  user: CurrentUser | null;
  account: AccountView | null;
  loading: boolean;
  signIn: (phone: string, password: string) => Promise<void>;
  signUp: (input: { phone: string; name: string; password: string; pin: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshAccount: () => Promise<void>;
}

const Context = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  // Only "loading" when there is a stored session to restore; otherwise the sign-in screen is
  // the correct first paint and a spinner would just be a flash.
  const [loading, setLoading] = useState(hasStoredSession());

  const refreshAccount = useCallback(async () => {
    const me = await endpoints.me();
    setAccount(me.account);
  }, []);

  useEffect(() => {
    onSessionExpired(() => {
      setUser(null);
      setAccount(null);
    });

    if (!hasStoredSession()) return;

    void (async () => {
      try {
        const identity = await endpoints.identity();
        setUser(identity.user);
        await refreshAccount();
      } catch {
        // The stored refresh token is dead (expired, revoked, or from another deployment).
        setSession(null);
        setUser(null);
        setAccount(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshAccount]);

  const signIn = useCallback(
    async (phone: string, password: string) => {
      const result = await endpoints.login({ phone, password });
      setSession(result);
      setUser(result.user);
      await refreshAccount();
    },
    [refreshAccount],
  );

  const signUp = useCallback(
    async (input: { phone: string; name: string; password: string; pin: string }) => {
      const result = await endpoints.register(input);
      setSession(result);
      setUser(result.user);
      await refreshAccount();
    },
    [refreshAccount],
  );

  const signOut = useCallback(async () => {
    const stored = localStorage.getItem('takaflow.refresh');
    // Best effort: a failed logout must still clear the session on this device.
    if (stored) await endpoints.logout(stored).catch(() => undefined);
    setSession(null);
    setUser(null);
    setAccount(null);
  }, []);

  const value = useMemo<AppState>(
    () => ({ user, account, loading, signIn, signUp, signOut, refreshAccount }),
    [user, account, loading, signIn, signUp, signOut, refreshAccount],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useApp(): AppState {
  const value = useContext(Context);
  if (!value) throw new Error('useApp must be used inside AppStateProvider');
  return value;
}
