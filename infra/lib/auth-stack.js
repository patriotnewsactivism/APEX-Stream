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
exports.AuthStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
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
class AuthStack extends aws_cdk_lib_1.Stack {
    userPool;
    userPoolClient;
    userPoolDomain;
    constructor(scope, id, props) {
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
                tempPasswordValidity: aws_cdk_lib_1.Duration.days(3),
            },
            mfa: cognito.Mfa.REQUIRED,
            mfaSecondFactor: { sms: false, otp: true },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,
            removalPolicy: config.removalProtection ? aws_cdk_lib_1.RemovalPolicy.RETAIN : aws_cdk_lib_1.RemovalPolicy.DESTROY,
            deletionProtection: config.removalProtection,
        });
        // Groups mirror ROLE_DEFINITIONS. Precedence decides which role wins in the
        // token when a user is in several; lower number is higher priority.
        const groups = [
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
            accessTokenValidity: aws_cdk_lib_1.Duration.hours(1),
            idTokenValidity: aws_cdk_lib_1.Duration.hours(1),
            refreshTokenValidity: aws_cdk_lib_1.Duration.days(30),
            enableTokenRevocation: true,
        });
        this.userPoolDomain = this.userPool.addDomain('HostedDomain', {
            cognitoDomain: { domainPrefix: `apex-${config.envName}-${this.account.slice(-6)}` },
        });
        new aws_cdk_lib_1.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
        new aws_cdk_lib_1.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
        new aws_cdk_lib_1.CfnOutput(this, 'HostedUiUrl', { value: this.userPoolDomain.baseUrl() });
    }
}
exports.AuthStack = AuthStack;
