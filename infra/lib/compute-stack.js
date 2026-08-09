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
exports.ComputeStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const appscaling = __importStar(require("aws-cdk-lib/aws-applicationautoscaling"));
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const AGENTS = ['aria', 'atlas', 'sentinel', 'archivist'];
/**
 * The running fleet.
 *
 * Every service gets its own task role. This is the difference between "the
 * agents are separate" as an architecture diagram and as an actual security
 * boundary: Aria's credentials can read Aria's queue and Aria's memory
 * partition and nothing else, so a compromised feed parser cannot reach the
 * evidence bucket, and a bug in Atlas cannot drain Sentinel's queue.
 */
class ComputeStack extends aws_cdk_lib_1.Stack {
    loadBalancer;
    repositories = {};
    services = {};
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config, vpc, database, evidenceBucket, memoryTable, queues, eventBus, dataKey, evidenceKey } = props;
        const cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: `apex-${config.envName}`,
            vpc,
            containerInsightsV2: ecs.ContainerInsights.ENHANCED,
            enableFargateCapacityProviders: true,
        });
        const serviceNames = ['orchestrator', ...AGENTS];
        for (const name of serviceNames) {
            this.repositories[name] = new ecr.Repository(this, `${cap(name)}Repo`, {
                repositoryName: `apex-${config.envName}/${name}`,
                imageScanOnPush: true,
                imageTagMutability: ecr.TagMutability.IMMUTABLE,
                encryption: ecr.RepositoryEncryption.KMS,
                encryptionKey: dataKey,
                lifecycleRules: [
                    { description: 'Keep the last 15 images', maxImageCount: 15 },
                    { description: 'Expire untagged after 7 days', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: aws_cdk_lib_1.Duration.days(7) },
                ],
            });
        }
        const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSg', {
            vpc,
            description: 'APEX Stream application tasks',
            allowAllOutbound: true, // agents fetch arbitrary external sources
        });
        props.databaseSecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(database.clusterEndpoint.port), 'application tasks to Aurora');
        const executionRole = new iam.Role(this, 'ExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
            description: 'Pulls images and writes container logs',
        });
        database.secret?.grantRead(executionRole);
        dataKey.grantDecrypt(executionRole);
        const sharedEnvironment = {
            APEX_ENV: config.envName,
            AWS_REGION: this.region,
            NODE_ENV: 'production',
            LOG_LEVEL: config.envName === 'prod' ? 'info' : 'debug',
            EVENT_BUS_NAME: eventBus.eventBusName,
            MEMORY_TABLE: memoryTable.tableName,
            EVIDENCE_BUCKET: evidenceBucket.bucketName,
            KMS_KEY_ID: dataKey.keyId,
            PORT: '8080',
        };
        // -----------------------------------------------------------------------
        // Orchestrator — the only service exposed to the internet
        // -----------------------------------------------------------------------
        const orchestratorRole = new iam.Role(this, 'OrchestratorTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: 'APEX orchestrator — dispatches work, reads state, never captures evidence',
        });
        for (const queue of Object.values(queues))
            queue.grantSendMessages(orchestratorRole);
        for (const queue of Object.values(queues)) {
            queue.grant(orchestratorRole, 'sqs:GetQueueAttributes');
        }
        eventBus.grantPutEventsTo(orchestratorRole);
        evidenceBucket.grantRead(orchestratorRole); // read for review; never write
        evidenceKey.grantDecrypt(orchestratorRole);
        database.secret?.grantRead(orchestratorRole);
        dataKey.grantEncryptDecrypt(orchestratorRole);
        const orchestratorTask = new ecs.FargateTaskDefinition(this, 'OrchestratorTask', {
            cpu: config.orchestrator.cpu,
            memoryLimitMiB: config.orchestrator.memoryMiB,
            executionRole,
            taskRole: orchestratorRole,
            runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
        });
        orchestratorTask.addContainer('orchestrator', {
            image: ecs.ContainerImage.fromEcrRepository(this.repositories.orchestrator, 'latest'),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'orchestrator',
                logRetention: config.logRetentionDays,
            }),
            environment: {
                ...sharedEnvironment,
                COGNITO_USER_POOL_ID: props.userPoolId,
                COGNITO_CLIENT_ID: props.userPoolClientId,
                DASHBOARD_ORIGIN: props.dashboardOrigin,
                QUEUE_URL_ARIA: queues.aria.queueUrl,
                QUEUE_URL_ATLAS: queues.atlas.queueUrl,
                QUEUE_URL_SENTINEL: queues.sentinel.queueUrl,
                QUEUE_URL_ARCHIVIST: queues.archivist.queueUrl,
                BEAST_MAX_BUDGET_USD: String(Math.floor(config.monthlyBudgetUsd / 10)),
                BEAST_MAX_DURATION_MINUTES: '120',
                BEAST_MAX_CONCURRENT_TASKS: '24',
            },
            secrets: {
                DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret, 'uri'),
            },
            portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
            healthCheck: {
                command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:8080/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
                interval: aws_cdk_lib_1.Duration.seconds(30),
                timeout: aws_cdk_lib_1.Duration.seconds(5),
                retries: 3,
                startPeriod: aws_cdk_lib_1.Duration.seconds(30),
            },
            stopTimeout: aws_cdk_lib_1.Duration.seconds(30),
        });
        const orchestratorService = new ecs.FargateService(this, 'OrchestratorService', {
            cluster,
            serviceName: 'orchestrator',
            taskDefinition: orchestratorTask,
            desiredCount: config.orchestrator.minCount,
            securityGroups: [taskSecurityGroup],
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            // A failed deployment rolls itself back instead of leaving the API down.
            circuitBreaker: { rollback: true },
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
            enableExecuteCommand: config.envName !== 'prod',
        });
        this.services.orchestrator = orchestratorService;
        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
            vpc,
            internetFacing: true,
            loadBalancerName: `apex-${config.envName}`,
            idleTimeout: aws_cdk_lib_1.Duration.seconds(120),
            dropInvalidHeaderFields: true,
        });
        const listener = this.loadBalancer.addListener('HttpListener', {
            port: 80,
            open: true,
            // HTTPS termination is added in DEPLOY.md once a certificate exists;
            // CloudFront in front of this enforces TLS for browser traffic.
        });
        const orchestratorTargetGroup = listener.addTargets('OrchestratorTarget', {
            port: 8080,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [orchestratorService],
            healthCheck: {
                path: '/health',
                interval: aws_cdk_lib_1.Duration.seconds(30),
                timeout: aws_cdk_lib_1.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
            },
            deregistrationDelay: aws_cdk_lib_1.Duration.seconds(20),
        });
        const apiScaling = orchestratorService.autoScaleTaskCount({
            minCapacity: config.orchestrator.minCount,
            maxCapacity: config.orchestrator.maxCount,
        });
        apiScaling.scaleOnCpuUtilization('CpuScaling', {
            targetUtilizationPercent: 65,
            scaleInCooldown: aws_cdk_lib_1.Duration.minutes(3),
            scaleOutCooldown: aws_cdk_lib_1.Duration.minutes(1),
        });
        apiScaling.scaleOnRequestCount('RequestScaling', {
            requestsPerTarget: 800,
            targetGroup: orchestratorTargetGroup,
            scaleInCooldown: aws_cdk_lib_1.Duration.minutes(3),
            scaleOutCooldown: aws_cdk_lib_1.Duration.minutes(1),
        });
        // -----------------------------------------------------------------------
        // Agents — queue-driven, scaled by backlog
        // -----------------------------------------------------------------------
        for (const agent of AGENTS) {
            const sizing = config.agents[agent];
            const queue = queues[agent];
            const taskRole = new iam.Role(this, `${cap(agent)}TaskRole`, {
                assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
                description: `APEX ${agent} — scoped to its own queue and memory partition`,
            });
            // Only this agent's queue.
            queue.grantConsumeMessages(taskRole);
            eventBus.grantPutEventsTo(taskRole);
            database.secret?.grantRead(taskRole);
            dataKey.grantEncryptDecrypt(taskRole);
            /**
             * Memory isolation enforced in IAM, not just in code. The LeadingKeys
             * condition means Aria's role is physically unable to read a row whose
             * partition key is not `mem:aria`, regardless of what the application does.
             */
            taskRole.addToPolicy(new iam.PolicyStatement({
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
                resources: [memoryTable.tableArn],
                conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`mem:${agent}`] } },
            }));
            if (agent === 'archivist') {
                // Only Archivist writes evidence — and it may not delete or shorten
                // retention on anything it has written.
                evidenceBucket.grantPut(taskRole);
                evidenceBucket.grantRead(taskRole);
                evidenceKey.grantEncryptDecrypt(taskRole);
                taskRole.addToPolicy(new iam.PolicyStatement({
                    effect: iam.Effect.DENY,
                    actions: [
                        's3:DeleteObject',
                        's3:DeleteObjectVersion',
                        's3:PutObjectRetention',
                        's3:PutObjectLegalHold',
                        's3:PutBucketObjectLockConfiguration',
                    ],
                    resources: [evidenceBucket.bucketArn, evidenceBucket.arnForObjects('*')],
                }));
            }
            if (agent === 'sentinel') {
                // Sentinel stages raw stream audio before Archivist takes custody.
                evidenceBucket.grantPut(taskRole);
                evidenceKey.grantEncryptDecrypt(taskRole);
                taskRole.addToPolicy(new iam.PolicyStatement({
                    actions: ['transcribe:StartStreamTranscription'],
                    resources: ['*'], // Transcribe streaming does not support resource ARNs
                }));
            }
            const taskDefinition = new ecs.FargateTaskDefinition(this, `${cap(agent)}Task`, {
                cpu: sizing.cpu,
                memoryLimitMiB: sizing.memoryMiB,
                executionRole,
                taskRole,
                runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
            });
            taskDefinition.addContainer(agent, {
                image: ecs.ContainerImage.fromEcrRepository(this.repositories[agent], 'latest'),
                logging: ecs.LogDrivers.awsLogs({
                    streamPrefix: agent,
                    logRetention: config.logRetentionDays,
                }),
                environment: { ...sharedEnvironment, APEX_AGENT_ID: agent, QUEUE_URL: queue.queueUrl },
                secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret, 'uri') },
                portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
                // Long enough for the runtime's 25-second drain to finish in-flight work.
                stopTimeout: aws_cdk_lib_1.Duration.seconds(60),
            });
            const service = new ecs.FargateService(this, `${cap(agent)}Service`, {
                cluster,
                serviceName: agent,
                taskDefinition,
                desiredCount: sizing.minCount,
                securityGroups: [taskSecurityGroup],
                vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
                circuitBreaker: { rollback: true },
                enableExecuteCommand: config.envName !== 'prod',
                // Collectors are interruptible: Spot cuts their cost by roughly 70%,
                // and a reclaimed task simply returns its message to the queue.
                capacityProviderStrategies: config.useFargateSpot
                    ? [{ capacityProvider: 'FARGATE_SPOT', weight: 4 }, { capacityProvider: 'FARGATE', weight: 1 }]
                    : [{ capacityProvider: 'FARGATE', weight: 1 }],
            });
            this.services[agent] = service;
            const scaling = service.autoScaleTaskCount({
                minCapacity: sizing.minCount,
                maxCapacity: sizing.maxCount,
            });
            /**
             * Scale on backlog per task rather than CPU. A collector waiting on a slow
             * remote server uses almost no CPU while its queue grows, so CPU-based
             * scaling would leave work queued and the fleet apparently healthy.
             */
            scaling.scaleOnMetric(`${cap(agent)}BacklogScaling`, {
                metric: new cloudwatch.MathExpression({
                    expression: 'IF(tasks > 0, backlog / tasks, backlog)',
                    usingMetrics: {
                        backlog: queue.metricApproximateNumberOfMessagesVisible({ period: aws_cdk_lib_1.Duration.minutes(1), statistic: 'Maximum' }),
                        tasks: new cloudwatch.Metric({
                            namespace: 'ECS/ContainerInsights',
                            metricName: 'RunningTaskCount',
                            dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: agent },
                            period: aws_cdk_lib_1.Duration.minutes(1),
                            statistic: 'Maximum',
                        }),
                    },
                    period: aws_cdk_lib_1.Duration.minutes(1),
                    label: `${agent} backlog per task`,
                }),
                scalingSteps: [
                    { upper: 0, change: sizing.minCount === 0 ? -1 : 0 },
                    { lower: 5, change: +1 },
                    { lower: 25, change: +2 },
                    { lower: 100, change: +4 },
                ],
                adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
                cooldown: aws_cdk_lib_1.Duration.minutes(2),
                evaluationPeriods: 2,
            });
        }
        new aws_cdk_lib_1.CfnOutput(this, 'ApiUrl', { value: `http://${this.loadBalancer.loadBalancerDnsName}` });
        new aws_cdk_lib_1.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
        for (const [name, repo] of Object.entries(this.repositories)) {
            new aws_cdk_lib_1.CfnOutput(this, `${cap(name)}RepoUri`, { value: repo.repositoryUri });
        }
    }
}
exports.ComputeStack = ComputeStack;
function cap(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
