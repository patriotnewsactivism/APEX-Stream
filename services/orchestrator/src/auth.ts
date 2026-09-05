import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { AuthorizationError, decide, ROLES, type Role } from '@apex/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuditWriter } from './db.js';

/**
 * Identity Platform (Firebase Auth) ID token verification.
 *
 * `verifyIdToken()` checks signature, issuer and expiry, and also the
 * Firebase-specific claims a generic JWT verifier wouldn't know to check
 * (auth_time, token type) -- it already validates the token's audience
 * against whichever project the Admin SDK itself is initialized for, via
 * the same Application Default Credentials every other GCP client in this
 * codebase uses, so there is no separate project-id config to keep in sync
 * here the way COGNITO_CLIENT_ID had to be.
 *
 * Roles come from a custom claim (`roles`) set by the operator-provisioning
 * workflow via `setCustomUserClaims()`, so that workflow is the single
 * source of truth for authorisation and there is no second user table to
 * drift out of sync.
 */
export interface Principal {
  subject: string;
  username: string;
  email: string | null;
  roles: Role[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export class Authenticator {
  private readonly auth: Auth;

  constructor() {
    const app = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
    this.auth = getAuth(app);
  }

  async verify(token: string): Promise<Principal> {
    const decoded = await this.auth.verifyIdToken(token);

    const claimed = decoded.roles as unknown;
    const roles = Array.isArray(claimed) ? claimed.filter((r): r is Role => (ROLES as string[]).includes(r)) : [];

    return {
      subject: decoded.uid,
      username: String(decoded.email ?? decoded.uid),
      email: decoded.email ?? null,
      roles,
    };
  }
}

export function bearerFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Route guard. Denials are written to the audit log before the response is
 * sent — a refused privileged action is exactly the event you want a record of.
 */
export function requirePermission(
  permission: string,
  audit: AuditWriter,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const principal = request.principal;
    if (!principal) {
      await reply.code(401).send({ error: 'unauthenticated', message: 'Sign in to continue.' });
      return;
    }
    const decision = decide(principal.roles, permission);
    if (!decision.allowed) {
      await audit.append({
        actor: principal.username,
        actorType: 'human',
        action: 'rbac.denied',
        resourceType: 'permission',
        resourceId: permission,
        detail: { roles: principal.roles, reason: decision.reason, path: request.url, method: request.method },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        traceId: request.id,
        outcome: 'denied',
      });
      const err = new AuthorizationError(permission, decision.reason);
      await reply.code(403).send(err.toJSON());
    }
  };
}
