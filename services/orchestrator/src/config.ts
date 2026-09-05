import { z } from 'zod';

/**
 * Configuration is validated once at boot and then frozen. A container that
 * cannot serve correctly should refuse to start rather than fail later on a
 * request path, where the failure is harder to attribute.
 */
const schema = z.object({
  APEX_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_CA_REQUIRED: z.coerce.boolean().default(true),
  /** Only needed for a Postgres host whose cert doesn't chain to a public CA. */
  DATABASE_CA_BUNDLE_PATH: z.string().optional(),
  DB_NAME: z.string().default('apex'),

  EVIDENCE_BUCKET: z.string().min(1),
  GCP_KMS_KEY_NAME: z.string().min(1),

  NOTIFY_SNS_TOPIC_ARN: z.string().optional(),
  NOTIFY_FROM_EMAIL: z.string().email().optional(),
  DASHBOARD_ORIGIN: z.string().default('*'),

  /** Ceiling any single Beast run may request. Operators cannot exceed it. */
  BEAST_MAX_BUDGET_USD: z.coerce.number().default(50),
  BEAST_MAX_DURATION_MINUTES: z.coerce.number().int().default(120),
  BEAST_MAX_CONCURRENT_TASKS: z.coerce.number().int().default(24),
});

export type Config = Readonly<z.infer<typeof schema>>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration — refusing to start:\n${detail}`);
  }
  const value = parsed.data;
  cached = Object.freeze(value);
  return cached;
}
