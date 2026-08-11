/**
 * Role-based access control.
 *
 * Permissions are `resource:action` strings. `*` matches one segment,
 * so `evidence:*` grants every action on evidence but nothing else.
 * Denies are evaluated after grants and always win — this is what makes
 * "admin, but may never delete evidence" expressible.
 */

export type Role = 'owner' | 'admin' | 'operator' | 'analyst' | 'viewer';

export const ROLES: Role[] = ['owner', 'admin', 'operator', 'analyst', 'viewer'];

export interface RoleDefinition {
  role: Role;
  label: string;
  description: string;
  grants: string[];
  denies: string[];
}

/**
 * Note on evidence deletion: nobody, including the owner, is granted
 * `evidence:delete`. Evidence lives in an Object Lock bucket in compliance
 * mode, so the API could not honour a delete anyway — encoding that here
 * keeps the app layer honest about what the storage layer will actually do.
 */
export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  owner: {
    role: 'owner',
    label: 'Owner',
    description: 'Full control including billing, IAM and destructive infrastructure changes.',
    grants: ['*:*'],
    denies: ['evidence:delete'],
  },
  admin: {
    role: 'admin',
    label: 'Administrator',
    description: 'Manages users, sources, workflows and the agent fleet. No billing access.',
    grants: [
      'agent:*',
      'run:*',
      'source:*',
      'workflow:*',
      'anomaly:*',
      'evidence:read',
      'evidence:export',
      'audit:read',
      'user:*',
      'config:read',
      'config:write',
      'comment:*',
      'reply:*',
      'credential:*',
    ],
    denies: ['evidence:delete', 'billing:*', 'audit:write'],
  },
  operator: {
    role: 'operator',
    label: 'Operator',
    description: 'Runs the fleet day to day. Can trigger Beast mode and acknowledge anomalies.',
    grants: [
      'agent:read',
      'agent:start',
      'agent:stop',
      'agent:beast_mode',
      'run:create',
      'run:read',
      'run:cancel',
      'source:read',
      'source:create',
      'source:update',
      'workflow:read',
      'workflow:execute',
      'anomaly:read',
      'anomaly:acknowledge',
      'evidence:read',
      'audit:read',
      'comment:read',
      'comment:label',
      'reply:read',
      // Approving a draft is what puts words on the channel under the
      // operator's name. It sits with the role that runs the channel day to
      // day, not with analysts.
      'reply:approve',
      'credential:read',
    ],
    denies: [
      'evidence:delete',
      'evidence:export',
      'user:*',
      'config:write',
      'billing:*',
      // Connecting an account hands the system a refresh token that can write
      // to the channel indefinitely. That is an ownership decision.
      'credential:connect',
    ],
  },
  analyst: {
    role: 'analyst',
    label: 'Analyst',
    description: 'Reviews findings and builds workflows. Cannot command agents directly.',
    grants: [
      'agent:read',
      'run:read',
      'source:read',
      'workflow:read',
      'workflow:create',
      'workflow:update',
      'anomaly:read',
      'anomaly:acknowledge',
      'evidence:read',
      'comment:read',
      'reply:read',
    ],
    denies: [
      'agent:beast_mode',
      'evidence:delete',
      'evidence:export',
      'user:*',
      'billing:*',
      'reply:approve',
      'credential:*',
    ],
  },
  viewer: {
    role: 'viewer',
    label: 'Viewer',
    description: 'Read-only access to dashboards and findings.',
    grants: ['agent:read', 'run:read', 'source:read', 'workflow:read', 'anomaly:read'],
    denies: ['evidence:*', 'audit:*', 'user:*', 'billing:*'],
  },
};

function matches(pattern: string, permission: string): boolean {
  const p = pattern.split(':');
  const q = permission.split(':');
  if (p.length !== q.length) return false;
  return p.every((seg, i) => seg === '*' || seg === q[i]);
}

export interface AccessDecision {
  allowed: boolean;
  /** Which rule decided, for the audit trail. */
  matchedRule: string | null;
  reason: string;
}

export function decide(roles: Role[], permission: string): AccessDecision {
  for (const role of roles) {
    const def = ROLE_DEFINITIONS[role];
    if (!def) continue;
    const deny = def.denies.find((d) => matches(d, permission));
    if (deny) {
      return {
        allowed: false,
        matchedRule: `${role}:deny:${deny}`,
        reason: `role "${role}" explicitly denies "${permission}"`,
      };
    }
  }
  for (const role of roles) {
    const def = ROLE_DEFINITIONS[role];
    if (!def) continue;
    const grant = def.grants.find((g) => matches(g, permission));
    if (grant) {
      return {
        allowed: true,
        matchedRule: `${role}:grant:${grant}`,
        reason: `role "${role}" grants "${permission}" via "${grant}"`,
      };
    }
  }
  return {
    allowed: false,
    matchedRule: null,
    reason: `no role in [${roles.join(', ') || 'none'}] grants "${permission}"`,
  };
}

export function can(roles: Role[], permission: string): boolean {
  return decide(roles, permission).allowed;
}

/** Permissions granted to each agent's own IAM identity, not to humans. */
export const AGENT_SCOPES: Record<string, string[]> = {
  aria: ['source:read', 'observation:write', 'anomaly:write', 'memory:aria'],
  atlas: ['source:read', 'observation:write', 'anomaly:write', 'memory:atlas'],
  sentinel: ['source:read', 'observation:write', 'anomaly:write', 'stream:consume', 'memory:sentinel'],
  archivist: ['observation:read', 'anomaly:read', 'evidence:write', 'evidence:read', 'memory:archivist'],
  // No `reply:post` and no `comment:moderate`. Warden drafts and classifies;
  // the act of publishing a reply belongs to the orchestrator, behind a human
  // approval, so the agent is not holding a capability it must be trusted not
  // to use.
  warden: ['source:read', 'comment:write', 'comment:read', 'reply:draft', 'memory:warden'],
};
