#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { envConfig, type EnvName } from '../lib/config.js';
import { NetworkStack } from '../lib/network-stack.js';
import { SecurityStack } from '../lib/security-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { MessagingStack } from '../lib/messaging-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { ComputeStack } from '../lib/compute-stack.js';
import { FrontendStack } from '../lib/frontend-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';

const app = new App();

const envName = (app.node.tryGetContext('env') ?? process.env.APEX_ENV ?? 'dev') as EnvName;
const alertEmail = app.node.tryGetContext('alertEmail') ?? process.env.APEX_ALERT_EMAIL ?? '';
const dashboardOrigin = app.node.tryGetContext('dashboardOrigin') ?? process.env.APEX_DASHBOARD_ORIGIN ?? '*';

if (!['dev', 'staging', 'prod'].includes(envName)) {
  throw new Error(`unknown environment "${envName}" — expected dev, staging or prod`);
}
if (!alertEmail) {
  throw new Error('alertEmail is required: pass -c alertEmail=you@example.com or set APEX_ALERT_EMAIL');
}

const config = envConfig(envName, alertEmail);
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
};
const prefix = `Apex-${envName}`;

// Stacks are split by lifecycle, not by convenience. Network and security
// change rarely and are risky to touch; compute changes on every deploy.
// Keeping them apart means a routine service deploy cannot accidentally
// replace a VPC or a KMS key.
const security = new SecurityStack(app, `${prefix}-Security`, { env, config });
const network = new NetworkStack(app, `${prefix}-Network`, { env, config });

const data = new DataStack(app, `${prefix}-Data`, {
  env,
  config,
  vpc: network.vpc,
  dataKey: security.dataKey,
  evidenceKey: security.evidenceKey,
  secretsKey: security.secretsKey,
});

const messaging = new MessagingStack(app, `${prefix}-Messaging`, {
  env,
  config,
  dataKey: security.dataKey,
});

const auth = new AuthStack(app, `${prefix}-Auth`, { env, config });

const compute = new ComputeStack(app, `${prefix}-Compute`, {
  env,
  config,
  vpc: network.vpc,
  database: data.database,
  databaseSecurityGroup: data.databaseSecurityGroup,
  evidenceBucket: data.evidenceBucket,
  memoryTable: data.memoryTable,
  queues: messaging.queues,
  eventBus: messaging.eventBus,
  dataKey: security.dataKey,
  evidenceKey: security.evidenceKey,
  secretsKey: security.secretsKey,
  userPoolId: auth.userPool.userPoolId,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  dashboardOrigin,
});

const frontend = new FrontendStack(app, `${prefix}-Frontend`, {
  env,
  config,
  loadBalancer: compute.loadBalancer,
});

new ObservabilityStack(app, `${prefix}-Observability`, {
  env,
  config,
  alertTopic: messaging.alertTopic,
  loadBalancer: compute.loadBalancer,
  database: data.database,
  queues: messaging.queues,
  deadLetterQueues: messaging.deadLetterQueues,
  services: compute.services,
});

// Explicit dependencies so `cdk deploy --all` orders itself correctly.
data.addDependency(network);
data.addDependency(security);
compute.addDependency(data);
compute.addDependency(messaging);
compute.addDependency(auth);
frontend.addDependency(compute);

// Tags drive cost allocation — the budget filter in ObservabilityStack keys
// off Project, so every resource must carry it.
Tags.of(app).add('Project', 'APEX-Stream');
Tags.of(app).add('Environment', envName);
Tags.of(app).add('ManagedBy', 'CDK');
Tags.of(app).add('Repository', 'patriotnewsactivism/APEX-Stream');
