import { CfnOutput, Duration, Fn, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'node:path';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

const AGENTS = ['aria', 'atlas', 'sentinel', 'archivist'] as const;
type AgentName = (typeof AGENTS)[number];
/** Everything except Sentinel fits comfortably inside a Lambda invocation. */
const LAMBDA_AGENTS = ['aria', 'atlas', 'archivist'] as const;

// The CDK app compiles to CommonJS, so __dirname is the right way to locate
// the repository root - import.meta is not available in that output format.
const repoRoot = path.resolve(__dirname, '../..');

export interface LeanComputeStackProps extends StackProps {
  config: ApexEnvConfig;
  vpc: ec2.Vpc;
  database: rds.DatabaseCluster;
  evidenceBucket: s3.Bucket;
  memoryTable: dynamodb.Table;
  queues: Record<AgentName, sqs.Queue>;
  eventBus: events.EventBus;
  dataKey: kms.Key;
  evidenceKey: kms.Key;
  userPoolId: string;
  userPoolClientId: string;
}

/**
 * The lean fleet.
 *
 * Nothing here bills while idle. The API is a Lambda Function URL, the three
 * text and web agents are Lambdas driven by their own SQS queues, and Sentinel
 * is a Fargate task definition with no service attached — it exists only to be
 * launched on demand and to stop itself when its watch window closes.
 *
 * The per-agent isolation from the container profile is preserved exactly: one
 * queue each, one memory partition each enforced by a `dynamodb:LeadingKeys`
 * condition, and only Archivist and Sentinel able to write evidence.
 */
export class LeanComputeStack extends Stack {
  readonly apiUrl: string;
  readonly functionUrlDomain: string;
  readonly sentinelRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: LeanComputeStackProps) {
    super(scope, id, props);
    const { config, vpc, database, evidenceBucket, memoryTable, queues, eventBus, dataKey, evidenceKey } = props;

    if (!database.secret) throw new Error('database secret is required for Data API access');
    const secretArn = database.secret.secretArn;

    const sharedEnvironment: Record<string, string> = {
      APEX_ENV: config.envName,
      NODE_OPTIONS: '--enable-source-maps',
      LOG_LEVEL: config.envName === 'prod' ? 'info' : 'debug',
      EVENT_BUS_NAME: eventBus.eventBusName,
      MEMORY_TABLE: memoryTable.tableName,
      EVIDENCE_BUCKET: evidenceBucket.bucketName,
      KMS_KEY_ID: dataKey.keyId,
      // Data API triple, in place of DATABASE_URL.
      DB_RESOURCE_ARN: database.clusterArn,
      DB_SECRET_ARN: secretArn,
      DB_NAME: 'apex',
    };

    const bundling = {
      // CJS rather than ESM: several dependencies still use dynamic requires
      // that esbuild cannot resolve into an ESM bundle, and a Lambda that fails
      // at import time fails on every invocation with an unhelpful message.
      format: OutputFormat.CJS,
      minify: true,
      sourceMap: true,
      target: 'node22',
      tsconfig: path.join(repoRoot, 'tsconfig.base.json'),
      // pg is only used by the container profile. Excluding it keeps the native
      // driver out of a bundle that would never load it anyway.
      externalModules: ['pg', 'pg-native'],
    };

    const grantCommon = (role: iam.IRole): void => {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['rds-data:ExecuteStatement', 'rds-data:BeginTransaction', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction'],
          resources: [database.clusterArn],
        }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [secretArn, `${secretArn}-??????`],
        }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [dataKey.keyArn],
        }),
      );
      eventBus.grantPutEventsTo(role);
    };

    // -----------------------------------------------------------------------
    // Orchestrator
    // -----------------------------------------------------------------------
    const orchestrator = new NodejsFunction(this, 'OrchestratorFn', {
      functionName: `apex-${config.envName}-orchestrator`,
      entry: path.join(repoRoot, 'services/orchestrator/src/lambda.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: config.orchestrator.memoryMiB,
      // Generous, because the first request after Aurora has paused waits for
      // the cluster to resume before it can answer.
      timeout: Duration.seconds(60),
      logRetention: config.logRetentionDays as logs.RetentionDays,
      bundling,
      environment: {
        ...sharedEnvironment,
        COGNITO_USER_POOL_ID: props.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClientId,
        DASHBOARD_ORIGIN: '*',
        QUEUE_URL_ARIA: queues.aria.queueUrl,
        QUEUE_URL_ATLAS: queues.atlas.queueUrl,
        QUEUE_URL_SENTINEL: queues.sentinel.queueUrl,
        QUEUE_URL_ARCHIVIST: queues.archivist.queueUrl,
        BEAST_MAX_BUDGET_USD: String(Math.max(1, Math.floor(config.monthlyBudgetUsd / 5))),
        BEAST_MAX_DURATION_MINUTES: '120',
        BEAST_MAX_CONCURRENT_TASKS: '24',
        PORT: '8080',
      },
    });

    grantCommon(orchestrator.role!);
    orchestrator.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
        resources: Object.values(queues).map((q) => q.queueArn),
      }),
    );
    orchestrator.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
        resources: [evidenceBucket.bucketArn, evidenceBucket.arnForObjects('*')],
      }),
    );
    orchestrator.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:DescribeKey'], resources: [evidenceKey.keyArn] }),
    );

    /**
     * Auth is enforced inside the application, so the URL itself is public.
     * Every route past `/health` requires a verified Cognito token, and
     * CloudFront sits in front of this in normal use.
     */
    const functionUrl = orchestrator.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });
    this.apiUrl = functionUrl.url;
    // The URL is a token at synth time, so the host has to be extracted with
    // CloudFormation intrinsics rather than string methods:
    // "https://<id>.lambda-url.<region>.on.aws/" -> element 2 when split on "/".
    this.functionUrlDomain = Fn.select(2, Fn.split('/', functionUrl.url));

    // -----------------------------------------------------------------------
    // Queue-driven agents
    // -----------------------------------------------------------------------
    for (const agent of LAMBDA_AGENTS) {
      const fn = new NodejsFunction(this, `${cap(agent)}Fn`, {
        functionName: `apex-${config.envName}-${agent}`,
        entry: path.join(repoRoot, `services/agent-${agent}/src/lambda.ts`),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: config.agents[agent].memoryMiB,
        // Well under the 15-minute ceiling on purpose: a sweep that cannot
        // finish in ten minutes should be split across more messages rather
        // than run closer to the edge, where a timeout loses the work silently.
        timeout: Duration.minutes(10),
        logRetention: config.logRetentionDays as logs.RetentionDays,
        bundling,
        environment: { ...sharedEnvironment, APEX_AGENT_ID: agent, QUEUE_URL: queues[agent].queueUrl },
        reservedConcurrentExecutions: config.agents[agent].maxCount,
      });

      grantCommon(fn.role!);

      fn.addEventSource(
        new SqsEventSource(queues[agent], {
          batchSize: 5,
          maxConcurrency: config.agents[agent].maxCount,
          // Without this, one failing message redelivers the whole batch and
          // the successful tasks in it are re-run - duplicate fetches, duplicate
          // spend, duplicate observations.
          reportBatchItemFailures: true,
        }),
      );

      // Memory isolation, identical to the container profile: IAM, not just code.
      fn.role!.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
          resources: [memoryTable.tableArn],
          conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`mem:${agent}`] } },
        }),
      );

      if (agent === 'archivist') {
        fn.role!.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
            resources: [evidenceBucket.bucketArn, evidenceBucket.arnForObjects('*')],
          }),
        );
        fn.role!.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
            resources: [evidenceKey.keyArn],
          }),
        );
        // Nobody shortens retention on an object that has already been written.
        fn.role!.addToPrincipalPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            actions: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectRetention', 's3:PutObjectLegalHold'],
            resources: [evidenceBucket.bucketArn, evidenceBucket.arnForObjects('*')],
          }),
        );
      }
    }

    // -----------------------------------------------------------------------
    // Sentinel — the only container, launched on demand
    // -----------------------------------------------------------------------
    this.sentinelRepository = new ecr.Repository(this, 'SentinelRepo', {
      repositoryName: `apex-${config.envName}/agent-sentinel`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ description: 'Keep the last 10 images', maxImageCount: 10 }],
    });

    const cluster = new ecs.Cluster(this, 'SentinelCluster', {
      clusterName: `apex-${config.envName}-sentinel`,
      vpc,
      enableFargateCapacityProviders: true,
    });

    const sentinelSg = new ec2.SecurityGroup(this, 'SentinelSg', {
      vpc,
      description: 'APEX Sentinel - outbound only',
      // No inbound rules at all. The task carries a public IP purely so it can
      // reach the internet through the internet gateway without a NAT gateway;
      // nothing can reach it.
      allowAllOutbound: true,
    });

    const sentinelExecutionRole = new iam.Role(this, 'SentinelExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });

    const sentinelTaskRole = new iam.Role(this, 'SentinelTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'APEX Sentinel - stream capture and transcription',
    });
    grantCommon(sentinelTaskRole);
    queues.sentinel.grantConsumeMessages(sentinelTaskRole);
    sentinelTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
        resources: [memoryTable.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['mem:sentinel'] } },
      }),
    );
    sentinelTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [evidenceBucket.arnForObjects('streams/*')] }),
    );
    sentinelTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [evidenceKey.keyArn],
      }),
    );
    sentinelTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['transcribe:StartStreamTranscription'], resources: ['*'] }),
    );

    const sentinelTask = new ecs.FargateTaskDefinition(this, 'SentinelTask', {
      cpu: config.agents.sentinel.cpu,
      memoryLimitMiB: config.agents.sentinel.memoryMiB,
      executionRole: sentinelExecutionRole,
      taskRole: sentinelTaskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });

    sentinelTask.addContainer('sentinel', {
      image: ecs.ContainerImage.fromEcrRepository(this.sentinelRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'sentinel', logRetention: config.logRetentionDays as logs.RetentionDays }),
      environment: { ...sharedEnvironment, APEX_AGENT_ID: 'sentinel', QUEUE_URL: queues.sentinel.queueUrl, PORT: '8080' },
      stopTimeout: Duration.seconds(60),
    });

    // The orchestrator launches Sentinel; it is never scheduled.
    orchestrator.addEnvironment('SENTINEL_CLUSTER_ARN', cluster.clusterArn);
    orchestrator.addEnvironment('SENTINEL_TASK_DEFINITION', sentinelTask.taskDefinitionArn);
    orchestrator.addEnvironment(
      'SENTINEL_SUBNET_IDS',
      vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds.join(','),
    );
    orchestrator.addEnvironment('SENTINEL_SECURITY_GROUP_ID', sentinelSg.securityGroupId);

    orchestrator.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:StopTask', 'ecs:ListTasks'],
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
      }),
    );
    orchestrator.role!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [sentinelTaskRole.roleArn, sentinelExecutionRole.roleArn],
      }),
    );

    // -----------------------------------------------------------------------
    // Scheduled expiry sweep
    // -----------------------------------------------------------------------
    /**
     * The container profile runs this on a timer inside a long-lived process.
     * With nothing long-lived, a schedule takes its place — this is what makes
     * "the Beast run stops itself" true when the API is asleep.
     */
    new events.Rule(this, 'RunExpirySweep', {
      ruleName: `apex-${config.envName}-run-expiry`,
      description: 'Ends Beast runs whose window has closed',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [
        new targets.LambdaFunction(orchestrator, {
          event: events.RuleTargetInput.fromObject({
            rawPath: '/internal/expire-runs',
            requestContext: { http: { method: 'POST', path: '/internal/expire-runs' } },
            headers: { 'x-apex-internal': 'schedule' },
          }),
        }),
      ],
    });

    new CfnOutput(this, 'ApiUrl', { value: this.apiUrl });
    new CfnOutput(this, 'FunctionUrlDomain', { value: this.functionUrlDomain });
    new CfnOutput(this, 'SentinelRepoUri', { value: this.sentinelRepository.repositoryUri });
    new CfnOutput(this, 'SentinelClusterArn', { value: cluster.clusterArn });
  }
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
