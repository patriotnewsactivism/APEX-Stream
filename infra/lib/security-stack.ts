import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface SecurityStackProps extends cdk.StackProps {
  environmentName: string;
  objectLockRetentionDays?: number;
}

export class SecurityStack extends cdk.Stack {
  public readonly evidenceKey: kms.Key;
  public readonly evidenceBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const retentionDays = props.objectLockRetentionDays ?? 90;

    // Automated KMS CMK key rotation
    this.evidenceKey = new kms.Key(this, 'EvidenceKmsKey', {
      enableKeyRotation: true,
      description: `APEX Stream Evidence Encryption Key - ${props.environmentName}`,
      alias: `alias/apex-${props.environmentName}-evidence`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S3 Object Lock bucket with compliance retention and KMS encryption
    this.evidenceBucket = new s3.Bucket(this, 'EvidenceLedgerBucket', {
      bucketName: `apex-${props.environmentName}-evidence-ledger-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.evidenceKey,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectRetention.compliance(cdk.Duration.days(retentionDays)),
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Prevent unauthorized deletion policies
    this.evidenceBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyUnencryptedObjectUploads',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.evidenceBucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: {
            's3:x-amz-server-side-encryption-aws-kms-key-id': this.evidenceKey.keyArn,
          },
        },
      })
    );
  }
}
