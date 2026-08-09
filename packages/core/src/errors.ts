/** Typed errors so callers can branch on cause instead of parsing messages. */
export class ApexError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 500,
    readonly retryable = false,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApexError';
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, detail: this.detail };
  }
}

export class ValidationError extends ApexError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, 'VALIDATION_FAILED', 400, false, detail);
    this.name = 'ValidationError';
  }
}

export class AuthorizationError extends ApexError {
  constructor(permission: string, reason: string) {
    super(`Access denied for "${permission}": ${reason}`, 'ACCESS_DENIED', 403, false, { permission, reason });
    this.name = 'AuthorizationError';
  }
}

export class BudgetExceededError extends ApexError {
  constructor(runId: string, accrued: number, limit: number) {
    super(
      `Run ${runId} halted: accrued $${accrued.toFixed(2)} exceeds budget $${limit.toFixed(2)}`,
      'BUDGET_EXCEEDED',
      409,
      false,
      { runId, accrued, limit },
    );
    this.name = 'BudgetExceededError';
  }
}

export class UpstreamError extends ApexError {
  constructor(source: string, message: string) {
    super(`Upstream "${source}" failed: ${message}`, 'UPSTREAM_FAILED', 502, true, { source });
    this.name = 'UpstreamError';
  }
}
