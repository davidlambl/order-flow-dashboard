// src/contexts/AuthContext.ts
// Who is using the dashboard, for everything below App that used to take it as props: Header's badge and sign-out
// button, the PremiumGates, ChatBot's lock screen and AppSettings' Account tab. App builds the value from
// usePremiumStatus (the stored access token) and its Supabase session state, and provides it with React 19's
// context-as-provider element, <AuthContext value={auth}>; useAuth() reads it and throws outside the provider,
// since nothing below App renders without one. The leaves that take only their own slice of the market data
// (KPICards, GexChart, FlowChart) read neither context and stay on props.

import { createContext, useContext } from 'react';

export interface AuthValue {
  /** usePremiumStatus: a stored access token whose `exp` is still ahead of the clock (the gates, the PRO badge). */
  isPremium: boolean;
  /** usePremiumStatus: the token's `tier` claim, read whether or not it has expired; null without one. */
  tokenTier: string | null;
  /** usePremiumStatus: whole days until the token expires, rounded up; 0 once it has. */
  daysLeft: number;
  /** A Supabase session is signed in (App's session state). */
  signedIn: boolean;
  /** The signed-in account's e-mail; undefined without a session (AppSettings' Account tab). */
  userEmail: string | undefined;
  /** App's handleSignOut: confirm, flush a pending edit, end both logins and clear this browser's copy of the data. */
  signOut: () => Promise<void>;
  /** App's handleSignIn: back to the sign-in screen; undefined when cloud sign-in is not configured (no Supabase client). */
  signIn: (() => void) | undefined;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth: no AuthContext above this component (App provides it)');
  return value;
}
