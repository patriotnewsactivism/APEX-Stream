/**
 * Environment configuration.
 *
 * Two profiles ship: `dev` is tuned to spend as little as possible while idle,
 * `prod` is tuned for availability. The differences are concentrated here so
 * the stacks read identically and nobody has to grep for `if (prod)`.
 */
export type EnvName = 'dev' | 'staging' | 'prod';

export interface ApexEnvConfig {
  envName: EnvName;
  /** Two NAT gateways cost ~$65/month; one is a single AZ dependency. */
  natGateways: number;
  /** Aurora Serverless v2 floor. 0 lets the cluster pause when truly idle. */
  auroraMinAcu: number;
  auroraMaxAcu: number;
  auroraMultiAz: boolean;
  auroraBackupRetentionDays: number;
  /**
   * This AWS account is on the new (2026) "Free Plan" tier, which rejects
   * standard Aurora cluster creation entirely -- it only allows Aurora via
   * the new "Express Configuration" quick-create flow, which CDK doesn't
   * support yet (see aws/aws-cdk#37537). Confirmed live via a real
   * CREATE_FAILED: "To use Aurora clusters with free plan accounts you need
   * to set WithExpressConfiguration." Don's call: stay free, don't upgrade
   * the account. So dev/staging use a single small standard RDS instance
   * (db.t4g.micro, 20GB gp2 -- genuinely AWS-Free-Tier-eligible, $0/mo)
   * instead of Aurora Serverless v2. Prod keeps Aurora Serverless v2 as
   * designed; flip this back to true for dev once the account is upgraded
   * or CDK adds Express Configuration support.
   */
  auroraServerless: boolean;
  /** Fargate Spot is ~70% cheaper and fine for interruptible collectors. */
  useFargateSpot: boolean;
  orchestrator: { cpu: number; memoryMiB: number; minCount: number; maxCount: number };
  agents: Record<'aria' | 'atlas' | 'sentinel' | 'archivist' | 'warden', { cpu: number; memoryMiB: number; minCount: number; maxCount: number }>;
  evidenceRetentionYears: number;
  logRetentionDays: number;
  /** Monthly spend that triggers an alert. Set it below your credit burn rate. */
  monthlyBudgetUsd: number;
  alertEmail: string;
  removalProtection: boolean;
}

const AGENT_SIZES_DEV: ApexEnvConfig['agents'] = {
  aria: { cpu: 256, memoryMiB: 512, minCount: 1, maxCount: 4 },
  atlas: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 4 },
  // Sentinel holds long-lived stream connections, so it gets real memory and
  // scales to zero when nothing is being watched — it is the expensive agent.
  sentinel: { cpu: 1024, memoryMiB: 2048, minCount: 0, maxCount: 3 },
  archivist: { cpu: 256, memoryMiB: 512, minCount: 1, maxCount: 4 },
  // Warden is I/O-bound, not compute-bound: it waits on YouTube and on model
  // calls. It stays at one task because live chat has a single cursor per
  // source — a second task would race the first for the same page, spend the
  // same quota twice, and gain nothing.
  warden: { cpu: 256, memoryMiB: 512, minCount: 1, maxCount: 1 },
};

const AGENT_SIZES_PROD: ApexEnvConfig['agents'] = {
  aria: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 12 },
  atlas: { cpu: 1024, memoryMiB: 2048, minCount: 1, maxCount: 10 },
  sentinel: { cpu: 2048, memoryMiB: 4096, minCount: 0, maxCount: 6 },
  archivist: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 8 },
  // Still one task, for the live-chat cursor reason above — production buys it
  // more headroom per task rather than more tasks.
  warden: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 1 },
};

export function envConfig(envName: EnvName, alertEmail: string): ApexEnvConfig {
  const base = {
    envName,
    evidenceRetentionYears: 7,
    alertEmail,
  };

  if (envName === 'prod') {
    return {
      ...base,
      natGateways: 2,
      auroraMinAcu: 0.5,
      auroraMaxAcu: 16,
      auroraMultiAz: true,
      auroraBackupRetentionDays: 30,
      auroraServerless: true,
      useFargateSpot: false,
      orchestrator: { cpu: 1024, memoryMiB: 2048, minCount: 2, maxCount: 10 },
      agents: AGENT_SIZES_PROD,
      logRetentionDays: 90,
      monthlyBudgetUsd: 500,
      removalProtection: true,
    };
  }

  return {
    ...base,
    natGateways: 1,
    auroraMinAcu: 0.5,
    auroraMaxAcu: 4,
    auroraMultiAz: false,
    // This AWS account is Free-Tier-constrained: RDS rejects any automated
    // backup retention period above the free-tier max (confirmed live via a
    // real CREATE_FAILED: "specified backup retention period exceeds the
    // maximum available to free tier customers"). 1 day is the max allowed.
    auroraBackupRetentionDays: 1,
    auroraServerless: false,
    useFargateSpot: true,
    orchestrator: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 4 },
    agents: AGENT_SIZES_DEV,
    logRetentionDays: 14,
    monthlyBudgetUsd: envName === 'staging' ? 200 : 75,
    removalProtection: false,
  };
}
