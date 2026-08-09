import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

const AGENTS = ['aria', 'atlas', 'sentinel', 'archivist'] as const;
type AgentName = (typeof AGENTS)[number];

/**
 * Monitoring and spend control.
 *
 * The alarms are chosen to answer the questions that actually matter at 2am:
 * is the API up, is work piling up, is anything failing repeatedly, and is this
 * costing more than expected. A dashboard full of metrics nobody has thresholds
 * for is decoration; these all page someone.
 *
 * The budget alarm is not optional. Credits create a false sense of safety —
 * they run out quietly, and the first real invoice is the notification.
 */
export class ObservabilityStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      config: ApexEnvConfig;
      alertTopic: sns.Topic;
      loadBalancer: elbv2.ApplicationLoadBalancer;
      database: rds.DatabaseCluster;
      queues: Record<AgentName, sqs.Queue>;
      deadLetterQueues: Record<AgentName, sqs.Queue>;
      services: Record<string, ecs.FargateService>;
    },
  ) {
    super(scope, id, props);
    const { config, alertTopic, loadBalancer, database, queues, deadLetterQueues, services } = props;
    const alarmAction = new actions.SnsAction(alertTopic);

    const alarm = (
      id: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
      comparison = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods = 2,
    ): cloudwatch.Alarm => {
      const a = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: comparison,
        alarmDescription: description,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(alarmAction);
      a.addOkAction(alarmAction);
      return a;
    };

    // --- API health --------------------------------------------------------
    alarm(
      'ApiUnhealthyTargets',
      loadBalancer.metrics.custom('UnHealthyHostCount', { statistic: 'Maximum', period: Duration.minutes(1) }),
      0,
      'Orchestrator has unhealthy targets — the dashboard and API may be degraded.',
    );
    alarm(
      'ApiServerErrors',
      loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(5), statistic: 'Sum' }),
      10,
      'Orchestrator is returning 5xx responses.',
    );
    alarm(
      'ApiLatency',
      loadBalancer.metrics.targetResponseTime({ period: Duration.minutes(5), statistic: 'p95' }),
      2,
      'Orchestrator p95 latency above 2 seconds.',
      cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      3,
    );

    // --- Database ----------------------------------------------------------
    alarm(
      'DatabaseCpu',
      database.metricCPUUtilization({ period: Duration.minutes(5), statistic: 'Average' }),
      80,
      'Aurora CPU above 80% — check for a missing index or a runaway query.',
      cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      3,
    );
    alarm(
      'DatabaseConnections',
      database.metricDatabaseConnections({ period: Duration.minutes(5), statistic: 'Maximum' }),
      80,
      'Aurora connection count is high — pools may be leaking connections.',
    );

    // --- Fleet -------------------------------------------------------------
    for (const agent of AGENTS) {
      // A message in a DLQ is always a bug. Threshold is zero on purpose.
      alarm(
        `${cap(agent)}DlqNotEmpty`,
        deadLetterQueues[agent].metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
        0,
        `${cap(agent)} has messages in its dead-letter queue — tasks are failing permanently.`,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        1,
      );
      alarm(
        `${cap(agent)}Backlog`,
        queues[agent].metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
        500,
        `${cap(agent)} backlog above 500 messages — the agent is not keeping up.`,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        3,
      );
      // Work sitting unclaimed for over an hour means nothing is consuming.
      alarm(
        `${cap(agent)}StaleWork`,
        queues[agent].metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5), statistic: 'Maximum' }),
        3600,
        `${cap(agent)} has work older than an hour — the service may be down or crash-looping.`,
      );
    }

    // --- Spend -------------------------------------------------------------
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `apex-${config.envName}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: 'USD' },
        costFilters: { TagKeyValue: [`user:Project$APEX-Stream`] },
      },
      notificationsWithSubscribers: [
        // Actual spend at 50% and 80% — early enough to change course.
        ...[50, 80].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL' as const, address: config.alertEmail }],
        })),
        // Forecast at 100% — warns before the money is actually gone.
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL' as const, address: config.alertEmail }],
        },
      ],
    });

    // --- Dashboard ---------------------------------------------------------
    const dashboard = new cloudwatch.Dashboard(this, 'OpsDashboard', {
      dashboardName: `APEX-${config.envName}`,
      defaultInterval: Duration.hours(3),
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API — requests and errors',
        left: [loadBalancer.metrics.requestCount({ statistic: 'Sum' })],
        right: [
          loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: 'Sum' }),
          loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_4XX_COUNT, { statistic: 'Sum' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API — latency (p50 / p95 / p99)',
        left: [
          loadBalancer.metrics.targetResponseTime({ statistic: 'p50', label: 'p50' }),
          loadBalancer.metrics.targetResponseTime({ statistic: 'p95', label: 'p95' }),
          loadBalancer.metrics.targetResponseTime({ statistic: 'p99', label: 'p99' }),
        ],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Queue backlog by agent',
        left: AGENTS.map((a) =>
          queues[a].metricApproximateNumberOfMessagesVisible({ label: a, statistic: 'Maximum' }),
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Running tasks by service',
        left: Object.keys(services).map(
          (name) =>
            new cloudwatch.Metric({
              namespace: 'ECS/ContainerInsights',
              metricName: 'RunningTaskCount',
              dimensionsMap: { ClusterName: `apex-${config.envName}`, ServiceName: name },
              label: name,
              statistic: 'Maximum',
            }),
        ),
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Aurora — capacity and connections',
        left: [database.metricServerlessDatabaseCapacity({ label: 'ACUs', statistic: 'Average' })],
        right: [database.metricDatabaseConnections({ label: 'connections', statistic: 'Maximum' })],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Dead-letter queue depth',
        metrics: AGENTS.map((a) =>
          deadLetterQueues[a].metricApproximateNumberOfMessagesVisible({ label: a, statistic: 'Maximum' }),
        ),
        width: 12,
      }),
    );
  }
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
