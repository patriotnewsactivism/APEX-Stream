"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservabilityStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const budgets = __importStar(require("aws-cdk-lib/aws-budgets"));
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const actions = __importStar(require("aws-cdk-lib/aws-cloudwatch-actions"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const AGENTS = ['aria', 'atlas', 'sentinel', 'archivist'];
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
class ObservabilityStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config, alertTopic, loadBalancer, database, queues, deadLetterQueues, services } = props;
        const alarmAction = new actions.SnsAction(alertTopic);
        const alarm = (id, metric, threshold, description, comparison = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods = 2) => {
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
        alarm('ApiUnhealthyTargets', loadBalancer.metrics.custom('UnHealthyHostCount', { statistic: 'Maximum', period: aws_cdk_lib_1.Duration.minutes(1) }), 0, 'Orchestrator has unhealthy targets — the dashboard and API may be degraded.');
        alarm('ApiServerErrors', loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: aws_cdk_lib_1.Duration.minutes(5), statistic: 'Sum' }), 10, 'Orchestrator is returning 5xx responses.');
        alarm('ApiLatency', loadBalancer.metrics.targetResponseTime({ period: aws_cdk_lib_1.Duration.minutes(5), statistic: 'p95' }), 2, 'Orchestrator p95 latency above 2 seconds.', cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, 3);
        // --- Database ----------------------------------------------------------
        alarm('DatabaseCpu', database.metricCPUUtilization({ period: aws_cdk_lib_1.Duration.minutes(5), statistic: 'Average' }), 80, 'Aurora CPU above 80% — check for a missing index or a runaway query.', cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, 3);
        alarm('DatabaseConnections', database.metricDatabaseConnections({ period: aws_cdk_lib_1.Duration.minutes(5), statistic: 'Maximum' }), 80, 'Aurora connection count is high — pools may be leaking connections.');
        // --- Fleet -------------------------------------------------------------
        for (const agent of AGENTS) {
            // A message in a DLQ is always a bug. Threshold is zero on purpose.
            alarm(`${cap(agent)}DlqNotEmpty`, deadLetterQueues[agent].metricApproximateNumberOfMessagesVisible({ period: aws_cdk_lib_1.Duration.minutes(5), statistic: 'Maximum' }), 0, `${cap(agent)} has messages in its dead-letter queue — tasks are failing permanently.`, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, 1);
            alarm(`${cap(agent)}Backlog`, queues[agent].metricApproximateNumberOfMessagesVisible({ period: aws_cdk_lib_1.Duration.minutes(5), statistic: 'Maximum' }), 500, `${cap(agent)} backlog above 500 messages — the agent is not keeping up.`, cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD, 3);
            // Work sitting unclaimed for over an hour means nothing is consuming.
            alarm(`${cap(agent)}StaleWork`, queues[agent].metricApproximateAgeOfOldestMessage({ period: aws_cdk_lib_1.Duration.minutes(5), statistic: 'Maximum' }), 3600, `${cap(agent)} has work older than an hour — the service may be down or crash-looping.`);
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
                    subscribers: [{ subscriptionType: 'EMAIL', address: config.alertEmail }],
                })),
                // Forecast at 100% — warns before the money is actually gone.
                {
                    notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
                    subscribers: [{ subscriptionType: 'EMAIL', address: config.alertEmail }],
                },
            ],
        });
        // --- Dashboard ---------------------------------------------------------
        const dashboard = new cloudwatch.Dashboard(this, 'OpsDashboard', {
            dashboardName: `APEX-${config.envName}`,
            defaultInterval: aws_cdk_lib_1.Duration.hours(3),
        });
        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: 'API — requests and errors',
            left: [loadBalancer.metrics.requestCount({ statistic: 'Sum' })],
            right: [
                loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: 'Sum' }),
                loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_4XX_COUNT, { statistic: 'Sum' }),
            ],
            width: 12,
        }), new cloudwatch.GraphWidget({
            title: 'API — latency (p50 / p95 / p99)',
            left: [
                loadBalancer.metrics.targetResponseTime({ statistic: 'p50', label: 'p50' }),
                loadBalancer.metrics.targetResponseTime({ statistic: 'p95', label: 'p95' }),
                loadBalancer.metrics.targetResponseTime({ statistic: 'p99', label: 'p99' }),
            ],
            width: 12,
        }));
        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: 'Queue backlog by agent',
            left: AGENTS.map((a) => queues[a].metricApproximateNumberOfMessagesVisible({ label: a, statistic: 'Maximum' })),
            width: 12,
        }), new cloudwatch.GraphWidget({
            title: 'Running tasks by service',
            left: Object.keys(services).map((name) => new cloudwatch.Metric({
                namespace: 'ECS/ContainerInsights',
                metricName: 'RunningTaskCount',
                dimensionsMap: { ClusterName: `apex-${config.envName}`, ServiceName: name },
                label: name,
                statistic: 'Maximum',
            })),
            width: 12,
        }));
        dashboard.addWidgets(new cloudwatch.GraphWidget({
            title: 'Aurora — capacity and connections',
            left: [database.metricServerlessDatabaseCapacity({ label: 'ACUs', statistic: 'Average' })],
            right: [database.metricDatabaseConnections({ label: 'connections', statistic: 'Maximum' })],
            width: 12,
        }), new cloudwatch.SingleValueWidget({
            title: 'Dead-letter queue depth',
            metrics: AGENTS.map((a) => deadLetterQueues[a].metricApproximateNumberOfMessagesVisible({ label: a, statistic: 'Maximum' })),
            width: 12,
        }));
    }
}
exports.ObservabilityStack = ObservabilityStack;
function cap(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
