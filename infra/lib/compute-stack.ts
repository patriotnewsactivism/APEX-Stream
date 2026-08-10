import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as events from 'aws-cdk-lib/aws-events';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { DatabaseRef } from './data-stack.js';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

/**
 * Grants read on the Aurora credentials secret without letting CDK route the
 * KMS portion of the grant through the key's resource policy.
 *
 * `secret.grantRead()` looks safe (the key's `trustAccountIdentities` default
 * is true, which normally keeps grants identity-only), but when the secret's
 * `encryptionKey` lives in a *third* stack (Security) -- neither the secret's
 * own stack (Data) nor the grantee's stack (Compute) -- CDK's Secret.grantRead
 * routes the KMS grant through the key's resource policy instead, which means
 * Security's template needs to import the grantee role's ARN. Security
 * already sits upstream of Compute (Compute depends on Data depends on
 * Security), so that reverse edge is a hard synthesis-time cycle -- confirmed
 * by literally hitting it running `cdk bootstrap` against this app.
 * Granting both permissions directly onto the role's own identity policy
 * sidesteps the key/secret resource policies entirely, so no stack needs
 * anything back from Compute.
 */
function grantSecretReadWithoutCycle(secret: import('aws-cdk-lib/aws-secretsmanager').ISecret | undefined, secretsKeyArn: string, grantee: iam.IRole): void {
  if (!secret) return;
  grantee.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [secret.secretArn],
    }),
  );
  grantee.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [secretsKeyArn] }),
  );
}

/**
 * ECS's `addContainer()`/`addSecret()` automatically calls `secret.grantRead(executionRole)`
 * internally whenever a container has `secrets: {...}` -- there is no way to opt out of that
 * from the outside. If the secret's `encryptionKey` is set, that automatic call reintroduces
 * the exact same Security<->Compute cycle `grantSecretReadWithoutCycle` above works around,
 * because it goes through the same internal KMS grant path.
 *
 * The fix: hand ECS a plain ARN-only reference to the *same* real secret, with no
 * `encryptionKey` attached, so the automatic grant only adds `secretsmanager:GetSecretValue`
 * / `DescribeSecret` (harmless, duplicates what we already granted) and skips its KMS branch
 * entirely. The actual `kms:Decrypt` permission the container needs at runtime is already
 * covered by the explicit `grantSecretReadWithoutCycle` call made once per role above.
 */
function asPlainSecretRef(scope: Construct, id: string, secret: secretsmanager.ISecret | undefined): secretsmanager.ISecret {
  if (!secret) throw new Error('database.secret is undefined -- Aurora credentials were not auto-generated');
  return secretsmanager.Secret.fromSecretCompleteArn(scope, id, secret.secretArn);
}

const AGENTS = ['aria', 'atlas', 'sentinel', 'archivist'] as const;
type AgentName = (typeof AGENTS)[number];

export interface ComputeStackProps extends StackProps {
  config: ApexEnvConfig;
  vpc: ec2.Vpc;
  database: DatabaseRef;
  databaseSecurityGroup: ec2.SecurityGroup;
  evidenceBucket: s3.Bucket;
  memoryTable: dynamodb.Table;
  queues: Record<AgentName, sqs.Queue>;
  eventBus: events.EventBus;
  dataKey: kms.Key;
  evidenceKey: kms.Key;
  secretsKey: kms.Key;
  userPoolId: string;
  userPoolClientId: string;
  dashboardOrigin: string;
}

/**
 * The running fleet.
 *
 * Every service gets its own task role. This is the difference between "the
 * agents are separate" as an architecture diagram and as an actual security
 * boundary: Aria's credentials can read Aria's queue and Aria's memory
 * partition and nothing else, so a compromised feed parser cannot reach the
 * evidence bucket, and a bug in Atlas cannot drain Sentinel's queue.
 */
export class ComputeStack extends Stack {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly repositories: Record<string, ecr.IRepository> = {};
  readonly services: Record<string, ecs.FargateService> = {};

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const { config, vpc, database, evidenceBucket, memoryTable, queues, eventBus, dataKey, evidenceKey, secretsKey } = props;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `apex-${config.envName}`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
      enableFargateCapacityProviders: true,
    });

    const serviceNames = ['orchestrator', ...AGENTS];
    for (const name of serviceNames) {
      // These repos are IMPORTED, not created, on purpose. The CI pipeline's
      // "Build and push image" jobs push into `apex-${envName}/${name}` BEFORE
      // this stack ever deploys (they have to exist for `docker push` to have
      // somewhere to land), and ecr.Repository's default removalPolicy is
      // RETAIN -- so any earlier Compute stack attempt (this one included,
      // across retries) leaves these repos behind even after a full stack
      // delete/rollback. A `new ecr.Repository(...)` here collides with that
      // survivor on every single retry ("already exists"). Importing instead
      // means this stack never tries to own their lifecycle, so retries are
      // actually idempotent. Encryption/lifecycle rules/tag-mutability
      // (IMMUTABLE_WITH_EXCLUSION on the `latest` tag, so the floating
      // deploy tag stays overwritable while every per-commit tag is
      // immutable) are already live on these repos via direct
      // `aws ecr put-image-tag-mutability` / console config -- see git log
      // for the one-time setup commands.
      this.repositories[name] = ecr.Repository.fromRepositoryName(
        this,
        `${cap(name)}Repo`,
        `apex-${config.envName}/${name}`,
      );
    }

    const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'APEX Stream application tasks',
      allowAllOutbound: true, // agents fetch arbitrary external sources
    });
    // `databaseSecurityGroup.addIngressRule(taskSecurityGroup, ...)` would add the new
    // CfnSecurityGroupIngress resource to the SECURITY GROUP'S OWN stack (Data, since that's
    // where `databaseSecurityGroup` was constructed), referencing Compute's taskSecurityGroup
    // as the peer -- Data would then need Compute's group ID, contradicting the existing
    // Compute -> Data dependency (Compute already needs the database endpoint) and creating
    // a synthesis-time cycle. Confirmed by literally hitting it running `cdk bootstrap`.
    // Building the ingress rule as its own resource here in Compute instead only needs a
    // value Compute already legitimately has either way (Data's security group ID, via the
    // dependency that already exists), so the reference only ever flows one way.
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngressFromTasks', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      sourceSecurityGroupId: taskSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: database.endpoint.port,
      toPort: database.endpoint.port,
      description: 'application tasks to Aurora',
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
      description: 'Pulls images and writes container logs',
    });
    grantSecretReadWithoutCycle(database.secret, secretsKey.keyArn, executionRole);
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
      description: 'APEX orchestrator - dispatches work, reads state, never captures evidence',
    });
    for (const queue of Object.values(queues)) queue.grantSendMessages(orchestratorRole);
    for (const queue of Object.values(queues)) {
      queue.grant(orchestratorRole, 'sqs:GetQueueAttributes');
    }
    eventBus.grantPutEventsTo(orchestratorRole);
    evidenceBucket.grantRead(orchestratorRole); // read for review; never write
    evidenceKey.grantDecrypt(orchestratorRole);
    grantSecretReadWithoutCycle(database.secret, secretsKey.keyArn, orchestratorRole);
    dataKey.grantEncryptDecrypt(orchestratorRole);

    const orchestratorTask = new ecs.FargateTaskDefinition(this, 'OrchestratorTask', {
      cpu: config.orchestrator.cpu,
      memoryLimitMiB: config.orchestrator.memoryMiB,
      executionRole,
      taskRole: orchestratorRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });

    orchestratorTask.addContainer('orchestrator', {
      image: ecs.ContainerImage.fromEcrRepository(this.repositories.orchestrator!, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'orchestrator',
        logRetention: config.logRetentionDays as logs.RetentionDays,
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
        DATABASE_URL: ecs.Secret.fromSecretsManager(asPlainSecretRef(this, 'OrchestratorDbSecretRef', database.secret), 'uri'),
      },
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:8080/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
      stopTimeout: Duration.seconds(30),
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
      idleTimeout: Duration.seconds(120),
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
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(20),
    });

    const apiScaling = orchestratorService.autoScaleTaskCount({
      minCapacity: config.orchestrator.minCount,
      maxCapacity: config.orchestrator.maxCount,
    });
    apiScaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 65,
      scaleInCooldown: Duration.minutes(3),
      scaleOutCooldown: Duration.minutes(1),
    });
    apiScaling.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 800,
      targetGroup: orchestratorTargetGroup,
      scaleInCooldown: Duration.minutes(3),
      scaleOutCooldown: Duration.minutes(1),
    });

    // -----------------------------------------------------------------------
    // Agents — queue-driven, scaled by backlog
    // -----------------------------------------------------------------------
    for (const agent of AGENTS) {
      const sizing = config.agents[agent];
      const queue = queues[agent];

      const taskRole = new iam.Role(this, `${cap(agent)}TaskRole`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description: `APEX ${agent} - scoped to its own queue and memory partition`,
      });

      // Bedrock as a last-resort LLM fallback, IAM-only (no API key to manage or leak,
      // since these tasks already run under an IAM role). No agent calls out to an LLM
      // yet as of this commit -- this only makes the permission available ahead of that
      // code landing. Scoped to Bedrock's foundation-model resource type in this account
      // and region rather than a bare '*' on all actions.
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:${Stack.of(this).region}::foundation-model/*`,
            `arn:aws:bedrock:${Stack.of(this).region}:${Stack.of(this).account}:inference-profile/*`,
          ],
        }),
      );

      // Only this agent's queue.
      queue.grantConsumeMessages(taskRole);
      eventBus.grantPutEventsTo(taskRole);
      grantSecretReadWithoutCycle(database.secret, secretsKey.keyArn, taskRole);
      dataKey.grantEncryptDecrypt(taskRole);

      /**
       * Memory isolation enforced in IAM, not just in code. The LeadingKeys
       * condition means Aria's role is physically unable to read a row whose
       * partition key is not `mem:aria`, regardless of what the application does.
       */
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
          resources: [memoryTable.tableArn],
          conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`mem:${agent}`] } },
        }),
      );

      if (agent === 'archivist') {
        // Only Archivist writes evidence — and it may not delete or shorten
        // retention on anything it has written.
        evidenceBucket.grantPut(taskRole);
        evidenceBucket.grantRead(taskRole);
        evidenceKey.grantEncryptDecrypt(taskRole);
        taskRole.addToPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            actions: [
              's3:DeleteObject',
              's3:DeleteObjectVersion',
              's3:PutObjectRetention',
              's3:PutObjectLegalHold',
              's3:PutBucketObjectLockConfiguration',
            ],
            resources: [evidenceBucket.bucketArn, evidenceBucket.arnForObjects('*')],
          }),
        );
      }
      if (agent === 'sentinel') {
        // Sentinel stages raw stream audio before Archivist takes custody.
        evidenceBucket.grantPut(taskRole);
        evidenceKey.grantEncryptDecrypt(taskRole);
        taskRole.addToPolicy(
          new iam.PolicyStatement({
            actions: ['transcribe:StartStreamTranscription'],
            resources: ['*'], // Transcribe streaming does not support resource ARNs
          }),
        );
      }

      const taskDefinition = new ecs.FargateTaskDefinition(this, `${cap(agent)}Task`, {
        cpu: sizing.cpu,
        memoryLimitMiB: sizing.memoryMiB,
        executionRole,
        taskRole,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      });

      taskDefinition.addContainer(agent, {
        image: ecs.ContainerImage.fromEcrRepository(this.repositories[agent]!, 'latest'),
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: agent,
          logRetention: config.logRetentionDays as logs.RetentionDays,
        }),
        environment: { ...sharedEnvironment, APEX_AGENT_ID: agent, QUEUE_URL: queue.queueUrl },
        secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(asPlainSecretRef(this, `${cap(agent)}DbSecretRef`, database.secret), 'uri') },
        portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
        // Long enough for the runtime's 25-second drain to finish in-flight work.
        stopTimeout: Duration.seconds(60),
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
            backlog: queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }),
            tasks: new cloudwatch.Metric({
              namespace: 'ECS/ContainerInsights',
              metricName: 'RunningTaskCount',
              dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: agent },
              period: Duration.minutes(1),
              statistic: 'Maximum',
            }),
          },
          period: Duration.minutes(1),
          label: `${agent} backlog per task`,
        }),
        scalingSteps: [
          { upper: 0, change: sizing.minCount === 0 ? -1 : 0 },
          { lower: 5, change: +1 },
          { lower: 25, change: +2 },
          { lower: 100, change: +4 },
        ],
        adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: Duration.minutes(2),
        evaluationPeriods: 2,
      });
    }

    new CfnOutput(this, 'ApiUrl', { value: `http://${this.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    for (const [name, repo] of Object.entries(this.repositories)) {
      new CfnOutput(this, `${cap(name)}RepoUri`, { value: repo.repositoryUri });
    }
  }
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
