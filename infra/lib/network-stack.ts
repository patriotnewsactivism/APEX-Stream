import { Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { ApexEnvConfig } from './config.js';

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
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: StackProps & { config: ApexEnvConfig }) {
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
    const interfaceServices: Array<[string, ec2.InterfaceVpcEndpointAwsService]> = [
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
