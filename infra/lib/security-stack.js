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
exports.SecurityStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const kms = __importStar(require("aws-cdk-lib/aws-kms"));
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
class SecurityStack extends aws_cdk_lib_1.Stack {
    dataKey;
    evidenceKey;
    secretsKey;
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config } = props;
        const removalPolicy = config.removalProtection ? aws_cdk_lib_1.RemovalPolicy.RETAIN : aws_cdk_lib_1.RemovalPolicy.DESTROY;
        this.dataKey = new kms.Key(this, 'DataKey', {
            alias: `apex-${config.envName}-data`,
            description: 'APEX Stream — database, queues and memory encryption',
            enableKeyRotation: true,
            rotationPeriod: aws_cdk_lib_1.Duration.days(365),
            removalPolicy,
            pendingWindow: aws_cdk_lib_1.Duration.days(config.removalProtection ? 30 : 7),
        });
        this.evidenceKey = new kms.Key(this, 'EvidenceKey', {
            alias: `apex-${config.envName}-evidence`,
            description: 'APEX Stream — evidence archive (write-once artefacts)',
            enableKeyRotation: true,
            rotationPeriod: aws_cdk_lib_1.Duration.days(365),
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN, // never destroy with the stack
            pendingWindow: aws_cdk_lib_1.Duration.days(30),
        });
        this.secretsKey = new kms.Key(this, 'SecretsKey', {
            alias: `apex-${config.envName}-secrets`,
            description: 'APEX Stream — database credentials and API tokens',
            enableKeyRotation: true,
            rotationPeriod: aws_cdk_lib_1.Duration.days(365),
            removalPolicy,
            pendingWindow: aws_cdk_lib_1.Duration.days(config.removalProtection ? 30 : 7),
        });
    }
}
exports.SecurityStack = SecurityStack;
