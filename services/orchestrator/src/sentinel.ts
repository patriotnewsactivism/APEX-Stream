import { ExecutionsClient, JobsClient, protos } from '@google-cloud/run';
import type { Logger } from '@apex/core';

/**
 * Launches Sentinel on demand.
 *
 * In the lean profile Sentinel has a Cloud Run Job but no standing service,
 * so nothing runs -- and nothing is billed -- until an operator starts a
 * watch. This is the single largest cost lever in the platform: continuous
 * stream watching is roughly thirty times the cost of every other agent
 * combined, so it is opt-in per watch rather than something that quietly
 * stays on.
 *
 * Cloud Run Jobs bills only for actual execution time and needs no idle
 * reservation choice the way the Fargate task this replaced did -- there is
 * no on-demand/spot distinction left to make here. Networking (egress to the
 * public stream, no inbound) is a property of the Job resource itself,
 * configured out of band at `gcloud run jobs deploy` time, not of this
 * launcher.
 */
export interface SentinelLaunchConfig {
  /** Fully-qualified: projects/{project}/locations/{location}/jobs/{job} */
  jobName: string;
}

export function readSentinelConfig(env: NodeJS.ProcessEnv = process.env): SentinelLaunchConfig | null {
  const jobName = env.SENTINEL_JOB_NAME;
  if (!jobName) return null;
  return { jobName };
}

export class SentinelLauncher {
  private readonly jobs: JobsClient;
  private readonly executions: ExecutionsClient;

  constructor(
    private readonly config: SentinelLaunchConfig,
    private readonly log: Logger,
    jobs?: JobsClient,
    executions?: ExecutionsClient,
  ) {
    this.jobs = jobs ?? new JobsClient();
    this.executions = executions ?? new ExecutionsClient();
  }

  /** Starts one watch. Returns the execution name so the run can cancel it early. */
  async launch(input: {
    runId: string;
    sourceId: string;
    watchMinutes: number;
    segmentSeconds?: number;
  }): Promise<{ executionName: string | null; reason: string | null }> {
    const running = await this.runningCount();
    // A hard ceiling here as well as in Sentinel's own watchUntil logic: a
    // bug that dispatches a hundred watches should cost one execution, not a
    // hundred.
    if (running >= 2) {
      return { executionName: null, reason: `already watching ${running} streams; stop one before starting another` };
    }

    const [operation] = await this.jobs.runJob({
      name: this.config.jobName,
      overrides: {
        taskCount: 1,
        containerOverrides: [
          {
            env: [
              { name: 'APEX_RUN_ID', value: input.runId },
              { name: 'APEX_SOURCE_ID', value: input.sourceId },
              { name: 'APEX_WATCH_MINUTES', value: String(input.watchMinutes) },
              { name: 'APEX_SEGMENT_SECONDS', value: String(input.segmentSeconds ?? 30) },
            ],
          },
        ],
      },
    });

    // The Execution resource is created synchronously as part of accepting
    // the RunJob request -- well before the watch itself finishes, which can
    // take hours -- so the operation's metadata should already carry its
    // name without waiting on operation.promise(). Not verified against a
    // live project: if metadata comes back empty instead, the fallback below
    // picks up the execution this call just created (listExecutions is
    // sorted by creation time, descending).
    const metadata = operation.metadata as protos.google.cloud.run.v2.IExecution | null | undefined;
    const executionName = metadata?.name ?? (await this.newestExecutionName());

    if (!executionName) {
      this.log.error('sentinel launch failed', { jobName: this.config.jobName });
      return { executionName: null, reason: 'Cloud Run did not report the new execution name' };
    }

    this.log.info('sentinel watch launched', {
      executionName, sourceId: input.sourceId, watchMinutes: input.watchMinutes,
    });
    return { executionName, reason: null };
  }

  async stop(executionName: string, reason = 'operator stopped the watch'): Promise<void> {
    await this.executions.cancelExecution({ name: executionName });
    this.log.info('sentinel watch stopped', { executionName, reason });
  }

  async runningCount(): Promise<number> {
    const [executions] = await this.executions.listExecutions({ parent: this.config.jobName });
    return executions.filter((e) => !e.completionTime).length;
  }

  private async newestExecutionName(): Promise<string | null> {
    const [executions] = await this.executions.listExecutions({ parent: this.config.jobName, pageSize: 1 });
    return executions[0]?.name ?? null;
  }
}
