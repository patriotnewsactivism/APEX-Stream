import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

/**
 * Dashboard hosting.
 *
 * CloudFront serves the SPA from a private bucket and proxies /api to the load
 * balancer. Putting both behind one distribution means the browser talks to a
 * single origin — no CORS preflight on every call, and the API inherits
 * CloudFront's TLS and edge caching without needing its own certificate.
 */
export class FrontendStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      config: ApexEnvConfig;
      loadBalancer: elbv2.ApplicationLoadBalancer;
      userPoolId: string;
      userPoolClientId: string;
      hostedUiDomain: string;
    },
  ) {
    super(scope, id, props);
    const { config, loadBalancer, userPoolId, userPoolClientId, hostedUiDomain } = props;

    this.bucket = new s3.Bucket(this, 'DashboardBucket', {
      bucketName: `apex-${config.envName}-dashboard-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: config.removalProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.removalProtection,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `apex-${config.envName}-security-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'", // inline styles only, no inline scripts
            "img-src 'self' data:",
            "font-src 'self'",
            // The dashboard talks to two different Cognito surfaces: the
            // control-plane API (cognito-idp, used by nothing client-side today
            // but kept for future direct SDK calls) and the Hosted UI's own
            // domain, which auth.ts calls directly for the /oauth2/token
            // exchange -- that fetch() is blocked by CSP without this entry.
            `connect-src 'self' https://cognito-idp.${this.region}.amazonaws.com ${hostedUiDomain}`,
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
        },
        strictTransportSecurity: { override: true, accessControlMaxAge: Duration.days(730), includeSubdomains: true, preload: true },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN },
        xssProtection: { override: true, protection: true, modeBlock: true },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `APEX Stream ${config.envName} command dashboard`,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: config.envName === 'prod' ? cloudfront.PriceClass.PRICE_CLASS_ALL : cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.LoadBalancerV2Origin(loadBalancer, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            readTimeout: Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          // API responses must never be cached — but Authorization has to reach
          // the origin, which CACHING_DISABLED alone does not guarantee.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: true,
        },
      },
      // Client-side routing: unknown paths return the SPA shell, not an error.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
      enableLogging: config.envName === 'prod',
    });

    const dashboardUrl = `https://${this.distribution.distributionDomainName}`;

    // The Cognito app client's callback/logout URLs must allow this exact
    // origin, but that origin (CloudFront's generated domain name) is only
    // known after the distribution exists -- and the distribution depends on
    // Compute's load balancer, which depends on Auth's user pool. That is a
    // genuine cycle if done via a native CDK cross-stack reference, so it is
    // broken here instead with a custom resource that runs post-creation and
    // imperatively patches the already-created app client. UpdateUserPoolClient
    // replaces the whole property set it's given, so every other field the
    // client was created with is passed through unchanged -- only the
    // Callback/LogoutURLs actually gain the real dashboard origin.
    const oauthClientPatch = {
      service: 'CognitoIdentityServiceProvider',
      action: 'updateUserPoolClient',
      parameters: {
        UserPoolId: userPoolId,
        ClientId: userPoolClientId,
        ClientName: `apex-${config.envName}-dashboard`,
        CallbackURLs: ['http://localhost:5173/callback', 'https://localhost:5173/callback', `${dashboardUrl}/callback`],
        LogoutURLs: ['http://localhost:5173', dashboardUrl],
        AllowedOAuthFlows: ['code'],
        AllowedOAuthScopes: ['openid', 'email', 'profile'],
        AllowedOAuthFlowsUserPoolClient: true,
        SupportedIdentityProviders: ['COGNITO'],
        ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
        PreventUserExistenceErrors: 'ENABLED',
        EnableTokenRevocation: true,
        AccessTokenValidity: 60,
        IdTokenValidity: 60,
        RefreshTokenValidity: 43200,
        TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
      },
      physicalResourceId: PhysicalResourceId.of(`${userPoolClientId}-callback-urls`),
    };
    const oauthClientUpdater = new AwsCustomResource(this, 'OAuthClientCallbackUrls', {
      onCreate: oauthClientPatch,
      onUpdate: oauthClientPatch,
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:UpdateUserPoolClient'],
          resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${userPoolId}`],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    // Only meaningful after the distribution's domain name actually exists.
    oauthClientUpdater.node.addDependency(this.distribution);

    new CfnOutput(this, 'DashboardUrl', { value: dashboardUrl });
    new CfnOutput(this, 'DashboardBucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
