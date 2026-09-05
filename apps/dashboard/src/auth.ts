/**
 * Identity Platform (Firebase Auth) email/password sign-in.
 *
 * Direct REST calls to the Identity Toolkit API, matching this file's own
 * prior style rather than adding the Firebase JS SDK as a dependency just
 * for a sign-in form and a token decode. Tokens live in memory and
 * sessionStorage — localStorage would keep them across tabs and browser
 * restarts, which is convenient and wrong for a console that can trigger
 * Beast mode.
 *
 * The web API key identifies the project; it is not a secret — Identity
 * Platform's actual security boundary is the backend's token verification,
 * not this key's secrecy. See
 * https://firebase.google.com/docs/projects/api-keys.
 *
 * Unlike the Cognito hosted-UI flow this replaces, there is no redirect and
 * no PKCE dance: sign-in is a direct POST from a form on this page, and
 * sign-out is purely local (Identity Platform has no server-side logout
 * endpoint to visit).
 */

export interface AuthConfig {
  apiKey: string;
}

export interface Session {
  /** The ID token — sent as the bearer token and decoded for display claims. */
  idToken: string;
  expiresAt: number;
  username: string;
  roles: string[];
}

const STORAGE_KEY = 'apex.session';

export function readAuthConfig(): AuthConfig | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  if (!apiKey) return null;
  return { apiKey };
}

interface IdentityToolkitError {
  error?: { message?: string };
}

export async function signIn(config: AuthConfig, email: string, password: string): Promise<Session> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = (await res.json()) as IdentityToolkitError & { idToken?: string; expiresIn?: string };
  if (!res.ok || !body.idToken || !body.expiresIn) {
    throw new Error(body.error?.message ?? `Sign-in failed (${res.status})`);
  }

  const claims = decodeClaims(body.idToken);
  const roles = Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
  const session: Session = {
    idToken: body.idToken,
    expiresAt: Date.now() + Number(body.expiresIn) * 1000,
    username: String(claims.email ?? claims.user_id ?? claims.sub ?? 'operator'),
    roles,
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function loadSession(): Session | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    // Expire a minute early so a call cannot fail mid-flight on a stale token.
    // Identity Platform ID tokens are always short-lived (about an hour) with
    // no session-length configuration the way Cognito had, and this file
    // does not implement silent refresh — re-signing in is the only path
    // back once a token expires.
    if (session.expiresAt < Date.now() + 60_000) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function signOut(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** Reads claims for display only — the API verifies signatures, not the browser. */
function decodeClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Mirrors the server-side RBAC table so the UI hides what it cannot do. */
const ROLE_GRANTS: Record<string, string[]> = {
  owner: ['*:*'],
  admin: ['agent:*', 'run:*', 'source:*', 'workflow:*', 'anomaly:*', 'evidence:read', 'audit:read', 'user:*'],
  operator: ['agent:read', 'agent:beast_mode', 'run:create', 'run:read', 'run:cancel', 'source:read', 'source:create', 'source:update', 'workflow:read', 'workflow:execute', 'anomaly:read', 'anomaly:acknowledge', 'evidence:read', 'audit:read'],
  analyst: ['agent:read', 'run:read', 'source:read', 'workflow:read', 'workflow:create', 'workflow:update', 'anomaly:read', 'anomaly:acknowledge', 'evidence:read'],
  viewer: ['agent:read', 'run:read', 'source:read', 'workflow:read', 'anomaly:read'],
};
const ROLE_DENIES: Record<string, string[]> = {
  owner: ['evidence:delete'],
  admin: ['evidence:delete', 'billing:*'],
  operator: ['evidence:delete', 'evidence:export', 'user:*'],
  analyst: ['agent:beast_mode', 'evidence:delete', 'evidence:export', 'user:*'],
  viewer: ['evidence:*', 'audit:*', 'user:*'],
};

function matches(pattern: string, permission: string): boolean {
  const p = pattern.split(':');
  const q = permission.split(':');
  return p.length === q.length && p.every((seg, i) => seg === '*' || seg === q[i]);
}

/**
 * Client-side permission check. Hides controls the user cannot use — it is a
 * usability affordance, never a security boundary. The server re-checks every
 * request and is the only thing that actually enforces this.
 */
export function can(roles: string[], permission: string): boolean {
  for (const role of roles) {
    if ((ROLE_DENIES[role] ?? []).some((d) => matches(d, permission))) return false;
  }
  return roles.some((role) => (ROLE_GRANTS[role] ?? []).some((g) => matches(g, permission)));
}
