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
exports.NetworkStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
/**
 * Network foundation.
 *
 * Three tiers: public (load balancer only), private-with-egress (all compute),
 * isolated (database, no route to the internet at all).
 *
 * NAT gateways are the largest fixed cost in an idle environment — roughly $32
 * per month each before data charges. Dev runs one and accepts that an AZ
 * failure interrupts outbound traffic; production runs two. Interface endpoints
 * for the AWS services the fleet talks to constantly keep that traffic off NAT
 * entirely, which is both cheaper and keeps AWS API calls on the AWS backbone
 * rather than the public internet.
 */
class NetworkStack extends aws_cdk_lib_1.Stack {
    vpc;
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config } = props;
        this.vpc = new ec2.Vpc(this, 'Vpc', {
            maxAzs: 2,
            natGateways: config.natGateways,
            ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
            subnetConfiguration: [
                { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
                { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
            ],
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });
        // Gateway endpoints are free and remove S3/DynamoDB traffic from NAT.
        this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
        this.vpc.addGatewayEndpoint('DynamoDbEndpoint', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
        // Interface endpoints cost ~$7/month each but pay for themselves quickly at
        // fleet chatter volumes, and keep control-plane calls off the internet.
        const interfaceServices = [
            ['Sqs', ec2.InterfaceVpcEndpointAwsService.SQS],
            ['Kms', ec2.InterfaceVpcEndpointAwsService.KMS],
            ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
            ['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
            ['EcrDocker', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
            ['CloudWatchLogs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
            ['EventBridge', ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE],
        ];
        for (const [name, service] of interfaceServices) {
            this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
                service,
                privateDnsEnabled: true,
                subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            });
        }
    }
}
exports.NetworkStack = NetworkStack;
