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
exports.MessagingStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const events = __importStar(require("aws-cdk-lib/aws-events"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
const subscriptions = __importStar(require("aws-cdk-lib/aws-sns-subscriptions"));
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
const AGENTS = ['aria', 'atlas', 'sentinel', 'archivist'];
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
class MessagingStack extends aws_cdk_lib_1.Stack {
    queues;
    deadLetterQueues;
    eventBus;
    alertTopic;
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config, dataKey } = props;
        const visibility = {
            aria: aws_cdk_lib_1.Duration.minutes(5),
            atlas: aws_cdk_lib_1.Duration.minutes(10),
            sentinel: aws_cdk_lib_1.Duration.minutes(30),
            archivist: aws_cdk_lib_1.Duration.minutes(15),
        };
        this.queues = {};
        this.deadLetterQueues = {};
        for (const agent of AGENTS) {
            const dlq = new sqs.Queue(this, `${cap(agent)}Dlq`, {
                queueName: `apex-${config.envName}-${agent}-dlq`,
                // Two weeks is the maximum, and the right choice: a DLQ message is a
                // bug report, and bugs are not always triaged the same week.
                retentionPeriod: aws_cdk_lib_1.Duration.days(14),
                encryption: sqs.QueueEncryption.KMS,
                encryptionMasterKey: dataKey,
                enforceSSL: true,
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            });
            const queue = new sqs.Queue(this, `${cap(agent)}Queue`, {
                queueName: `apex-${config.envName}-${agent}-tasks`,
                visibilityTimeout: visibility[agent],
                retentionPeriod: aws_cdk_lib_1.Duration.days(4),
                encryption: sqs.QueueEncryption.KMS,
                encryptionMasterKey: dataKey,
                enforceSSL: true,
                deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            });
            this.queues[agent] = queue;
            this.deadLetterQueues[agent] = dlq;
            new aws_cdk_lib_1.CfnOutput(this, `${cap(agent)}QueueUrl`, { value: queue.queueUrl });
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
            retention: aws_cdk_lib_1.Duration.days(config.envName === 'prod' ? 90 : 14),
        });
        this.alertTopic = new sns.Topic(this, 'AlertTopic', {
            topicName: `apex-${config.envName}-alerts`,
            displayName: 'APEX Stream operator alerts',
            masterKey: dataKey,
        });
        if (config.alertEmail) {
            this.alertTopic.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));
        }
        new aws_cdk_lib_1.CfnOutput(this, 'EventBusName', { value: this.eventBus.eventBusName });
        new aws_cdk_lib_1.CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
    }
}
exports.MessagingStack = MessagingStack;
function cap(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
