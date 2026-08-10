import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

/**
 * Encryption keys.
 *
 * Three separate customer-managed keys rather than one. Separation means the
 * evidence key can carry a stricter policy than the general data key, and a
 * compromised service role cannot decrypt everything just because it could
 * decrypt something. All three rotate annually.
 *
 * The evidence key is intentionally the strictest: it never gets a deletion
 * window shorter than 30 days, and in production it cannot be deleted at all
 * without first clearing termination protection — losing that key would render
 * every archived artefact permanently unreadable.
 */
export class SecurityStack extends Stack {
  readonly dataKey: kms.Key;
  readonly evidenceKey: kms.Key;
  readonly secretsKey: kms.Key;

  constructor(scope: Construct, id: string, props: StackProps & { config: ApexEnvConfig }) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.removalProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: `apex-${config.envName}-data`,
      description: 'APEX Stream - database, queues and memory encryption',
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      removalPolicy,
      pendingWindow: Duration.days(config.removalProtection ? 30 : 7),
    });

    this.evidenceKey = new kms.Key(this, 'EvidenceKey', {
      alias: `apex-${config.envName}-evidence`,
      description: 'APEX Stream - evidence archive (write-once artefacts)',
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      removalPolicy: RemovalPolicy.RETAIN, // never destroy with the stack
      pendingWindow: Duration.days(30),
    });

    this.secretsKey = new kms.Key(this, 'SecretsKey', {
      alias: `apex-${config.envName}-secrets`,
      description: 'APEX Stream - database credentials and API tokens',
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      removalPolicy,
      pendingWindow: Duration.days(config.removalProtection ? 30 : 7),
    });
  }
}
