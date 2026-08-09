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
exports.FrontendStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
/**
 * Dashboard hosting.
 *
 * CloudFront serves the SPA from a private bucket and proxies /api to the load
 * balancer. Putting both behind one distribution means the browser talks to a
 * single origin — no CORS preflight on every call, and the API inherits
 * CloudFront's TLS and edge caching without needing its own certificate.
 */
class FrontendStack extends aws_cdk_lib_1.Stack {
    bucket;
    distribution;
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config, loadBalancer } = props;
        this.bucket = new s3.Bucket(this, 'DashboardBucket', {
            bucketName: `apex-${config.envName}-dashboard-${this.account}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            versioned: true,
            removalPolicy: config.removalProtection ? aws_cdk_lib_1.RemovalPolicy.RETAIN : aws_cdk_lib_1.RemovalPolicy.DESTROY,
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
                        `connect-src 'self' https://cognito-idp.${this.region}.amazonaws.com`,
                        "frame-ancestors 'none'",
                        "base-uri 'self'",
                        "form-action 'self'",
                    ].join('; '),
                },
                strictTransportSecurity: { override: true, accessControlMaxAge: aws_cdk_lib_1.Duration.days(730), includeSubdomains: true, preload: true },
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
                        readTimeout: aws_cdk_lib_1.Duration.seconds(60),
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
                { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: aws_cdk_lib_1.Duration.minutes(5) },
                { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: aws_cdk_lib_1.Duration.minutes(5) },
            ],
            enableLogging: config.envName === 'prod',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'DashboardUrl', { value: `https://${this.distribution.distributionDomainName}` });
        new aws_cdk_lib_1.CfnOutput(this, 'DashboardBucketName', { value: this.bucket.bucketName });
        new aws_cdk_lib_1.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    }
}
exports.FrontendStack = FrontendStack;
