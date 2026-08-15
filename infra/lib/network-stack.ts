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
  /** Attached to every Fargate task. */
  readonly taskSecurityGroup: ec2.SecurityGroup;
  /** Attached to Aurora. Only the task security group may reach it. */
  readonly databaseSecurityGroup: ec2.SecurityGroup;
  /** Attached to the load balancer. */
  readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: StackProps & { config: ApexEnvConfig }) {
    super(scope, id, props);
    const { config } = props;

    /**
     * With no NAT gateway there is nothing a private-with-egress subnet could
     * do, so it is not created. Sentinel runs in a public subnet with a public
     * IP and a security group that allows no inbound traffic at all - egress
     * through the internet gateway is free, where NAT is $32/month plus data.
     * The database stays in isolated subnets either way and is never reachable
     * from outside the VPC.
     */
    const subnetConfiguration =
      config.natGateways === 0
        ? [
            { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
          ]
        : [
            { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
            { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
          ];

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: config.natGateways,
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      subnetConfiguration,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    /**
     * Both security groups live here rather than in the stacks that use them.
     * The rule "tasks may reach the database" needs each group to know the
     * other's id; declaring them in separate stacks would make the data stack
     * reference the compute stack, which already references it. Owning both in
     * the network stack — where network topology belongs anyway — keeps the
     * dependency graph a straight line.
     */
    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc: this.vpc,
      description: 'APEX Stream application tasks',
      // Agents fetch arbitrary external sources; that is the job. The
      // compensating controls are narrow IAM and no long-lived credentials.
      allowAllOutbound: true,
    });

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc,
      description: 'APEX Stream database - ingress only from application tasks',
      allowAllOutbound: false,
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'APEX Stream load balancer',
      allowAllOutbound: false,
    });

    this.databaseSecurityGroup.addIngressRule(
      this.taskSecurityGroup,
      ec2.Port.tcp(5432), // Aurora PostgreSQL
      'application tasks to Aurora',
    );

    // Every rule between these three groups is declared here, in one stack, so
    // registering a target later cannot make an earlier stack reference a later
    // one. CDK would otherwise add this rule implicitly when the load balancer
    // target group is created, from the compute stack.
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'public HTTP (CloudFront origin)');
    this.taskSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(8080), 'load balancer to orchestrator');
    this.albSecurityGroup.addEgressRule(this.taskSecurityGroup, ec2.Port.tcp(8080), 'load balancer to orchestrator');

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
    // Only worth paying for when compute actually sits inside the VPC.
    if (config.interfaceEndpoints) {
      for (const [name, service] of interfaceServices) {
        this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
          service,
          privateDnsEnabled: true,
          subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
      }
    }
  }
}
