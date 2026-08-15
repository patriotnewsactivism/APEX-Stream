import { ECSClient, RunTaskCommand, ListTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import type { Logger } from '@apex/core';

/**
 * Launches Sentinel on demand.
 *
 * In the lean profile Sentinel has a task definition but no service, so nothing
 * runs — and nothing is billed — until an operator starts a watch. This is the
 * single largest cost lever in the platform: continuous stream watching is
 * roughly thirty times the cost of every other agent combined, so it is opt-in
 * per watch rather than something that quietly stays on.
 *
 * Tasks run in a public subnet with a public IP and a security group that
 * permits no inbound traffic. Egress through the internet gateway is free,
 * where routing the same traffic through NAT would cost $32/month plus data
 * for a container that may run for twenty minutes a week.
 */
export interface SentinelLaunchConfig {
  clusterArn: string;
  taskDefinition: string;
  subnetIds: string[];
  securityGroupId: string;
  useSpot: boolean;
}

export function readSentinelConfig(env: NodeJS.ProcessEnv = process.env): SentinelLaunchConfig | null {
  const clusterArn = env.SENTINEL_CLUSTER_ARN;
  const taskDefinition = env.SENTINEL_TASK_DEFINITION;
  const subnets = env.SENTINEL_SUBNET_IDS;
  const securityGroupId = env.SENTINEL_SECURITY_GROUP_ID;
  if (!clusterArn || !taskDefinition || !subnets || !securityGroupId) return null;
  return {
    clusterArn,
    taskDefinition,
    subnetIds: subnets.split(',').filter(Boolean),
    securityGroupId,
    useSpot: env.APEX_ENV !== 'prod',
  };
}

export class SentinelLauncher {
  private readonly ecs: ECSClient;

  constructor(
    private readonly config: SentinelLaunchConfig,
    private readonly log: Logger,
    client?: ECSClient,
  ) {
    this.ecs = client ?? new ECSClient({});
  }

  /** Starts one watch. Returns the task ARN so the run can stop it early. */
  async launch(input: {
    runId: string;
    sourceId: string;
    watchMinutes: number;
    segmentSeconds?: number;
  }): Promise<{ taskArn: string | null; reason: string | null }> {
    const running = await this.runningCount();
    // A hard ceiling here as well as in the task definition: a bug that
    // dispatches a hundred watches should cost one container, not a hundred.
    if (running >= 2) {
      return { taskArn: null, reason: `already watching ${running} streams; stop one before starting another` };
    }

    const res = await this.ecs.send(
      new RunTaskCommand({
        cluster: this.config.clusterArn,
        taskDefinition: this.config.taskDefinition,
        count: 1,
        capacityProviderStrategy: this.config.useSpot
          ? [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]
          : [{ capacityProvider: 'FARGATE', weight: 1 }],
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.config.subnetIds,
            securityGroups: [this.config.securityGroupId],
            // Required without a NAT gateway: this is how the task reaches the
            // stream and the AWS APIs at all.
            assignPublicIp: 'ENABLED',
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: 'sentinel',
              environment: [
                { name: 'APEX_RUN_ID', value: input.runId },
                { name: 'APEX_SOURCE_ID', value: input.sourceId },
                { name: 'APEX_WATCH_MINUTES', value: String(input.watchMinutes) },
                { name: 'APEX_SEGMENT_SECONDS', value: String(input.segmentSeconds ?? 30) },
              ],
            },
          ],
        },
        tags: [
          { key: 'Project', value: 'APEX-Stream' },
          { key: 'RunId', value: input.runId },
        ],
        propagateTags: 'TASK_DEFINITION',
      }),
    );

    const taskArn = res.tasks?.[0]?.taskArn ?? null;
    const failure = res.failures?.[0];
    if (!taskArn) {
      this.log.error('sentinel launch failed', { reason: failure?.reason, detail: failure?.detail });
      return { taskArn: null, reason: failure?.reason ?? 'ECS did not start the task' };
    }

    this.log.info('sentinel watch launched', {
      taskArn, sourceId: input.sourceId, watchMinutes: input.watchMinutes, spot: this.config.useSpot,
    });
    return { taskArn, reason: null };
  }

  async stop(taskArn: string, reason = 'operator stopped the watch'): Promise<void> {
    await this.ecs.send(new StopTaskCommand({ cluster: this.config.clusterArn, task: taskArn, reason }));
    this.log.info('sentinel watch stopped', { taskArn, reason });
  }

  async runningCount(): Promise<number> {
    const res = await this.ecs.send(
      new ListTasksCommand({ cluster: this.config.clusterArn, desiredStatus: 'RUNNING' }),
    );
    return res.taskArns?.length ?? 0;
  }
}
