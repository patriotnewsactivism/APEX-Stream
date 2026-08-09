/**
 * Structured JSON logging. CloudWatch Logs Insights can query these fields
 * directly, so keep values flat and machine-readable.
 *
 * Redaction is deny-by-default on key name: anything that looks like a secret
 * is masked before it reaches stdout. It is cheaper to over-redact than to
 * discover a token in a log group six months later.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(pass|secret|token|key|credential|authorization|cookie|session|private)/i;
const MAX_STRING = 2000;

function redact(value: unknown, keyName = '', depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY.test(keyName)) return '[redacted]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 8) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, keyName, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LogContext {
  service?: string;
  agentId?: string;
  runId?: string;
  taskId?: string;
  traceId?: string;
  [key: string]: unknown;
}

export class Logger {
  private readonly threshold: number;

  constructor(
    private readonly context: LogContext = {},
    level: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info',
  ) {
    this.threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  }

  /** Returns a logger that carries extra context on every line. */
  child(extra: LogContext): Logger {
    return new Logger({ ...this.context, ...extra });
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(redact(this.context) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.emit('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.emit('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.emit('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.emit('error', msg, fields); }
}

export const rootLogger = new Logger({ service: process.env.APEX_SERVICE ?? 'apex' });
