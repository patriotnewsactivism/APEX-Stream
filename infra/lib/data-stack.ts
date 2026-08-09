import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

/**
 * Managed data services: Aurora Serverless v2, the evidence bucket, and the
 * per-agent memory table.
 */
export class DataStack extends Stack {
  readonly database: rds.DatabaseCluster;
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
      description: 'APEX Stream database — ingress only from application tasks',
      allowAllOutbound: false,
    });

    this.database = new rds.DatabaseCluster(this, 'Database', {
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
      credentials: rds.Credentials.fromGeneratedSecret('apex_admin', {
        secretName: `apex/${config.envName}/database`,
        encryptionKey: secretsKey,
      }),
      storageEncrypted: true,
      storageEncryptionKey: dataKey,
      backup: { retention: Duration.days(config.auroraBackupRetentionDays), preferredWindow: '03:00-04:00' },
      cloudwatchLogsExports: ['postgresql'],
      monitoringInterval: Duration.seconds(60),
      deletionProtection: config.removalProtection,
      removalPolicy: config.removalProtection ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
      parameters: {
        // Log anything slower than a second — enough to catch pathological
        // queries without logging every request at volume.
        log_min_duration_statement: '1000',
        'rds.force_ssl': '1',
      },
    });

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

    new CfnOutput(this, 'DatabaseEndpoint', { value: this.database.clusterEndpoint.hostname });
    new CfnOutput(this, 'DatabaseSecretArn', { value: this.database.secret?.secretArn ?? 'none' });
    new CfnOutput(this, 'EvidenceBucketName', { value: this.evidenceBucket.bucketName });
    new CfnOutput(this, 'MemoryTableName', { value: this.memoryTable.tableName });
  }
}
