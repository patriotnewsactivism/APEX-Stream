import awsLambdaFastify from '@fastify/aws-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { buildServer } from './server.js';

/**
 * Lambda entry point for the control-plane API.
 *
 * The same Fastify application that runs in a container serves a Lambda
 * Function URL here — no ALB, no always-on task, nothing billed while nobody is
 * signed in. That single substitution removes roughly $45/month of fixed cost.
 *
 * The server is built once outside the handler so a warm container reuses the
 * database executor, the JWKS cache and the route table. Cold start is roughly
 * a second; every invocation after that is normal request latency.
 */
const ready = buildServer().then((app) => awsLambdaFastify(app, { binaryMimeTypes: [] }));

export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  // Without this, a warm container waits on open handles before returning and
  // the caller pays for the idle time.
  context.callbackWaitsForEmptyEventLoop = false;
  const proxy = await ready;
  return proxy(event, context) as Promise<APIGatewayProxyResultV2>;
}
