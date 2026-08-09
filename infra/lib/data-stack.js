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
exports.DataStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const rds = __importStar(require("aws-cdk-lib/aws-rds"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
/**
 * Managed data services: Aurora Serverless v2, the evidence bucket, and the
 * per-agent memory table.
 */
class DataStack extends aws_cdk_lib_1.Stack {
    database;
    evidenceBucket;
    memoryTable;
    databaseSecurityGroup;
    constructor(scope, id, props) {
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
            backup: { retention: aws_cdk_lib_1.Duration.days(config.auroraBackupRetentionDays), preferredWindow: '03:00-04:00' },
            cloudwatchLogsExports: ['postgresql'],
            monitoringInterval: aws_cdk_lib_1.Duration.seconds(60),
            deletionProtection: config.removalProtection,
            removalPolicy: config.removalProtection ? aws_cdk_lib_1.RemovalPolicy.RETAIN : aws_cdk_lib_1.RemovalPolicy.SNAPSHOT,
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
            lifecycleRules: [{ expiration: aws_cdk_lib_1.Duration.days(400) }],
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
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
            objectLockDefaultRetention: s3.ObjectLockRetention.compliance(aws_cdk_lib_1.Duration.days(config.evidenceRetentionYears * 365)),
            versioned: true,
            encryption: s3.BucketEncryption.KMS,
            encryptionKey: evidenceKey,
            bucketKeyEnabled: true, // cuts KMS request cost substantially at volume
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            serverAccessLogsBucket: accessLogs,
            serverAccessLogsPrefix: 'evidence/',
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
            lifecycleRules: [
                {
                    id: 'tier-cold-evidence',
                    // Evidence is written once and read rarely. Moving it to Infrequent
                    // Access then Glacier cuts storage cost by roughly 70% without
                    // affecting retrievability for review.
                    transitions: [
                        { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: aws_cdk_lib_1.Duration.days(30) },
                        { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: aws_cdk_lib_1.Duration.days(180) },
                    ],
                    noncurrentVersionTransitions: [
                        { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: aws_cdk_lib_1.Duration.days(60) },
                    ],
                },
                { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: aws_cdk_lib_1.Duration.days(7) },
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
            removalPolicy: config.removalProtection ? aws_cdk_lib_1.RemovalPolicy.RETAIN : aws_cdk_lib_1.RemovalPolicy.DESTROY,
        });
        new aws_cdk_lib_1.CfnOutput(this, 'DatabaseEndpoint', { value: this.database.clusterEndpoint.hostname });
        new aws_cdk_lib_1.CfnOutput(this, 'DatabaseSecretArn', { value: this.database.secret?.secretArn ?? 'none' });
        new aws_cdk_lib_1.CfnOutput(this, 'EvidenceBucketName', { value: this.evidenceBucket.bucketName });
        new aws_cdk_lib_1.CfnOutput(this, 'MemoryTableName', { value: this.memoryTable.tableName });
    }
}
exports.DataStack = DataStack;
