/**
 * Cognito hosted-UI authentication with PKCE.
 *
 * The authorisation-code flow with PKCE is used rather than the implicit flow:
 * no token ever appears in a URL or browser history, and there is no client
 * secret to leak into a bundle. Tokens live in memory and sessionStorage —
 * localStorage would keep them across tabs and browser restarts, which is
 * convenient and wrong for a console that can trigger Beast mode.
 */

export interface AuthConfig {
  domain: string;
  clientId: string;
  redirectUri: string;
}

export interface Session {
  accessToken: string;
  idToken: string;
  expiresAt: number;
  username: string;
  roles: string[];
}

const STORAGE_KEY = 'apex.session';
const VERIFIER_KEY = 'apex.pkce.verifier';

export function readAuthConfig(): AuthConfig | null {
  const domain = import.meta.env.VITE_COGNITO_DOMAIN;
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
  if (!domain || !clientId) return null;
  return { domain, clientId, redirectUri: `${window.location.origin}/callback` };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export async function beginSignIn(config: AuthConfig): Promise<void> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = base64Url(await sha256(verifier));

  const url = new URL(`${config.domain}/oauth2/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(url.toString());
}

export async function completeSignIn(config: AuthConfig, code: string): Promise<Session> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('Sign-in could not be completed — start again.');
  sessionStorage.removeItem(VERIFIER_KEY);

  const res = await fetch(`${config.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);

  const tokens = (await res.json()) as { access_token: string; id_token: string; expires_in: number };
  const claims = decodeClaims(tokens.id_token);
  const session: Session = {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    username: String(claims['cognito:username'] ?? claims.email ?? 'operator'),
    roles: Array.isArray(claims['cognito:groups']) ? (claims['cognito:groups'] as string[]) : [],
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

export function signOut(config: AuthConfig | null): void {
  sessionStorage.removeItem(STORAGE_KEY);
  if (config) {
    const url = new URL(`${config.domain}/logout`);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('logout_uri', window.location.origin);
    window.location.assign(url.toString());
  } else {
    window.location.assign('/');
  }
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
