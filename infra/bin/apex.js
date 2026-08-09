#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const aws_cdk_lib_1 = require("aws-cdk-lib");
const config_js_1 = require("../lib/config.js");
const network_stack_js_1 = require("../lib/network-stack.js");
const security_stack_js_1 = require("../lib/security-stack.js");
const data_stack_js_1 = require("../lib/data-stack.js");
const messaging_stack_js_1 = require("../lib/messaging-stack.js");
const auth_stack_js_1 = require("../lib/auth-stack.js");
const compute_stack_js_1 = require("../lib/compute-stack.js");
const frontend_stack_js_1 = require("../lib/frontend-stack.js");
const observability_stack_js_1 = require("../lib/observability-stack.js");
const app = new aws_cdk_lib_1.App();
const envName = (app.node.tryGetContext('env') ?? process.env.APEX_ENV ?? 'dev');
const alertEmail = app.node.tryGetContext('alertEmail') ?? process.env.APEX_ALERT_EMAIL ?? '';
const dashboardOrigin = app.node.tryGetContext('dashboardOrigin') ?? process.env.APEX_DASHBOARD_ORIGIN ?? '*';
if (!['dev', 'staging', 'prod'].includes(envName)) {
    throw new Error(`unknown environment "${envName}" — expected dev, staging or prod`);
}
if (!alertEmail) {
    throw new Error('alertEmail is required: pass -c alertEmail=you@example.com or set APEX_ALERT_EMAIL');
}
const config = (0, config_js_1.envConfig)(envName, alertEmail);
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
};
const prefix = `Apex-${envName}`;
// Stacks are split by lifecycle, not by convenience. Network and security
// change rarely and are risky to touch; compute changes on every deploy.
// Keeping them apart means a routine service deploy cannot accidentally
// replace a VPC or a KMS key.
const security = new security_stack_js_1.SecurityStack(app, `${prefix}-Security`, { env, config });
const network = new network_stack_js_1.NetworkStack(app, `${prefix}-Network`, { env, config });
const data = new data_stack_js_1.DataStack(app, `${prefix}-Data`, {
    env,
    config,
    vpc: network.vpc,
    dataKey: security.dataKey,
    evidenceKey: security.evidenceKey,
    secretsKey: security.secretsKey,
});
const messaging = new messaging_stack_js_1.MessagingStack(app, `${prefix}-Messaging`, {
    env,
    config,
    dataKey: security.dataKey,
});
const auth = new auth_stack_js_1.AuthStack(app, `${prefix}-Auth`, { env, config });
const compute = new compute_stack_js_1.ComputeStack(app, `${prefix}-Compute`, {
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
    userPoolId: auth.userPool.userPoolId,
    userPoolClientId: auth.userPoolClient.userPoolClientId,
    dashboardOrigin,
});
const frontend = new frontend_stack_js_1.FrontendStack(app, `${prefix}-Frontend`, {
    env,
    config,
    loadBalancer: compute.loadBalancer,
});
new observability_stack_js_1.ObservabilityStack(app, `${prefix}-Observability`, {
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
aws_cdk_lib_1.Tags.of(app).add('Project', 'APEX-Stream');
aws_cdk_lib_1.Tags.of(app).add('Environment', envName);
aws_cdk_lib_1.Tags.of(app).add('ManagedBy', 'CDK');
aws_cdk_lib_1.Tags.of(app).add('Repository', 'patriotnewsactivism/APEX-Stream');
