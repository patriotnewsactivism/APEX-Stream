import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

const AGENTS = ['aria', 'atlas', 'sentinel', 'archivist'] as const;
type AgentName = (typeof AGENTS)[number];

/**
 * Queues and the event bus.
 *
 * One queue per agent, each with its own dead-letter queue. A shared queue
 * would mean a flood of Aria work starving Sentinel, and one poison message
 * stalling the whole fleet; per-agent isolation contains both.
 *
 * Visibility timeouts are set well above the expected task duration for each
 * agent — Sentinel holds a stream for minutes, Aria finishes a feed in seconds
 * — because a timeout shorter than the work guarantees duplicate processing.
 */
export class MessagingStack extends Stack {
  readonly queues: Record<AgentName, sqs.Queue>;
  readonly deadLetterQueues: Record<AgentName, sqs.Queue>;
  readonly eventBus: events.EventBus;
  readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: StackProps & { config: ApexEnvConfig; dataKey: kms.Key }) {
    super(scope, id, props);
    const { config, dataKey } = props;

    const visibility: Record<AgentName, Duration> = {
      aria: Duration.minutes(5),
      atlas: Duration.minutes(10),
      sentinel: Duration.minutes(30),
      archivist: Duration.minutes(15),
    };

    this.queues = {} as Record<AgentName, sqs.Queue>;
    this.deadLetterQueues = {} as Record<AgentName, sqs.Queue>;

    for (const agent of AGENTS) {
      const dlq = new sqs.Queue(this, `${cap(agent)}Dlq`, {
        queueName: `apex-${config.envName}-${agent}-dlq`,
        // Two weeks is the maximum, and the right choice: a DLQ message is a
        // bug report, and bugs are not always triaged the same week.
        retentionPeriod: Duration.days(14),
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: dataKey,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      const queue = new sqs.Queue(this, `${cap(agent)}Queue`, {
        queueName: `apex-${config.envName}-${agent}-tasks`,
        visibilityTimeout: visibility[agent],
        retentionPeriod: Duration.days(4),
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: dataKey,
        enforceSSL: true,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
        removalPolicy: RemovalPolicy.DESTROY,
      });

      this.queues[agent] = queue;
      this.deadLetterQueues[agent] = dlq;
      new CfnOutput(this, `${cap(agent)}QueueUrl`, { value: queue.queueUrl });
    }

    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: `apex-${config.envName}-bus`,
    });
    // An archive lets you replay events after a consumer bug, rather than
    // discovering the data is gone. Cheap; disproportionately useful.
    this.eventBus.archive('EventArchive', {
      archiveName: `apex-${config.envName}-archive`,
      description: 'Replayable record of every APEX event',
      eventPattern: { account: [this.account] },
      retention: Duration.days(config.envName === 'prod' ? 90 : 14),
    });

    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `apex-${config.envName}-alerts`,
      displayName: 'APEX Stream operator alerts',
      masterKey: dataKey,
    });
    if (config.alertEmail) {
      this.alertTopic.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));
    }

    new CfnOutput(this, 'EventBusName', { value: this.eventBus.eventBusName });
    new CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
  }
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
