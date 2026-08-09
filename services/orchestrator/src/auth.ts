import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthorizationError, decide, ROLES, type Role } from '@apex/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { AuditWriter } from './db.js';

/**
 * Cognito JWT verification.
 *
 * Access tokens are verified against the pool's published JWKS — signature,
 * issuer, audience and expiry. Roles come from `cognito:groups`, so group
 * membership in Cognito is the single source of truth for authorisation and
 * there is no second user table to drift out of sync.
 */
export interface Principal {
  subject: string;
  username: string;
  email: string | null;
  roles: Role[];
  tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export class Authenticator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;

  constructor(private readonly config: Config) {
    this.issuer = `https://cognito-idp.${config.AWS_REGION}.amazonaws.com/${config.COGNITO_USER_POOL_ID}`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      clockTolerance: 30,
    });

    // Cognito access tokens carry client_id; id tokens carry aud. Accept either
    // but require it to match this application.
    const audience = (payload.aud as string | undefined) ?? (payload.client_id as string | undefined);
    if (audience !== this.config.COGNITO_CLIENT_ID) {
      throw new Error('token was issued for a different application');
    }
    if (payload.token_use !== 'access' && payload.token_use !== 'id') {
      throw new Error('unexpected token_use');
    }

    const groups = Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as string[]) : [];
    const roles = groups.filter((g): g is Role => (ROLES as string[]).includes(g));

    return {
      subject: String(payload.sub),
      username: String(payload.username ?? payload['cognito:username'] ?? payload.sub),
      email: (payload.email as string | undefined) ?? null,
      roles,
      tokenId: String(payload.jti ?? ''),
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
