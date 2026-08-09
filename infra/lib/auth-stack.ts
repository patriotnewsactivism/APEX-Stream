import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

/**
 * Identity.
 *
 * Cognito groups map one-to-one onto the roles in `@apex/core`'s RBAC module,
 * so group membership is the only place authorisation is configured. There is
 * no second users table to drift.
 *
 * MFA is required, not optional. A platform whose whole value is that its
 * evidence trail is trustworthy cannot have accounts that fall to a reused
 * password.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: StackProps & { config: ApexEnvConfig }) {
    super(scope, id, props);
    const { config } = props;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `apex-${config.envName}`,
      selfSignUpEnabled: false, // operators are invited, never self-registered
      signInAliases: { email: true, username: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,
      removalPolicy: config.removalProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      deletionProtection: config.removalProtection,
    });

    // Groups mirror ROLE_DEFINITIONS. Precedence decides which role wins in the
    // token when a user is in several; lower number is higher priority.
    const groups: Array<{ name: string; description: string; precedence: number }> = [
      { name: 'owner', description: 'Full control including billing and infrastructure', precedence: 0 },
      { name: 'admin', description: 'Manages users, sources, workflows and the fleet', precedence: 10 },
      { name: 'operator', description: 'Runs the fleet; may trigger Beast mode', precedence: 20 },
      { name: 'analyst', description: 'Reviews findings and builds workflows', precedence: 30 },
      { name: 'viewer', description: 'Read-only access to dashboards and findings', precedence: 40 },
    ];
    for (const group of groups) {
      new cognito.CfnUserPoolGroup(this, `Group${group.name}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: group.name,
        description: group.description,
        precedence: group.precedence,
      });
    }

    this.userPoolClient = this.userPool.addClient('DashboardClient', {
      userPoolClientName: `apex-${config.envName}-dashboard`,
      // No client secret: this is a browser SPA and a secret there is not secret.
      generateSecret: false,
      authFlows: { userSrp: true, custom: false, userPassword: false, adminUserPassword: false },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ['http://localhost:5173/callback', 'https://localhost:5173/callback'],
        logoutUrls: ['http://localhost:5173'],
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });

    this.userPoolDomain = this.userPool.addDomain('HostedDomain', {
      cognitoDomain: { domainPrefix: `apex-${config.envName}-${this.account.slice(-6)}` },
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiUrl', { value: this.userPoolDomain.baseUrl() });
  }
}
