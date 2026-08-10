import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

/**
 * The RDS/Aurora auto-generated credentials secret only ever contains
 * {username, password, engine, host, port, dbname, db(Cluster|Instance)Identifier}
 * -- there is no `uri` field. ComputeStack's ECS task defs need a single
 * connection-string secret (`ecs.Secret.fromSecretsManager(secret, 'uri')`),
 * so this builds a second, derived secret whose JSON is just `{"uri": "..."}`.
 * The password is pulled in via CloudFormation's own
 * `{{resolve:secretsmanager:...}}` dynamic-reference syntax (via
 * `secretValueFromJson(...).unsafeUnwrap()`) so the real plaintext password
 * is never visible in the CDK app, in `cdk synth` output, or in this
 * process at all -- only CloudFormation resolves it, once, at deploy time,
 * when this derived secret is actually created. Trade-off: this derived
 * secret goes stale if the underlying credentials ever rotate -- acceptable
 * here since nothing in this stack attaches a rotation schedule.
 * Confirmed URI-safe: this account's generated username/password contain no
 * `@ / : # ? % " \` characters (checked directly against the live secret).
 */
function buildDatabaseUriSecret(
  scope: Construct,
  id: string,
  config: ApexEnvConfig,
  rawSecret: secretsmanager.ISecret,
  hostAddress: string,
  port: number,
  dbName: string,
  encryptionKey: kms.Key,
): secretsmanager.Secret {
  const username = rawSecret.secretValueFromJson('username').unsafeUnwrap();
  const password = rawSecret.secretValueFromJson('password').unsafeUnwrap();
  const uri = `postgresql://${username}:${password}@${hostAddress}:${port}/${dbName}`;
  return new secretsmanager.Secret(scope, id, {
    secretName: `apex/${config.envName}/database-uri`,
    encryptionKey,
    secretStringValue: SecretValue.unsafePlainText(JSON.stringify({ uri })),
  });
}

/**
 * Managed data services: Aurora Serverless v2, the evidence bucket, and the
 * per-agent memory table.
 */
/**
 * Normalized handle to whichever database resource this stack actually
 * built (Aurora cluster vs a plain instance) -- `DatabaseCluster` and
 * `DatabaseInstance` don't share a common CDK interface for their endpoint
 * (`clusterEndpoint` vs `instanceEndpoint`), so downstream stacks depend on
 * this shape instead of the concrete construct type.
 */
export interface DatabaseRef {
  readonly endpoint: rds.Endpoint;
  readonly secret: import('aws-cdk-lib/aws-secretsmanager').ISecret | undefined;
  readonly metricCPUUtilization: (props?: import('aws-cdk-lib/aws-cloudwatch').MetricOptions) => import('aws-cdk-lib/aws-cloudwatch').Metric;
  readonly metricDatabaseConnections: (props?: import('aws-cdk-lib/aws-cloudwatch').MetricOptions) => import('aws-cdk-lib/aws-cloudwatch').Metric;
  /** Aurora-Serverless-only. Undefined when running on a plain RDS instance (see auroraServerless in config.ts). */
  readonly metricServerlessDatabaseCapacity?: (props?: import('aws-cdk-lib/aws-cloudwatch').MetricOptions) => import('aws-cdk-lib/aws-cloudwatch').Metric;
}

export class DataStack extends Stack {
  readonly database: DatabaseRef;
  readonly evidenceBucket: s3.Bucket;
  readonly memoryTable: dynamodb.Table;
  readonly databaseSecurityGroup: ec2.SecurityGroup;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      config: ApexEnvConfig;
      vpc: ec2.Vpc;
      dataKey: kms.Key;
      evidenceKey: kms.Key;
      secretsKey: kms.Key;
    },
  ) {
    super(scope, id, props);
    const { config, vpc, dataKey, evidenceKey, secretsKey } = props;

    // ---------------------------------------------------------------------
    // Aurora PostgreSQL Serverless v2
    // ---------------------------------------------------------------------
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'APEX Stream database - ingress only from application tasks',
      allowAllOutbound: false,
    });

    const sharedCredentials = rds.Credentials.fromGeneratedSecret('apex_admin', {
      secretName: `apex/${config.envName}/database`,
      encryptionKey: secretsKey,
    });
    const sharedParameters = {
      // Log anything slower than a second — enough to catch pathological
      // queries without logging every request at volume.
      log_min_duration_statement: '1000',
      'rds.force_ssl': '1',
    };

    if (config.auroraServerless) {
      const cluster = new rds.DatabaseCluster(this, 'Database', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_4 }),
        vpc,
        // Isolated subnets: the database has no route to the internet at all.
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [this.databaseSecurityGroup],
        // Serverless v2 bills per ACU-second, so an idle environment costs the
        // floor rather than a provisioned instance running around the clock.
        serverlessV2MinCapacity: config.auroraMinAcu,
        serverlessV2MaxCapacity: config.auroraMaxAcu,
        writer: rds.ClusterInstance.serverlessV2('Writer', { enablePerformanceInsights: true }),
        readers: config.auroraMultiAz
          ? [rds.ClusterInstance.serverlessV2('Reader', { scaleWithWriter: true, enablePerformanceInsights: true })]
          : [],
        defaultDatabaseName: 'apex',
        credentials: sharedCredentials,
        storageEncrypted: true,
        storageEncryptionKey: dataKey,
        backup: { retention: Duration.days(config.auroraBackupRetentionDays), preferredWindow: '03:00-04:00' },
        cloudwatchLogsExports: ['postgresql'],
        monitoringInterval: Duration.seconds(60),
        deletionProtection: config.removalProtection,
        removalPolicy: config.removalProtection ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
        parameters: sharedParameters,
      });
      if (!cluster.secret) throw new Error('Aurora credentials were not auto-generated');
      const uriSecret = buildDatabaseUriSecret(
        this,
        'DatabaseUriSecret',
        config,
        cluster.secret,
        cluster.clusterEndpoint.hostname,
        cluster.clusterEndpoint.port,
        'apex',
        secretsKey,
      );
      this.database = {
        endpoint: cluster.clusterEndpoint,
        secret: uriSecret,
        metricCPUUtilization: (p) => cluster.metricCPUUtilization(p),
        metricDatabaseConnections: (p) => cluster.metricDatabaseConnections(p),
        metricServerlessDatabaseCapacity: (p) => cluster.metricServerlessDatabaseCapacity(p),
      };
    } else {
      // This AWS account's Free Plan rejects standard Aurora cluster creation
      // outright (see config.ts's auroraServerless doc comment for the exact
      // error + why CDK can't use the account's only permitted Aurora path).
      // A single small standard RDS instance sidesteps that restriction
      // entirely and, at this size, is genuinely covered by the AWS Free
      // Tier (750 instance-hours/mo of db.t4g.micro + 20GB gp2 storage) --
      // $0/mo rather than just "cheap."
      const instance = new rds.DatabaseInstance(this, 'Database', {
        engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [this.databaseSecurityGroup],
        publiclyAccessible: false,
        multiAz: config.auroraMultiAz,
        allocatedStorage: 20,
        storageType: rds.StorageType.GP2,
        databaseName: 'apex',
        credentials: sharedCredentials,
        storageEncrypted: true,
        storageEncryptionKey: dataKey,
        backupRetention: Duration.days(config.auroraBackupRetentionDays),
        preferredBackupWindow: '03:00-04:00',
        cloudwatchLogsExports: ['postgresql'],
        monitoringInterval: Duration.seconds(60),
        deletionProtection: config.removalProtection,
        removalPolicy: config.removalProtection ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
        parameters: sharedParameters,
      });
      if (!instance.secret) throw new Error('RDS credentials were not auto-generated');
      const uriSecret = buildDatabaseUriSecret(
        this,
        'DatabaseUriSecret',
        config,
        instance.secret,
        instance.instanceEndpoint.hostname,
        instance.instanceEndpoint.port,
        'apex',
        secretsKey,
      );
      this.database = {
        endpoint: instance.instanceEndpoint,
        secret: uriSecret,
        metricCPUUtilization: (p) => instance.metricCPUUtilization(p),
        metricDatabaseConnections: (p) => instance.metricDatabaseConnections(p),
        // No metricServerlessDatabaseCapacity -- this is a plain instance, not Aurora Serverless.
      };
    }

    // ---------------------------------------------------------------------
    // Evidence bucket — write-once
    // ---------------------------------------------------------------------
    const accessLogs = new s3.Bucket(this, 'EvidenceAccessLogs', {
      bucketName: `apex-${config.envName}-evidence-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(400) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /**
     * Object Lock in COMPLIANCE mode is the load-bearing control for this
     * product: once written, an object cannot be deleted or overwritten before
     * its retention date by any principal, including the account root. It also
     * cannot be enabled after the fact — the bucket must be created with it —
     * which is why this is set here and never as a later change.
     */
    this.evidenceBucket = new s3.Bucket(this, 'EvidenceBucket', {
      bucketName: `apex-${config.envName}-evidence-${this.account}`,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(
        Duration.days(config.evidenceRetentionYears * 365),
      ),
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: evidenceKey,
      bucketKeyEnabled: true, // cuts KMS request cost substantially at volume
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'evidence/',
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'tier-cold-evidence',
          // Evidence is written once and read rarely. Moving it to Infrequent
          // Access then Glacier cuts storage cost by roughly 70% without
          // affecting retrievability for review.
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(180) },
          ],
          noncurrentVersionTransitions: [
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(60) },
          ],
        },
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });

    // ---------------------------------------------------------------------
    // Agent memory
    // ---------------------------------------------------------------------
    this.memoryTable = new dynamodb.Table(this, 'AgentMemory', {
      tableName: `apex-${config.envName}-agent-memory`,
      // Partition key is the agent namespace. Task roles carry a
      // dynamodb:LeadingKeys condition on it, so isolation between agents is
      // enforced by IAM rather than by application discipline alone.
      partitionKey: { name: 'namespace', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dataKey,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: config.removalProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    new CfnOutput(this, 'DatabaseEndpoint', { value: this.database.endpoint.hostname });
    new CfnOutput(this, 'DatabaseSecretArn', { value: this.database.secret?.secretArn ?? 'none' });
    new CfnOutput(this, 'EvidenceBucketName', { value: this.evidenceBucket.bucketName });
    new CfnOutput(this, 'MemoryTableName', { value: this.memoryTable.tableName });
  }
}
