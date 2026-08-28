import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  environmentName: string;
  monitoredLambdas: { name: string; fn: lambda.IFunction }[];
}

export class MonitoringStack extends cdk.Stack {
  public readonly heartbeatDlq: sqs.Queue;
  public readonly heartbeatRule: events.Rule;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    this.heartbeatDlq = new sqs.Queue(this, 'AgentHeartbeatDLQ', {
      queueName: `apex-${props.environmentName}-agent-heartbeat-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // EventBridge heartbeat schedule running every 5 minutes
    this.heartbeatRule = new events.Rule(this, 'AgentHeartbeatRule', {
      ruleName: `apex-${props.environmentName}-agent-heartbeat`,
      description: 'Scheduled heartbeat trigger for surveillance Lambda agents',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });

    for (const item of props.monitoredLambdas) {
      this.heartbeatRule.addTarget(
        new targets.LambdaFunction(item.fn, {
          deadLetterQueue: this.heartbeatDlq,
          maxEventAge: cdk.Duration.hours(2),
          retryAttempts: 2,
        })
      );

      // CloudWatch Alarm for Lambda error rates
      new cloudwatch.Alarm(this, `${item.name}ErrorRateAlarm`, {
        alarmName: `apex-${props.environmentName}-${item.name}-error-alarm`,
        metric: item.fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 3,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }
  }
}
